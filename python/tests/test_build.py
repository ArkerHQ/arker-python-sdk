"""The build driver: walking parsed instructions against a VM.

These tests use a fake VM that records calls, so they cover the part that is
actually ours — ordering, shell state, and how COPY resolves against the build
context — without needing a real VM.
"""

from __future__ import annotations

import os
from types import SimpleNamespace

import pytest

from arker.build_spec import parse_dockerfile
from arker.build import BuildError, apply_steps


class FakeVM:
    """Records what the driver asks a VM to do."""

    def __init__(self, exit_codes=None):
        self.calls: list[tuple] = []
        # Per-command exit codes, keyed by a substring of the command.
        self.exit_codes = exit_codes or {}

    def run(self, command, **kwargs):
        self.calls.append(("run", command))
        code = 0
        for needle, value in self.exit_codes.items():
            if needle in command:
                code = value
        return SimpleNamespace(exit_code=code, stdout="", stderr="")

    def sync(self, path, data=None):
        self.calls.append(("sync", path, len(data) if data else None))
        return None

    def sync_dir(self, local_dir, remote_dir, **kwargs):
        self.calls.append(("sync_dir", os.path.basename(local_dir.rstrip("/")), remote_dir))
        return None

    @property
    def commands(self) -> list[str]:
        return [c[1] for c in self.calls if c[0] == "run"]


@pytest.fixture
def context(tmp_path):
    (tmp_path / "app.js").write_text("console.log(1)\n")
    (tmp_path / "package.json").write_text("{}\n")
    src = tmp_path / "src"
    src.mkdir()
    (src / "index.js").write_text("//\n")
    return tmp_path


def build(text, context_root):
    vm = FakeVM()
    apply_steps(vm, parse_dockerfile(text).steps, str(context_root))
    return vm


def test_run_executes_in_order(context):
    vm = build("FROM x\nRUN one\nRUN two\n", context)
    assert vm.commands == ["one", "two"]


def test_workdir_is_created_then_entered(context):
    """Docker creates a WORKDIR that doesn't exist; a bare `cd` would fail."""
    vm = build("FROM x\nWORKDIR /app\nRUN pwd\n", context)
    assert vm.commands[0] == "mkdir -p /app && cd /app"
    assert vm.commands[1] == "pwd"


def test_env_is_exported_before_later_runs(context):
    vm = build("FROM x\nENV A=1 B=2\nRUN echo $A\n", context)
    assert vm.commands[0] == "export A=1 B=2"
    assert vm.commands[1] == "echo $A"


def test_env_values_are_quoted(context):
    """An unquoted value with a space would export only the first word."""
    vm = build('FROM x\nENV GREETING="hello world"\n', context)
    assert vm.commands == ["export GREETING='hello world'"]


def test_arg_with_a_default_behaves_like_env(context):
    vm = build("FROM x\nARG VERSION=1.2\nRUN echo $VERSION\n", context)
    assert vm.commands[0] == "export VERSION=1.2"


def test_arg_without_a_default_is_inert(context):
    """Matches Docker: an ARG with no default and no --build-arg is unset."""
    vm = build("FROM x\nARG NOVAL\nRUN echo hi\n", context)
    assert vm.commands == ["echo hi"]


def test_user_wraps_subsequent_runs(context):
    vm = build("FROM x\nUSER app\nRUN whoami\n", context)
    assert vm.commands == ["su -p app -c whoami"]


def test_user_does_not_wrap_earlier_runs(context):
    vm = build("FROM x\nRUN first\nUSER app\nRUN second\n", context)
    assert vm.commands[0] == "first"
    assert vm.commands[1].startswith("su -p app")


def test_copy_a_single_file_writes_it(context):
    vm = build("FROM x\nCOPY app.js /srv/app.js\n", context)
    assert ("sync", "/srv/app.js", len("console.log(1)\n")) in vm.calls


def test_copy_a_directory_syncs_its_contents(context):
    """Docker copies a directory's CONTENTS into the destination."""
    vm = build("FROM x\nCOPY src /app/src\n", context)
    assert ("sync_dir", "src", "/app/src") in vm.calls


def test_copy_the_whole_context(context):
    vm = build("FROM x\nCOPY . /app\n", context)
    assert ("sync_dir", os.path.basename(str(context)), "/app") in vm.calls


def test_copy_expands_a_glob(context):
    vm = build("FROM x\nCOPY package*.json /app/\n", context)
    synced = [c for c in vm.calls if c[0] == "sync"]
    assert any(c[1] == "/app/package.json" for c in synced), vm.calls


def test_copy_refuses_a_source_outside_the_context(context):
    """The context root is the boundary, exactly as `docker build` treats it."""
    with pytest.raises(BuildError, match="outside the build context"):
        build("FROM x\nCOPY ../secrets /app\n", context)


def test_copy_refuses_a_source_that_does_not_exist(context):
    with pytest.raises(BuildError, match="no such file"):
        build("FROM x\nCOPY nope.txt /app\n", context)


def test_copy_applies_chown_after_the_sync(context):
    vm = build("FROM x\nCOPY --chown=app:app src /app/src\n", context)
    assert vm.commands[-1] == "chown -R app:app /app/src"


def test_copy_runs_as_root_even_after_user(context):
    """Docker's COPY writes as root regardless of USER unless --chown says
    otherwise, so the sync must not be wrapped in the USER shell."""
    vm = build("FROM x\nUSER app\nCOPY app.js /srv/app.js\n", context)
    assert any(c[0] == "sync" for c in vm.calls)
    assert not any("su -p" in c for c in vm.commands)


def test_add_url_becomes_a_guest_side_fetch(context):
    vm = build("FROM x\nADD https://example.com/f /f\n", context)
    assert "curl" in vm.commands[0] and "-o /f" in vm.commands[0]


def test_inert_instructions_produce_no_calls(context):
    vm = build("FROM x\nLABEL a=b\nEXPOSE 8080\nCMD [\"true\"]\n", context)
    assert vm.calls == []


def test_a_failing_run_aborts_the_build(context):
    """Docker fails a build on a non-zero RUN, and so must this.

    Without it a Dockerfile whose `RUN npm install` fails hands back a VM that
    looks built and is not, with every later instruction applied on top of the
    failure.
    """
    vm = FakeVM(exit_codes={"boom": 17})
    steps = parse_dockerfile("FROM x\nRUN ok-one\nRUN boom\nRUN never\n").steps
    with pytest.raises(BuildError, match="17"):
        apply_steps(vm, steps, str(context))
    assert vm.commands == ["ok-one", "boom"], "the step after the failure must not run"


def test_a_failing_copy_chown_aborts_the_build(context):
    """The chown after a COPY is a real command and can fail like any other."""
    vm = FakeVM(exit_codes={"chown": 1})
    steps = parse_dockerfile("FROM x\nCOPY --chown=nope:nope app.js /a.js\n").steps
    with pytest.raises(BuildError):
        apply_steps(vm, steps, str(context))
