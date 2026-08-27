"""Unit tests for arker.migrate — the config-driven command-migration engine.

Where possible these exercise the real machinery (real files on disk, a real
spawned process introspected through real ``/proc``) rather than mocking it,
since ``/proc`` parsing and glob/mtime session discovery *is* the mechanism
under test — mocking those away would just test the mock.
"""
from __future__ import annotations

import os
import subprocess
import threading
import time
from pathlib import Path

import pytest

from arker import migrate


# ---------------------------------------------------------------------------
# _detect
# ---------------------------------------------------------------------------


def test_detect_argv_contains():
    assert migrate._detect("node /usr/local/bin/claude --resume abc", {"argv_contains": "claude"})
    assert not migrate._detect("node /usr/local/bin/codex", {"argv_contains": "claude"})


def test_detect_argv_regex():
    spec = {"argv_regex": r"(^|/|\s)pi(\s|$)"}
    assert migrate._detect("/usr/bin/pi --provider anthropic", spec)
    assert not migrate._detect("/usr/bin/pip install foo", spec)
    assert not migrate._detect("/usr/bin/piano", spec)


def test_detect_no_recognized_key_returns_false():
    assert not migrate._detect("literally anything", {})


# ---------------------------------------------------------------------------
# _cwd_key
# ---------------------------------------------------------------------------


def test_cwd_key_matches_claude_codes_own_directory_convention():
    # This is the exact ~/.claude/projects/<key> naming Claude Code itself
    # uses (verified live against a real installed Claude Code project).
    assert migrate._cwd_key("/home/user/my-project") == "-home-user-my-project"
    assert migrate._cwd_key("/a/b.c_d") == "-a-b-c-d"


# ---------------------------------------------------------------------------
# _subst
# ---------------------------------------------------------------------------


def test_subst_replaces_placeholders_and_expands_home(monkeypatch, tmp_path):
    monkeypatch.setenv("HOME", str(tmp_path))
    out = migrate._subst("~/foo/${a}/${b}.txt", {"a": "1", "b": "2"})
    assert out == str(tmp_path / "foo" / "1" / "2.txt")


def test_subst_leaves_unmatched_placeholders_untouched():
    out = migrate._subst("${known}-${unknown}", {"known": "x"})
    assert out == "x-${unknown}"


# ---------------------------------------------------------------------------
# _find_session
# ---------------------------------------------------------------------------


def _touch(path: Path, mtime: float) -> None:
    path.write_text("{}")
    os.utime(path, (mtime, mtime))


def test_find_session_picks_newest_by_default(tmp_path):
    a, b = tmp_path / "a.jsonl", tmp_path / "b.jsonl"
    _touch(a, time.time() - 100)
    _touch(b, time.time() - 10)
    path, sid = migrate._find_session({"glob": str(tmp_path / "*.jsonl")}, {})
    assert path == str(b)
    assert sid == "b"


def test_find_session_pick_oldest_mtime(tmp_path):
    # Regression test for b93438d ("sdk/migrate: make session pick option
    # actually work"): _find_session's pick ternary previously had identical
    # branches (matches[-1] regardless of pick), so pick="oldest_mtime" was
    # silently a no-op and always returned the newest file instead. This
    # pins the fix: oldest_mtime must return the OLDEST match, not the
    # newest.
    a, b = tmp_path / "a.jsonl", tmp_path / "b.jsonl"
    _touch(a, time.time() - 100)
    _touch(b, time.time() - 10)
    spec = {"glob": str(tmp_path / "*.jsonl"), "pick": "oldest_mtime"}
    path, sid = migrate._find_session(spec, {})
    assert path == str(a)
    assert sid == "a"


def test_find_session_id_regex():
    import tempfile

    with tempfile.TemporaryDirectory() as d:
        name = "rollout-2026-08-25T12-00-00-abc12345-6789-4abc-9def-0123456789ab.jsonl"
        p = Path(d) / name
        p.write_text("{}")
        spec = {
            "glob": str(Path(d) / "*.jsonl"),
            "id": {"regex": r"rollout-.*?-([0-9a-fA-F-]{36})\.jsonl$"},
        }
        path, sid = migrate._find_session(spec, {})
        assert path == str(p)
        assert sid == "abc12345-6789-4abc-9def-0123456789ab"


def test_find_session_id_session_path(tmp_path):
    p = tmp_path / "x.jsonl"
    p.write_text("{}")
    path, sid = migrate._find_session({"glob": str(tmp_path / "*.jsonl"), "id": "session_path"}, {})
    assert sid == path == str(p)


def test_find_session_no_matches_returns_none(tmp_path):
    assert migrate._find_session({"glob": str(tmp_path / "*.jsonl")}, {}) == (None, None)


def test_find_session_regex_no_match_falls_back_to_stem(tmp_path):
    p = tmp_path / "unexpected-name.jsonl"
    p.write_text("{}")
    spec = {"glob": str(tmp_path / "*.jsonl"), "id": {"regex": r"nomatch-(\d+)"}}
    _, sid = migrate._find_session(spec, {})
    assert sid == "unexpected-name"


# ---------------------------------------------------------------------------
# quiesce
# ---------------------------------------------------------------------------


def test_quiesce_true_when_file_absent():
    assert migrate.quiesce("/nonexistent/path.jsonl") is True


def test_quiesce_settles_once_file_stops_growing(tmp_path):
    p = tmp_path / "t.jsonl"
    p.write_text("x" * 10)
    assert migrate.quiesce(str(p), timeout=5, stable_secs=0.3) is True


def test_quiesce_times_out_if_file_keeps_growing(tmp_path):
    p = tmp_path / "t.jsonl"
    p.write_text("x")
    stop = threading.Event()

    def grow():
        while not stop.is_set():
            with open(p, "a") as f:
                f.write("x")
            time.sleep(0.1)

    t = threading.Thread(target=grow, daemon=True)
    t.start()
    try:
        assert migrate.quiesce(str(p), timeout=1, stable_secs=5) is False
    finally:
        stop.set()
        t.join()


# ---------------------------------------------------------------------------
# discover() — against a REAL spawned process and REAL /proc, not a mock.
#
# The child's argv[0] is renamed to "claude" via bash's `exec -a`, which is
# enough to satisfy the shipped claude-code recipe's
# {"argv_contains": "claude"} detect rule without needing the actual CLI
# installed — verified separately (live, against the real `claude` binary)
# in the PR's manual end-to-end pass.
# ---------------------------------------------------------------------------


@pytest.fixture
def fake_claude_process(tmp_path, monkeypatch):
    monkeypatch.setenv("HOME", str(tmp_path))
    cwd = tmp_path / "project"
    cwd.mkdir()
    cwd_key = migrate._cwd_key(str(cwd))
    sess_dir = tmp_path / ".claude" / "projects" / cwd_key
    sess_dir.mkdir(parents=True)
    (sess_dir / "abc-session-id.jsonl").write_text('{"hello": "world"}\n')

    env = dict(os.environ)
    env["HOME"] = str(tmp_path)
    env["ANTHROPIC_API_KEY"] = "sk-ant-test-demo-key"
    proc = subprocess.Popen(["bash", "-c", "exec -a claude sleep 100"], cwd=str(cwd), env=env)
    time.sleep(0.2)
    try:
        yield proc, cwd, sess_dir / "abc-session-id.jsonl"
    finally:
        proc.kill()
        proc.wait()


def test_discover_finds_claude_code_recipe_cwd_and_session(fake_claude_process):
    proc, cwd, session_path = fake_claude_process
    info = migrate.discover(proc.pid)
    assert info["command"] == "claude-code"
    assert info["cwd"] == str(cwd)
    assert info["session_path"] == str(session_path)
    assert info["session_id"] == "abc-session-id"
    assert info["environ"]["ANTHROPIC_API_KEY"] == "sk-ant-test-demo-key"


def test_discover_unrecognized_command_returns_none_and_no_session():
    proc = subprocess.Popen(["sleep", "100"])
    time.sleep(0.2)
    try:
        info = migrate.discover(proc.pid)
        assert info["command"] is None
        assert info["session_path"] is None
        assert info["session_id"] is None
    finally:
        proc.kill()
        proc.wait()


# ---------------------------------------------------------------------------
# migrate() — key forwarding semantics, exercised without a network call by
# faking just enough of the VM/client surface.
# ---------------------------------------------------------------------------


class _FakeRun:
    def __init__(self, stdout: bytes) -> None:
        self.stdout = stdout


class _FakeSession:
    session_id = "sess-1"


class _FakeVM:
    def __init__(self) -> None:
        self.runs: list[str] = []
        self.synced: dict[str, bytes] = {}
        self.session_env: dict[str, str] | None = None

    def run(self, command, **kwargs):
        self.runs.append(command)
        return _FakeRun(b"resumed-output")

    def sync_dir(self, local_dir, remote_dir, **kwargs):
        return None

    def sync(self, path, data=None):
        self.synced[path] = data
        return None

    def create_session(self, *, env=None, cwd=None):
        self.session_env = env
        return _FakeSession()


class _FakeClient:
    def __init__(self) -> None:
        self.vm = _FakeVM()

    def fork(self, source, **kwargs):
        return self.vm


def test_migrate_explicit_keys_override_wins_over_discovered_environ(fake_claude_process):
    # The claude-code recipe declares keys=["ANTHROPIC_API_KEY"]; the fixture
    # process has ANTHROPIC_API_KEY set in its environ. An explicit `keys=`
    # argument to migrate() must win outright (not merge) — this is the
    # documented escape hatch for auth mechanisms the recipe's declared
    # `keys` list doesn't cover (e.g. OAuth-token-based logins, where the
    # credential lives in a file rather than the process environment and so
    # can never be auto-discovered via /proc/<pid>/environ).
    proc, _cwd, _session_path = fake_claude_process
    client = _FakeClient()
    vm, out = migrate.migrate(
        client,
        pid=proc.pid,
        do_quiesce=False,
        keys={"CLAUDE_CODE_OAUTH_TOKEN": "override-token"},
    )
    assert out == "resumed-output"
    assert vm.session_env == {"CLAUDE_CODE_OAUTH_TOKEN": "override-token"}
    assert "ANTHROPIC_API_KEY" not in vm.session_env


def test_migrate_auto_discovers_declared_keys_from_environ(fake_claude_process):
    proc, _cwd, _session_path = fake_claude_process
    client = _FakeClient()
    vm, _out = migrate.migrate(client, pid=proc.pid, do_quiesce=False)
    assert vm.session_env == {"ANTHROPIC_API_KEY": "sk-ant-test-demo-key"}


def test_migrate_auto_discovers_claude_code_oauth_token_too(tmp_path, monkeypatch):
    # The claude-code recipe declares two possible keys: ANTHROPIC_API_KEY
    # (raw API key auth) and CLAUDE_CODE_OAUTH_TOKEN (the env var Claude
    # Code reads for the headless/CI auth path set up via
    # `claude setup-token`). Confirm the latter is forwarded too when
    # present in environ — added after the live end-to-end migration
    # (session established under normal `claude login`) showed the resumed
    # process in the VM came up "Not logged in" because only
    # ANTHROPIC_API_KEY was declared and a real interactive login has
    # neither var in its environ (credentials live in
    # ~/.claude/.credentials.json instead, which this mechanism cannot see
    # — see the NOTE in migrate() next to key_env).
    monkeypatch.setenv("HOME", str(tmp_path))
    cwd = tmp_path / "project"
    cwd.mkdir()
    cwd_key = migrate._cwd_key(str(cwd))
    sess_dir = tmp_path / ".claude" / "projects" / cwd_key
    sess_dir.mkdir(parents=True)
    (sess_dir / "abc-session-id.jsonl").write_text('{"hello": "world"}\n')

    env = dict(os.environ)
    env["HOME"] = str(tmp_path)
    env.pop("ANTHROPIC_API_KEY", None)
    env["CLAUDE_CODE_OAUTH_TOKEN"] = "sk-ant-oat01-test-demo-token"
    proc = subprocess.Popen(["bash", "-c", "exec -a claude sleep 100"], cwd=str(cwd), env=env)
    time.sleep(0.2)
    try:
        client = _FakeClient()
        vm, _out = migrate.migrate(client, pid=proc.pid, do_quiesce=False)
        assert vm.session_env == {"CLAUDE_CODE_OAUTH_TOKEN": "sk-ant-oat01-test-demo-token"}
    finally:
        proc.kill()
        proc.wait()


def test_migrate_raises_for_unrecognized_command():
    proc = subprocess.Popen(["sleep", "100"])
    time.sleep(0.2)
    try:
        client = _FakeClient()
        with pytest.raises(ValueError, match="not a recognized migratable command"):
            migrate.migrate(client, pid=proc.pid, do_quiesce=False)
    finally:
        proc.kill()
        proc.wait()


# ---------------------------------------------------------------------------
# Package export — command migration must be reachable as `from arker import
# migrate`, not just as an internal module nobody outside this package can
# find. (Previously `arker/__init__.py` never imported it, so it worked only
# by accident via Python's from-package-import-submodule fallback and was
# absent from `__all__`, invisible to `from arker import *` / introspection.)
# ---------------------------------------------------------------------------


def test_migrate_module_is_a_declared_package_export():
    import arker

    assert "migrate" in arker.__all__
    # Same module object reached two ways: the top-of-file `from arker import
    # migrate` and attribute access on the package after import.
    assert arker.migrate is migrate
    assert callable(arker.migrate.migrate)
    assert callable(arker.migrate.discover)
