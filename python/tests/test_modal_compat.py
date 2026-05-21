"""Unit tests for `arker.modal` Phase A surface.

Uses the same FakeTransport pattern as `test_computer.py` — no live infra.
"""
from __future__ import annotations

import base64
import json
import os
from unittest.mock import patch

import pytest

from arker.modal import (
    ContainerProcess,
    FileInfo,
    FilesystemExecutionError,
    Image,
    InvalidError,
    NotFoundError,
    Sandbox,
    SandboxError,
)

from test_computer import FakeTransport, client, session


def _b64(text: str) -> str:
    return base64.b64encode(text.encode()).decode("ascii")


def _completed_run(stdout: str = "", stderr: str = "", exit_code: int = 0) -> dict:
    return {
        "stdout": _b64(stdout),
        "stdout_encoding": "base64",
        "stderr": _b64(stderr),
        "stderr_encoding": "base64",
        "exit_code": exit_code,
        "completed": True,
        "type": "completed",
    }


def _bg_run(run_id: str = "run_xyz") -> dict:
    return {"run_id": run_id, "completed": False, "tunnels": []}


def _run_status(run_id: str, stdout: str = "", stderr: str = "", exit_code: int | None = None, completed: bool = False) -> dict:
    return {
        "run_id": run_id,
        "stdout": _b64(stdout),
        "stdout_encoding": "base64",
        "stderr": _b64(stderr),
        "stderr_encoding": "base64",
        "exit_code": exit_code,
        "completed": completed,
        "tunnels": [],
    }


def _arker_env():
    return {"ARKER_API_KEY": "ark_live_test", "ARKER_BASE_URL": "https://test.invalid/api"}


def _make_sandbox(transport: FakeTransport, vm_id: str = "vm_modal") -> Sandbox:
    """Sandbox.create() doesn't accept a `_arker` test-injection point (modal's
    API doesn't have one). We patch in env vars and let the constructor build
    its own Arker, which the FakeTransport intercepts at the urlopen layer."""
    transport.add_json(
        lambda method, url: method == "POST" and url.endswith("/v1/vms/base/fork"),
        200,
        {"vm_id": vm_id, "owner_id": "o", "created_at": "now", "sessions": [session()]},
    )
    with patch.dict(os.environ, _arker_env(), clear=False):
        return Sandbox.create()


# ----- Lifecycle -----

def test_create_forks_default_template() -> None:
    transport = FakeTransport()
    with patch("urllib.request.urlopen", transport):
        sbx = _make_sandbox(transport)
    assert sbx.object_id == "vm_modal"


def test_create_accepts_image_with_tag() -> None:
    transport = FakeTransport()
    transport.add_json(
        lambda method, url: method == "POST" and url.endswith("/v1/vms/my-image/fork"),
        200,
        {"vm_id": "vm_img", "owner_id": "o", "created_at": "now", "sessions": [session()]},
    )
    with patch.dict(os.environ, _arker_env(), clear=False), patch("urllib.request.urlopen", transport):
        # `Image.from_registry("my-image")` stores tag="my-image"; the shim picks it up.
        sbx = Sandbox.create(image=Image.from_registry("my-image"))
    assert sbx.object_id == "vm_img"


def test_create_ignores_modal_only_kwargs() -> None:
    transport = FakeTransport()
    with patch("urllib.request.urlopen", transport):
        # All these kwargs are accepted but should not affect the fork call.
        transport.add_json(
            lambda method, url: method == "POST" and url.endswith("/v1/vms/base/fork"),
            200,
            {"vm_id": "vm_ok", "owner_id": "o", "created_at": "now", "sessions": [session()]},
        )
        with patch.dict(os.environ, _arker_env(), clear=False):
            sbx = Sandbox.create(
                app=None,
                cpu=2.0,
                memory=4096,
                gpu="T4",
                cloud="aws",
                region="us-west-2",
                block_network=True,
                encrypted_ports=[8080],
                idle_timeout=60,
                experimental_options={"foo": "bar"},
            )
    assert sbx.object_id == "vm_ok"


def test_from_id_attaches_without_fork() -> None:
    transport = FakeTransport()
    with patch.dict(os.environ, _arker_env(), clear=False), patch("urllib.request.urlopen", transport):
        sbx = Sandbox.from_id("vm_existing")
    assert sbx.object_id == "vm_existing"
    assert transport.calls == []


def test_from_id_empty_raises() -> None:
    with patch.dict(os.environ, _arker_env(), clear=False):
        with pytest.raises(SandboxError):
            Sandbox.from_id("")


def test_from_name_raises_not_implemented() -> None:
    with pytest.raises(NotImplementedError, match="from_name"):
        Sandbox.from_name("app", "name")


def test_terminate_calls_delete() -> None:
    transport = FakeTransport()
    with patch("urllib.request.urlopen", transport):
        sbx = _make_sandbox(transport)
        transport.add_json(
            lambda method, url: method == "DELETE" and url.endswith("/v1/vms/vm_modal"),
            200,
            {"deleted": True},
        )
        # No entrypoint → returncode is None (matches modal: terminate(wait=False)
        # without a running primary process can't produce an exit code).
        code = sbx.terminate()
    assert code is None


def test_context_manager_terminates_on_exit() -> None:
    transport = FakeTransport()
    with patch("urllib.request.urlopen", transport):
        transport.add_json(
            lambda method, url: method == "POST" and url.endswith("/v1/vms/base/fork"),
            200,
            {"vm_id": "vm_ctx", "owner_id": "o", "created_at": "now", "sessions": [session()]},
        )
        transport.add_json(
            lambda method, url: method == "DELETE" and url.endswith("/v1/vms/vm_ctx"),
            200,
            {"deleted": True},
        )
        with patch.dict(os.environ, _arker_env(), clear=False):
            with Sandbox.create() as sbx:
                assert sbx.object_id == "vm_ctx"
    assert any(c["method"] == "DELETE" and c["url"].endswith("/vm_ctx") for c in transport.calls)


# ----- Execution -----

def test_exec_returns_container_process() -> None:
    transport = FakeTransport()
    with patch("urllib.request.urlopen", transport):
        sbx = _make_sandbox(transport)
        transport.add_json(
            lambda method, url: method == "POST" and url.endswith("/v1/vms/vm_modal/run"),
            200,
            _bg_run("run_a"),
        )
        proc = sbx.exec("echo", "hello")
        body = json.loads(transport.calls[-1]["body"])
    assert isinstance(proc, ContainerProcess)
    # Variadic args are shlex-joined.
    assert body["command"].endswith("echo hello")
    assert body.get("background") is True


def test_exec_inlines_env_and_workdir() -> None:
    transport = FakeTransport()
    with patch("urllib.request.urlopen", transport):
        sbx = _make_sandbox(transport)
        transport.add_json(
            lambda method, url: method == "POST" and url.endswith("/v1/vms/vm_modal/run"),
            200,
            _bg_run("run_b"),
        )
        sbx.exec("ls", env={"K": "V"}, workdir="/srv")
        body = json.loads(transport.calls[-1]["body"])
    assert "cd /srv &&" in body["command"]
    assert "env K=V" in body["command"]


def test_exec_no_args_raises() -> None:
    transport = FakeTransport()
    with patch("urllib.request.urlopen", transport):
        sbx = _make_sandbox(transport)
        with pytest.raises(ValueError):
            sbx.exec()


def test_exec_pty_raises_not_implemented() -> None:
    transport = FakeTransport()
    with patch("urllib.request.urlopen", transport):
        sbx = _make_sandbox(transport)
        with pytest.raises(NotImplementedError, match="pty=True"):
            sbx.exec("bash", pty=True)


def test_process_wait_polls_until_complete(monkeypatch) -> None:
    monkeypatch.setattr("arker.modal._process.time.sleep", lambda _s: None)
    transport = FakeTransport()
    with patch("urllib.request.urlopen", transport):
        sbx = _make_sandbox(transport)
        transport.add_json(
            lambda method, url: method == "POST" and url.endswith("/v1/vms/vm_modal/run"),
            200,
            _bg_run("run_w"),
        )
        proc = sbx.exec("echo", "hi")

        transport.add_json(
            lambda method, url: method == "GET" and "/runs/run_w" in url,
            200,
            _run_status("run_w", stdout="part", completed=False),
        )
        transport.add_json(
            lambda method, url: method == "GET" and "/runs/run_w" in url,
            200,
            _run_status("run_w", stdout="part1done", exit_code=0, completed=True),
        )
        code = proc.wait()
    assert code == 0
    assert proc.returncode == 0


def test_stream_reader_read_blocks_and_returns_text(monkeypatch) -> None:
    monkeypatch.setattr("arker.modal._process.time.sleep", lambda _s: None)
    transport = FakeTransport()
    with patch("urllib.request.urlopen", transport):
        sbx = _make_sandbox(transport)
        transport.add_json(
            lambda method, url: method == "POST" and url.endswith("/v1/vms/vm_modal/run"),
            200,
            _bg_run("run_r"),
        )
        proc = sbx.exec("echo", "hi")
        transport.add_json(
            lambda method, url: method == "GET" and "/runs/run_r" in url,
            200,
            _run_status("run_r", stdout="hello\n", exit_code=0, completed=True),
        )
        out = proc.stdout.read()
    assert out == "hello\n"


def test_process_poll_returns_none_while_running() -> None:
    transport = FakeTransport()
    with patch("urllib.request.urlopen", transport):
        sbx = _make_sandbox(transport)
        transport.add_json(
            lambda method, url: method == "POST" and url.endswith("/v1/vms/vm_modal/run"),
            200,
            _bg_run("run_p"),
        )
        proc = sbx.exec("sleep", "5")
        transport.add_json(
            lambda method, url: method == "GET" and "/runs/run_p" in url,
            200,
            _run_status("run_p", completed=False),
        )
        assert proc.poll() is None


def test_process_kill_calls_cancel_run() -> None:
    transport = FakeTransport()
    with patch("urllib.request.urlopen", transport):
        sbx = _make_sandbox(transport)
        transport.add_json(
            lambda method, url: method == "POST" and url.endswith("/v1/vms/vm_modal/run"),
            200,
            _bg_run("run_k"),
        )
        proc = sbx.exec("sleep", "99")
        transport.add_json(
            lambda method, url: method == "DELETE" and "/runs/run_k" in url,
            200,
            {"cancelled": True},
        )
        proc.kill()


def test_stdin_write_raises() -> None:
    transport = FakeTransport()
    with patch("urllib.request.urlopen", transport):
        sbx = _make_sandbox(transport)
        transport.add_json(
            lambda method, url: method == "POST" and url.endswith("/v1/vms/vm_modal/run"),
            200,
            _bg_run("run_s"),
        )
        proc = sbx.exec("cat")
        with pytest.raises(NotImplementedError, match="stdin"):
            proc.stdin.write(b"data")


# ----- Filesystem -----

def test_filesystem_read_text_via_sync_api() -> None:
    transport = FakeTransport()
    with patch("urllib.request.urlopen", transport):
        sbx = _make_sandbox(transport)
        transport.add_json(
            lambda method, url: method == "POST" and url.endswith("/v1/vms/vm_modal/sync"),
            200,
            {"content": "data", "encoding": "utf-8"},
        )
        assert sbx.filesystem.read_text("/tmp/x") == "data"


def test_filesystem_write_text_via_sync_api() -> None:
    transport = FakeTransport()
    with patch("urllib.request.urlopen", transport):
        sbx = _make_sandbox(transport)
        transport.add_json(
            lambda method, url: method == "POST" and url.endswith("/v1/vms/vm_modal/sync"),
            200,
            {"results": [{"complete": True, "written": True}]},
        )
        sbx.filesystem.write_text("payload", "/tmp/x")


def test_filesystem_list_files_parses_find_output() -> None:
    transport = FakeTransport()
    with patch("urllib.request.urlopen", transport):
        sbx = _make_sandbox(transport)
        # Format: path|kind|size|mode|UID|GID|mtime|symlink
        transport.add_json(
            lambda method, url: method == "POST" and url.endswith("/v1/vms/vm_modal/run"),
            200,
            _completed_run(stdout=(
                "/work/readme.txt|f|42|644|1000|1000|1735776000.0|\n"
                "/work/src|d|4096|755|1000|1000|1735776100.0|\n"
            )),
        )
        entries = sbx.filesystem.list_files("/work")
    assert isinstance(entries[0], FileInfo)
    assert entries[0].path == "/work/readme.txt"
    assert entries[0].name == "readme.txt"
    assert entries[0].size == 42
    assert entries[0].mode == 0o644
    assert entries[0].permissions == "0644"
    assert entries[0].is_file() is True
    assert entries[1].is_dir() is True
    assert entries[1].modified_time == 1735776100.0


def test_filesystem_stat_returns_fileinfo() -> None:
    transport = FakeTransport()
    with patch("urllib.request.urlopen", transport):
        sbx = _make_sandbox(transport)
        transport.add_json(
            lambda method, url: method == "POST" and url.endswith("/v1/vms/vm_modal/run"),
            200,
            _completed_run(stdout="f|10|644|1000|1000|1735776000.0|\n"),
        )
        info = sbx.filesystem.stat("/tmp/x")
    assert info.is_dir() is False
    assert info.is_file() is True
    assert info.size == 10
    assert info.mode == 0o644


def test_filesystem_stat_raises_not_found_on_missing() -> None:
    transport = FakeTransport()
    with patch("urllib.request.urlopen", transport):
        sbx = _make_sandbox(transport)
        transport.add_json(
            lambda method, url: method == "POST" and url.endswith("/v1/vms/vm_modal/run"),
            200,
            _completed_run(stderr="find: '/nope': No such file or directory", exit_code=1),
        )
        with pytest.raises(NotFoundError):
            sbx.filesystem.stat("/nope")


def test_filesystem_make_directory_invokes_mkdir_p() -> None:
    transport = FakeTransport()
    with patch("urllib.request.urlopen", transport):
        sbx = _make_sandbox(transport)
        transport.add_json(
            lambda method, url: method == "POST" and url.endswith("/v1/vms/vm_modal/run"),
            200,
            _completed_run(),
        )
        sbx.filesystem.make_directory("/work/new/deep")
        body = json.loads(transport.calls[-1]["body"])
    assert body["command"] == "mkdir -p /work/new/deep"


def test_filesystem_remove_recursive() -> None:
    transport = FakeTransport()
    with patch("urllib.request.urlopen", transport):
        sbx = _make_sandbox(transport)
        transport.add_json(
            lambda method, url: method == "POST" and url.endswith("/v1/vms/vm_modal/run"),
            200,
            _completed_run(),
        )
        sbx.filesystem.remove("/tmp/junk", recursive=True)
        body = json.loads(transport.calls[-1]["body"])
    assert body["command"] == "rm -rf /tmp/junk"


def test_filesystem_copy_to_local(tmp_path) -> None:
    transport = FakeTransport()
    with patch("urllib.request.urlopen", transport):
        sbx = _make_sandbox(transport)
        transport.add_json(
            lambda method, url: method == "POST" and url.endswith("/v1/vms/vm_modal/sync"),
            200,
            {"content": _b64("hello"), "encoding": "base64"},
        )
        target = tmp_path / "out.bin"
        sbx.filesystem.copy_to_local("/tmp/x", str(target))
    assert target.read_bytes() == b"hello"


def test_filesystem_copy_from_local(tmp_path) -> None:
    transport = FakeTransport()
    with patch("urllib.request.urlopen", transport):
        sbx = _make_sandbox(transport)
        src = tmp_path / "in.bin"
        src.write_bytes(b"payload")
        transport.add_json(
            lambda method, url: method == "POST" and url.endswith("/v1/vms/vm_modal/sync"),
            200,
            {"results": [{"complete": True, "written": True}]},
        )
        sbx.filesystem.copy_from_local(str(src), "/tmp/y")


def test_filesystem_watch_raises() -> None:
    transport = FakeTransport()
    with patch("urllib.request.urlopen", transport):
        sbx = _make_sandbox(transport)
        with pytest.raises(NotImplementedError, match="watch"):
            sbx.filesystem.watch("/tmp")


# ----- Tags + listing + unsupported -----

def test_set_and_get_tags_local_only() -> None:
    transport = FakeTransport()
    with patch("urllib.request.urlopen", transport):
        sbx = _make_sandbox(transport)
        before = len(transport.calls)
        sbx.set_tags({"env": "test"})
        assert len(transport.calls) == before
    assert sbx.get_tags() == {"env": "test"}


def test_sandbox_list_returns_list() -> None:
    transport = FakeTransport()
    transport.add_json(
        lambda method, url: method == "GET" and url.endswith("/v1/vms"),
        200,
        {
            "vms": [
                {"vm_id": "vm_a", "owner_id": "o", "created_at": "now", "state": "running", "sessions": []},
                {"vm_id": "vm_b", "owner_id": "o", "created_at": "now", "state": "running", "sessions": []},
            ],
        },
    )
    with patch.dict(os.environ, _arker_env(), clear=False), patch("urllib.request.urlopen", transport):
        items = Sandbox.list()
    assert [s.object_id for s in items] == ["vm_a", "vm_b"]


# ----- Phase G drift fixes -----

def test_create_with_entrypoint_auto_spawns() -> None:
    """modal.Sandbox.create("sleep", "5") runs that as the primary process.
    Our shim spawns it as a background run and binds wait/poll/returncode."""
    transport = FakeTransport()
    transport.add_json(
        lambda method, url: method == "POST" and url.endswith("/v1/vms/base/fork"),
        200,
        {"vm_id": "vm_ep", "owner_id": "o", "created_at": "now", "sessions": [session()]},
    )
    transport.add_json(
        lambda method, url: method == "POST" and url.endswith("/v1/vms/vm_ep/run"),
        200,
        {"run_id": "run_ep", "completed": False, "tunnels": []},
    )
    with patch.dict(os.environ, _arker_env(), clear=False), patch("urllib.request.urlopen", transport):
        sbx = Sandbox.create("sleep", "5")
        assert sbx._entrypoint_run_id == "run_ep"
        body = json.loads(transport.calls[-1]["body"])
    # shlex.quote leaves plain alphanumerics unquoted.
    assert body["command"] == "sleep 5"
    assert body["background"] is True


def test_wait_blocks_on_entrypoint(monkeypatch) -> None:
    monkeypatch.setattr("arker.modal._sandbox.time.sleep", lambda _s: None)
    transport = FakeTransport()
    transport.add_json(
        lambda method, url: method == "POST" and url.endswith("/v1/vms/base/fork"),
        200,
        {"vm_id": "vm_w", "owner_id": "o", "created_at": "now", "sessions": [session()]},
    )
    transport.add_json(
        lambda method, url: method == "POST" and url.endswith("/v1/vms/vm_w/run"),
        200,
        {"run_id": "run_w", "completed": False, "tunnels": []},
    )
    with patch.dict(os.environ, _arker_env(), clear=False), patch("urllib.request.urlopen", transport):
        sbx = Sandbox.create("echo", "done")
        transport.add_json(
            lambda method, url: method == "GET" and "/runs/run_w" in url,
            200,
            _run_status("run_w", exit_code=0, completed=True),
        )
        sbx.wait()
        # returncode is the entrypoint's exit code.
        assert sbx.returncode == 0


def test_poll_returns_none_then_exit_code() -> None:
    transport = FakeTransport()
    transport.add_json(
        lambda method, url: method == "POST" and url.endswith("/v1/vms/base/fork"),
        200,
        {"vm_id": "vm_p", "owner_id": "o", "created_at": "now", "sessions": [session()]},
    )
    transport.add_json(
        lambda method, url: method == "POST" and url.endswith("/v1/vms/vm_p/run"),
        200,
        {"run_id": "run_p", "completed": False, "tunnels": []},
    )
    with patch.dict(os.environ, _arker_env(), clear=False), patch("urllib.request.urlopen", transport):
        sbx = Sandbox.create("sleep", "5")
        transport.add_json(
            lambda method, url: method == "GET" and "/runs/run_p" in url,
            200,
            _run_status("run_p", completed=False),
        )
        assert sbx.poll() is None
        transport.add_json(
            lambda method, url: method == "GET" and "/runs/run_p" in url,
            200,
            _run_status("run_p", exit_code=42, completed=True),
        )
        assert sbx.poll() == 42


def test_returncode_raises_invalid_error_pre_wait() -> None:
    transport = FakeTransport()
    with patch("urllib.request.urlopen", transport):
        sbx = _make_sandbox(transport)
        transport.add_json(
            lambda method, url: method == "POST" and url.endswith("/v1/vms/vm_modal/run"),
            200,
            _bg_run("run_rc"),
        )
        proc = sbx.exec("sleep", "5")
        with pytest.raises(InvalidError, match="wait\\(\\)"):
            _ = proc.returncode


def test_fileinfo_has_methods_not_field() -> None:
    info = FileInfo(name="x", path="/x", type=FileInfo.__annotations__["type"].__args__[0] if False else None)  # type: ignore[arg-type]
    # The above is a syntax trick — easier: construct directly.
    from arker.modal import FileType
    info = FileInfo(name="x", path="/x", type=FileType.FILE, size=10)
    # Methods, not fields.
    assert callable(info.is_dir)
    assert info.is_file() is True
    assert info.is_dir() is False


def test_image_methods_return_new_instance() -> None:
    base = Image.debian_slim()
    a = base.pip_install("torch")
    b = base.pip_install("tensorflow")
    assert a is not base
    assert b is not base
    assert a is not b


def test_filesystem_validates_absolute_paths() -> None:
    transport = FakeTransport()
    with patch("urllib.request.urlopen", transport):
        sbx = _make_sandbox(transport)
        with pytest.raises(InvalidError, match="absolute"):
            sbx.filesystem.read_text("relative/path")
        with pytest.raises(InvalidError, match="absolute"):
            sbx.filesystem.write_text("data", "relative/path")
        with pytest.raises(InvalidError, match="absolute"):
            sbx.filesystem.list_files("relative")
        with pytest.raises(InvalidError, match="absolute"):
            sbx.filesystem.stat("relative")


def test_env_none_values_filtered() -> None:
    transport = FakeTransport()
    with patch("urllib.request.urlopen", transport):
        sbx = _make_sandbox(transport)
        # `env={"FOO": None}` should drop FOO, not inject "env FOO=None".
        transport.add_json(
            lambda method, url: method == "POST" and url.endswith("/v1/vms/vm_modal/run"),
            200,
            _bg_run("run_env"),
        )
        sbx.exec("env", env={"FOO": None, "BAR": "value"})  # type: ignore[dict-item]
        body = json.loads(transport.calls[-1]["body"])
    assert "FOO" not in body["command"]
    assert "BAR=value" in body["command"]


def test_list_filters_running_by_default() -> None:
    transport = FakeTransport()
    transport.add_json(
        lambda method, url: method == "GET" and url.endswith("/v1/vms"),
        200,
        {
            "vms": [
                {"vm_id": "vm_run", "owner_id": "o", "created_at": "now", "state": "running", "sessions": []},
                {"vm_id": "vm_dead", "owner_id": "o", "created_at": "now", "state": "stopped", "sessions": []},
            ],
        },
    )
    with patch.dict(os.environ, _arker_env(), clear=False), patch("urllib.request.urlopen", transport):
        items = Sandbox.list()
    # Default: running-only.
    assert [s.object_id for s in items] == ["vm_run"]


def test_list_tags_raises_invalid() -> None:
    with patch.dict(os.environ, _arker_env(), clear=False):
        with pytest.raises(InvalidError, match="tags"):
            Sandbox.list(tags={"env": "prod"})


def test_stream_reader_async_iteration(monkeypatch) -> None:
    import asyncio
    monkeypatch.setattr("arker.modal._process.time.sleep", lambda _s: None)
    transport = FakeTransport()
    with patch("urllib.request.urlopen", transport):
        sbx = _make_sandbox(transport)
        transport.add_json(
            lambda method, url: method == "POST" and url.endswith("/v1/vms/vm_modal/run"),
            200,
            _bg_run("run_aiter"),
        )
        proc = sbx.exec("sh", "-c", "echo a; echo b")
        transport.add_json(
            lambda method, url: method == "GET" and "/runs/run_aiter" in url,
            200,
            _run_status("run_aiter", stdout="a\nb\n", exit_code=0, completed=True),
        )

        async def consume() -> list[str]:
            return [line async for line in proc.stdout]
        lines = asyncio.run(consume())
    assert lines == ["a\n", "b\n"]


def test_unsupported_methods_raise() -> None:
    transport = FakeTransport()
    with patch("urllib.request.urlopen", transport):
        sbx = _make_sandbox(transport)
        with pytest.raises(NotImplementedError, match="snapshot_filesystem"):
            sbx.snapshot_filesystem()
        with pytest.raises(NotImplementedError, match="mount_image"):
            sbx.mount_image("/", None)
        with pytest.raises(NotImplementedError, match="create_connect_token"):
            sbx.create_connect_token()
        with pytest.raises(NotImplementedError, match="reload_volumes"):
            sbx.reload_volumes()
        with pytest.raises(NotImplementedError, match="Sandbox.open"):
            sbx.open("/tmp/x")
        with pytest.raises(NotImplementedError, match="Sandbox.stdout"):
            _ = sbx.stdout
        with pytest.raises(NotImplementedError, match="tunnels"):
            sbx.tunnels()
