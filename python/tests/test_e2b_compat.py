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
    CommandResult,
    EntryInfo,
    FileType,
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


def test_commands_run_background_unsupported_in_phase_a() -> None:
    transport = FakeTransport()
    with patch("urllib.request.urlopen", transport):
        sbx = _make_sandbox(transport)
        with pytest.raises(NotImplementedError):
            sbx.commands.run("sleep 5", background=True)


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
