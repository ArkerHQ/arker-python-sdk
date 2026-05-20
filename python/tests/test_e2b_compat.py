"""Unit tests for `arker.e2b` Phase A surface.

Uses the same `FakeTransport` pattern as `test_computer.py` so no live
infra is required.
"""
from __future__ import annotations

import base64
import json
from unittest.mock import patch

import pytest

from arker.e2b import (
    CommandExitException,
    CommandHandle,
    CommandResult,
    EntryInfo,
    FileType,
    ProcessInfo,
    Sandbox,
)
from arker.e2b._commands import wrap_command

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


def _make_sandbox(transport: FakeTransport, vm_id: str = "vm_child") -> Sandbox:
    """Build a Sandbox whose underlying VM is a freshly-forked vm_id."""
    transport.add_json(
        lambda method, url: method == "POST" and url.endswith("/v1/vms/ubuntu/fork"),
        200,
        {"vm_id": vm_id, "owner_id": "o", "created_at": "now", "sessions": [session()]},
    )
    return Sandbox(_arker=client())


def test_sandbox_constructor_forks_default_template() -> None:
    transport = FakeTransport()
    with patch("urllib.request.urlopen", transport):
        sbx = _make_sandbox(transport)
    assert sbx.sandbox_id == "vm_child"


def test_sandbox_connect_attaches_without_fork() -> None:
    # No fork call scripted — connect must not fork.
    transport = FakeTransport()
    with patch("urllib.request.urlopen", transport):
        sbx = Sandbox(sandbox_id="vm_existing", _arker=client())
    assert sbx.sandbox_id == "vm_existing"
    assert transport.calls == []


def test_commands_run_returns_decoded_text() -> None:
    transport = FakeTransport()
    with patch("urllib.request.urlopen", transport):
        sbx = _make_sandbox(transport)
        transport.add_json(
            lambda method, url: method == "POST" and url.endswith("/v1/vms/vm_child/run"),
            200,
            _completed_run(stdout="hello\n"),
        )
        result = sbx.commands.run("echo hello")

    assert isinstance(result, CommandResult)
    assert result.stdout == "hello\n"
    assert result.stderr == ""
    assert result.exit_code == 0


def test_commands_run_raises_on_nonzero_exit() -> None:
    transport = FakeTransport()
    with patch("urllib.request.urlopen", transport):
        sbx = _make_sandbox(transport)
        transport.add_json(
            lambda method, url: method == "POST" and url.endswith("/v1/vms/vm_child/run"),
            200,
            _completed_run(stdout="", stderr="nope", exit_code=2),
        )
        with pytest.raises(CommandExitException) as info:
            sbx.commands.run("false")

    assert info.value.exit_code == 2
    assert info.value.result.stderr == "nope"


def _bg_run_response(run_id: str = "run_xyz") -> dict:
    return {"run_id": run_id, "completed": False}


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


def test_commands_run_background_returns_handle() -> None:
    transport = FakeTransport()
    with patch("urllib.request.urlopen", transport):
        sbx = _make_sandbox(transport)
        transport.add_json(
            lambda method, url: method == "POST" and url.endswith("/v1/vms/vm_child/run"),
            200,
            _bg_run_response("run_a"),
        )
        handle = sbx.commands.run("sleep 5", background=True)

    assert isinstance(handle, CommandHandle)
    assert handle.pid == 1
    assert sbx._bg_runs[1][0] == "run_a"


def test_handle_wait_polls_until_complete(monkeypatch) -> None:
    monkeypatch.setattr("arker.e2b._handle.time.sleep", lambda _s: None)
    transport = FakeTransport()
    with patch("urllib.request.urlopen", transport):
        sbx = _make_sandbox(transport)
        transport.add_json(
            lambda method, url: method == "POST" and url.endswith("/v1/vms/vm_child/run"),
            200,
            _bg_run_response("run_a"),
        )
        handle = sbx.commands.run("echo done", background=True)

        transport.add_json(
            lambda method, url: method == "GET" and "/runs/run_a" in url,
            200,
            _run_status("run_a", stdout="part1", completed=False),
        )
        transport.add_json(
            lambda method, url: method == "GET" and "/runs/run_a" in url,
            200,
            _run_status("run_a", stdout="part1done", exit_code=0, completed=True),
        )

        chunks: list[str] = []
        result = handle.wait(on_stdout=chunks.append)

    assert result.exit_code == 0
    assert result.stdout == "part1done"
    assert chunks == ["part1", "done"]


def test_handle_wait_raises_on_nonzero(monkeypatch) -> None:
    monkeypatch.setattr("arker.e2b._handle.time.sleep", lambda _s: None)
    transport = FakeTransport()
    with patch("urllib.request.urlopen", transport):
        sbx = _make_sandbox(transport)
        transport.add_json(
            lambda method, url: method == "POST" and url.endswith("/v1/vms/vm_child/run"),
            200,
            _bg_run_response("run_b"),
        )
        handle = sbx.commands.run("false", background=True)
        transport.add_json(
            lambda method, url: method == "GET" and "/runs/run_b" in url,
            200,
            _run_status("run_b", stderr="err", exit_code=2, completed=True),
        )
        with pytest.raises(CommandExitException) as info:
            handle.wait()

    assert info.value.exit_code == 2


def test_handle_kill_cancels_and_forgets() -> None:
    transport = FakeTransport()
    with patch("urllib.request.urlopen", transport):
        sbx = _make_sandbox(transport)
        transport.add_json(
            lambda method, url: method == "POST" and url.endswith("/v1/vms/vm_child/run"),
            200,
            _bg_run_response("run_c"),
        )
        handle = sbx.commands.run("sleep 99", background=True)
        transport.add_json(
            lambda method, url: method == "DELETE" and "/runs/run_c" in url,
            200,
            {"cancelled": True},
        )
        assert handle.kill() is True

    assert sbx._bg_runs == {}


def test_commands_list_returns_registered_runs() -> None:
    transport = FakeTransport()
    with patch("urllib.request.urlopen", transport):
        sbx = _make_sandbox(transport)
        transport.add_json(
            lambda method, url: method == "POST" and url.endswith("/v1/vms/vm_child/run"),
            200,
            _bg_run_response("run_d"),
        )
        sbx.commands.run("sleep 1", background=True)
        listing = sbx.commands.list()

    assert len(listing) == 1
    assert isinstance(listing[0], ProcessInfo)
    assert listing[0].tag == "run_d"


def test_commands_connect_reconstructs_handle() -> None:
    transport = FakeTransport()
    with patch("urllib.request.urlopen", transport):
        sbx = _make_sandbox(transport)
        transport.add_json(
            lambda method, url: method == "POST" and url.endswith("/v1/vms/vm_child/run"),
            200,
            _bg_run_response("run_e"),
        )
        handle = sbx.commands.run("sleep 1", background=True)
        again = sbx.commands.connect(handle.pid)

    assert again.pid == handle.pid
    assert again._run_id == "run_e"


def test_commands_send_stdin_is_silent_noop(caplog) -> None:
    transport = FakeTransport()
    with patch("urllib.request.urlopen", transport):
        sbx = _make_sandbox(transport)
        # Should not raise even if pid doesn't exist
        sbx.commands.send_stdin(99, "hello")


def test_handle_iter_yields_deltas(monkeypatch) -> None:
    monkeypatch.setattr("arker.e2b._handle.time.sleep", lambda _s: None)
    transport = FakeTransport()
    with patch("urllib.request.urlopen", transport):
        sbx = _make_sandbox(transport)
        transport.add_json(
            lambda method, url: method == "POST" and url.endswith("/v1/vms/vm_child/run"),
            200,
            _bg_run_response("run_f"),
        )
        handle = sbx.commands.run("echo a; sleep 1; echo b", background=True)
        transport.add_json(
            lambda method, url: method == "GET" and "/runs/run_f" in url,
            200,
            _run_status("run_f", stdout="a\n", completed=False),
        )
        transport.add_json(
            lambda method, url: method == "GET" and "/runs/run_f" in url,
            200,
            _run_status("run_f", stdout="a\nb\n", exit_code=0, completed=True),
        )
        chunks = list(handle)

    assert chunks == ["a\n", "b\n"]


def test_files_write_then_read_text(monkeypatch) -> None:
    transport = FakeTransport()
    with patch("urllib.request.urlopen", transport):
        sbx = _make_sandbox(transport)

        # write inline
        transport.add_json(
            lambda method, url: method == "POST" and url.endswith("/v1/vms/vm_child/sync"),
            200,
            {"results": [{"complete": True, "written": True}]},
        )
        entry = sbx.files.write("/tmp/x.txt", "data")

        # read inline
        transport.add_json(
            lambda method, url: method == "POST" and url.endswith("/v1/vms/vm_child/sync"),
            200,
            {"content": "data", "encoding": "utf-8"},
        )
        assert sbx.files.read("/tmp/x.txt") == "data"

    assert entry == EntryInfo(name="x.txt", type=FileType.FILE, path="/tmp/x.txt")


def test_files_read_bytes() -> None:
    transport = FakeTransport()
    with patch("urllib.request.urlopen", transport):
        sbx = _make_sandbox(transport)
        transport.add_json(
            lambda method, url: method == "POST" and url.endswith("/v1/vms/vm_child/sync"),
            200,
            {"content": _b64("\x00\x01"), "encoding": "base64"},
        )
        out = sbx.files.read("/tmp/y.bin", format="bytes")

    assert isinstance(out, bytearray)
    assert bytes(out) == b"\x00\x01"


def test_sandbox_kill_calls_delete() -> None:
    transport = FakeTransport()
    with patch("urllib.request.urlopen", transport):
        sbx = _make_sandbox(transport)
        transport.add_json(
            lambda method, url: method == "DELETE" and url.endswith("/v1/vms/vm_child"),
            200,
            {"deleted": True},
        )
        assert sbx.kill() is True


def test_envs_are_inlined_into_command() -> None:
    transport = FakeTransport()
    with patch("urllib.request.urlopen", transport):
        sbx = Sandbox(envs={"FOO": "bar"}, _arker=client(), sandbox_id="vm_e")
        captured: dict = {}

        def script(method: str, url: str) -> bool:
            return method == "POST" and url.endswith("/v1/vms/vm_e/run")

        transport.add_json(script, 200, _completed_run(stdout="ok"))
        sbx.commands.run("echo $FOO", cwd="/srv")

        body = json.loads(transport.calls[-1]["body"])
        captured["cmd"] = body["command"]

    assert "cd /srv &&" in captured["cmd"]
    assert "env FOO=bar" in captured["cmd"]
    assert captured["cmd"].endswith("echo $FOO")


def test_wrap_command_no_overrides() -> None:
    assert wrap_command("ls", cwd=None, envs=None) == "ls"


def test_wrap_command_cwd_only() -> None:
    assert wrap_command("ls", cwd="/tmp", envs=None) == "cd /tmp && ls"
