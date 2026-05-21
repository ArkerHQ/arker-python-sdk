"""Unit tests for `arker.codesandbox` Python shim.

Uses the same FakeTransport pattern as test_computer.py.
"""
from __future__ import annotations

import base64
import json
from unittest.mock import patch

import pytest

from arker.codesandbox import (
    BootupType,
    CodeSandbox,
    CodeSandboxError,
    Command,
    CommandError,
    CommandStatus,
    FSStatResult,
    ReaddirEntry,
    Sandbox,
    SandboxClient,
    SandboxListResponse,
    SandboxNotFoundError,
)

from test_computer import FakeTransport, client, session


def _b64(text: str) -> str:
    return base64.b64encode(text.encode()).decode("ascii")


def _completed(stdout: str = "", stderr: str = "", exit_code: int = 0) -> dict:
    return {
        "stdout": _b64(stdout),
        "stdout_encoding": "base64",
        "stderr": _b64(stderr),
        "stderr_encoding": "base64",
        "exit_code": exit_code,
        "completed": True,
        "type": "completed",
    }


def _bg_run(run_id: str) -> dict:
    return {"run_id": run_id, "completed": False, "tunnels": []}


def _make_csb(transport: FakeTransport) -> CodeSandbox:
    return CodeSandbox(api_token="ark_live_test", _arker=client())


def _create_sandbox(transport: FakeTransport, vm_id: str = "vm_csb") -> Sandbox:
    transport.add_json(
        lambda method, url: method == "POST" and url.endswith("/v1/vms/base/fork"),
        200,
        {"vm_id": vm_id, "owner_id": "o", "created_at": "now", "sessions": [session()]},
    )
    return _make_csb(transport).sandboxes.create()


# ----- Client + Sandboxes lifecycle -----

def test_codesandbox_constructor_no_arker() -> None:
    """Constructing without Arker shouldn't blow up — but it needs api_key/region."""
    # We pass _arker explicitly in other tests; just check the import & basic shape.
    csb = CodeSandbox(api_token="ark_live_test", _arker=client())
    assert hasattr(csb, "sandboxes")


def test_sandboxes_create_returns_sandbox() -> None:
    transport = FakeTransport()
    with patch("urllib.request.urlopen", transport):
        sbx = _create_sandbox(transport)
    assert isinstance(sbx, Sandbox)
    assert sbx.id == "vm_csb"
    assert sbx.bootupType == BootupType.FORK


def test_sandboxes_create_with_template_id() -> None:
    transport = FakeTransport()
    transport.add_json(
        lambda method, url: method == "POST" and url.endswith("/v1/vms/my-template/fork"),
        200,
        {"vm_id": "vm_t", "owner_id": "o", "created_at": "now", "sessions": [session()]},
    )
    with patch("urllib.request.urlopen", transport):
        csb = _make_csb(transport)
        sbx = csb.sandboxes.create({"id": "my-template", "title": "my-vm"})
    assert sbx.id == "vm_t"


def test_sandboxes_get_attaches_to_existing() -> None:
    transport = FakeTransport()
    transport.add_json(
        lambda method, url: method == "GET" and url.endswith("/v1/vms/vm_existing"),
        200,
        {"vm_id": "vm_existing", "owner_id": "o", "created_at": "now",
         "state": "running", "sessions": []},
    )
    with patch("urllib.request.urlopen", transport):
        csb = _make_csb(transport)
        sbx = csb.sandboxes.get("vm_existing")
    assert sbx.id == "vm_existing"
    assert sbx.bootupType == BootupType.RUNNING


def test_sandboxes_get_404_raises_not_found() -> None:
    transport = FakeTransport()
    transport.add_json(
        lambda method, url: method == "GET" and url.endswith("/v1/vms/missing"),
        404,
        {"code": "not_found", "message": "no such vm"},
    )
    with patch("urllib.request.urlopen", transport):
        csb = _make_csb(transport)
        with pytest.raises(SandboxNotFoundError):
            csb.sandboxes.get("missing")


def test_sandboxes_resume_sets_bootup_resume() -> None:
    transport = FakeTransport()
    transport.add_json(
        lambda method, url: method == "GET" and url.endswith("/v1/vms/vm_x"),
        200,
        {"vm_id": "vm_x", "owner_id": "o", "created_at": "now",
         "state": "running", "sessions": []},
    )
    with patch("urllib.request.urlopen", transport):
        csb = _make_csb(transport)
        sbx = csb.sandboxes.resume("vm_x")
    assert sbx.bootupType == BootupType.RESUME


def test_sandboxes_restart_sets_bootup_clean() -> None:
    transport = FakeTransport()
    transport.add_json(
        lambda method, url: method == "GET" and url.endswith("/v1/vms/vm_x"),
        200,
        {"vm_id": "vm_x", "owner_id": "o", "created_at": "now",
         "state": "running", "sessions": []},
    )
    with patch("urllib.request.urlopen", transport):
        csb = _make_csb(transport)
        sbx = csb.sandboxes.restart("vm_x")
    assert sbx.bootupType == BootupType.CLEAN


def test_sandboxes_delete_calls_arker_delete() -> None:
    transport = FakeTransport()
    transport.add_json(
        lambda method, url: method == "DELETE" and url.endswith("/v1/vms/vm_csb"),
        200,
        {"deleted": True},
    )
    with patch("urllib.request.urlopen", transport):
        csb = _make_csb(transport)
        csb.sandboxes.delete("vm_csb")


def test_sandboxes_shutdown_warns_and_noop() -> None:
    transport = FakeTransport()
    with patch("urllib.request.urlopen", transport):
        csb = _make_csb(transport)
        before = len(transport.calls)
        with pytest.warns(UserWarning, match="no-op"):
            csb.sandboxes.shutdown("vm_csb")
    assert len(transport.calls) == before


def test_sandboxes_hibernate_warns_and_noop() -> None:
    transport = FakeTransport()
    with patch("urllib.request.urlopen", transport):
        csb = _make_csb(transport)
        before = len(transport.calls)
        with pytest.warns(UserWarning, match="no-op"):
            csb.sandboxes.hibernate("vm_csb")
    assert len(transport.calls) == before


def test_sandboxes_list_returns_paginated() -> None:
    transport = FakeTransport()
    transport.add_json(
        lambda method, url: method == "GET" and url.endswith("/v1/vms"),
        200,
        {
            "vms": [
                {"vm_id": f"vm_{i}", "owner_id": "o", "created_at": "now",
                 "state": "running", "sessions": [], "name": f"sandbox-{i}"}
                for i in range(3)
            ],
        },
    )
    with patch("urllib.request.urlopen", transport):
        csb = _make_csb(transport)
        resp = csb.sandboxes.list()
    assert isinstance(resp, SandboxListResponse)
    assert resp.total_count == 3
    assert [s.id for s in resp.sandboxes] == ["vm_0", "vm_1", "vm_2"]
    assert resp.sandboxes[0].title == "sandbox-0"


def test_sandboxes_list_with_tags_raises() -> None:
    transport = FakeTransport()
    with patch("urllib.request.urlopen", transport):
        csb = _make_csb(transport)
        with pytest.raises(CodeSandboxError, match="tags"):
            csb.sandboxes.list({"tags": ["sdk"]})


def test_sandboxes_fork_emits_deprecation() -> None:
    transport = FakeTransport()
    transport.add_json(
        lambda method, url: method == "POST" and url.endswith("/v1/vms/vm_template/fork"),
        200,
        {"vm_id": "vm_new", "owner_id": "o", "created_at": "now", "sessions": [session()]},
    )
    with patch("urllib.request.urlopen", transport):
        csb = _make_csb(transport)
        with pytest.warns(DeprecationWarning):
            sbx = csb.sandboxes.fork("vm_template")
    assert sbx.id == "vm_new"


# ----- Sandbox + SandboxClient -----

def test_sandbox_connect_returns_client() -> None:
    transport = FakeTransport()
    with patch("urllib.request.urlopen", transport):
        sbx = _create_sandbox(transport)
        client_obj = sbx.connect()
    assert isinstance(client_obj, SandboxClient)
    assert client_obj._sandbox is sbx


def test_sandbox_update_tier_raises() -> None:
    transport = FakeTransport()
    with patch("urllib.request.urlopen", transport):
        sbx = _create_sandbox(transport)
        with pytest.raises(NotImplementedError, match="updateTier"):
            sbx.updateTier(None)


def test_sandbox_update_hibernation_timeout_warns() -> None:
    transport = FakeTransport()
    with patch("urllib.request.urlopen", transport):
        sbx = _create_sandbox(transport)
        with pytest.warns(UserWarning, match="local"):
            sbx.updateHibernationTimeout(300)


# ----- Commands -----

def test_commands_run_returns_output_string() -> None:
    transport = FakeTransport()
    with patch("urllib.request.urlopen", transport):
        sbx = _create_sandbox(transport)
        client_obj = sbx.connect()
        transport.add_json(
            lambda method, url: method == "POST" and url.endswith("/v1/vms/vm_csb/run"),
            200,
            _completed(stdout="hello\n"),
        )
        # codesandbox returns combined string output.
        out = client_obj.commands.run("echo hello")
    assert out == "hello\n"


def test_commands_run_raises_command_error_on_failure() -> None:
    transport = FakeTransport()
    with patch("urllib.request.urlopen", transport):
        sbx = _create_sandbox(transport)
        client_obj = sbx.connect()
        transport.add_json(
            lambda method, url: method == "POST" and url.endswith("/v1/vms/vm_csb/run"),
            200,
            _completed(stderr="boom", exit_code=2),
        )
        with pytest.raises(CommandError) as info:
            client_obj.commands.run("false")
    assert info.value.exit_code == 2
    assert "boom" in info.value.output


def test_commands_run_accepts_array_form() -> None:
    transport = FakeTransport()
    with patch("urllib.request.urlopen", transport):
        sbx = _create_sandbox(transport)
        client_obj = sbx.connect()
        transport.add_json(
            lambda method, url: method == "POST" and url.endswith("/v1/vms/vm_csb/run"),
            200,
            _completed(stdout="ok"),
        )
        # codesandbox: run(["python", "-c", "print(1)"])
        client_obj.commands.run(["python", "-c", "print(1)"])
        body = json.loads(transport.calls[-1]["body"])
    assert body["command"] == "python -c 'print(1)'"


def test_commands_run_with_cwd_and_env() -> None:
    transport = FakeTransport()
    with patch("urllib.request.urlopen", transport):
        sbx = _create_sandbox(transport)
        client_obj = sbx.connect()
        transport.add_json(
            lambda method, url: method == "POST" and url.endswith("/v1/vms/vm_csb/run"),
            200,
            _completed(stdout="ok"),
        )
        client_obj.commands.run("ls", {"cwd": "/srv", "env": {"X": "1"}})
        body = json.loads(transport.calls[-1]["body"])
    assert "cd /srv &&" in body["command"]
    assert "env X=1" in body["command"]


def test_commands_run_background_returns_command_handle() -> None:
    transport = FakeTransport()
    with patch("urllib.request.urlopen", transport):
        sbx = _create_sandbox(transport)
        client_obj = sbx.connect()
        transport.add_json(
            lambda method, url: method == "POST" and url.endswith("/v1/vms/vm_csb/run"),
            200,
            _bg_run("run_bg"),
        )
        cmd = client_obj.commands.runBackground("sleep 5", {"name": "long-job"})
    assert isinstance(cmd, Command)
    assert cmd.name == "long-job"
    assert cmd.status == CommandStatus.RUNNING
    assert client_obj.commands.get("long-job") is cmd
    assert client_obj.commands.getAll() == [cmd]


# ----- Filesystem -----

def test_fs_write_then_read_text_file() -> None:
    transport = FakeTransport()
    with patch("urllib.request.urlopen", transport):
        sbx = _create_sandbox(transport)
        client_obj = sbx.connect()
        transport.add_json(
            lambda method, url: method == "POST" and url.endswith("/v1/vms/vm_csb/sync"),
            200,
            {"results": [{"complete": True, "written": True}]},
        )
        client_obj.fs.writeTextFile("/sandbox/x.txt", "data")

        transport.add_json(
            lambda method, url: method == "POST" and url.endswith("/v1/vms/vm_csb/sync"),
            200,
            {"content": "data", "encoding": "utf-8"},
        )
        assert client_obj.fs.readTextFile("/sandbox/x.txt") == "data"


def test_fs_read_write_bytes() -> None:
    transport = FakeTransport()
    with patch("urllib.request.urlopen", transport):
        sbx = _create_sandbox(transport)
        client_obj = sbx.connect()
        transport.add_json(
            lambda method, url: method == "POST" and url.endswith("/v1/vms/vm_csb/sync"),
            200,
            {"results": [{"complete": True, "written": True}]},
        )
        client_obj.fs.writeFile("/tmp/x.bin", b"\x00\x01\x02")

        transport.add_json(
            lambda method, url: method == "POST" and url.endswith("/v1/vms/vm_csb/sync"),
            200,
            {"content": _b64("\x00\x01"), "encoding": "base64"},
        )
        data = client_obj.fs.readFile("/tmp/x.bin")
    assert data == b"\x00\x01"


def test_fs_readdir_parses_find_output() -> None:
    transport = FakeTransport()
    with patch("urllib.request.urlopen", transport):
        sbx = _create_sandbox(transport)
        client_obj = sbx.connect()
        transport.add_json(
            lambda method, url: method == "POST" and url.endswith("/v1/vms/vm_csb/run"),
            200,
            _completed(stdout="readme.txt|f\nsrc|d\nlinky|l\n"),
        )
        entries = client_obj.fs.readdir("/sandbox")
    assert entries == [
        ReaddirEntry(name="readme.txt", type="file", is_symlink=False),
        ReaddirEntry(name="src", type="directory", is_symlink=False),
        ReaddirEntry(name="linky", type="symlink", is_symlink=True),
    ]


def test_fs_stat_parses_find_output() -> None:
    transport = FakeTransport()
    with patch("urllib.request.urlopen", transport):
        sbx = _create_sandbox(transport)
        client_obj = sbx.connect()
        transport.add_json(
            lambda method, url: method == "POST" and url.endswith("/v1/vms/vm_csb/run"),
            200,
            _completed(stdout="f|42|1735776100.0|1735776000.0|1735776200.0\n"),
        )
        info = client_obj.fs.stat("/sandbox/x.txt")
    assert isinstance(info, FSStatResult)
    assert info.type == "file"
    assert info.size == 42
    assert info.mtime == 1735776100.0


def test_fs_mkdir_recursive() -> None:
    transport = FakeTransport()
    with patch("urllib.request.urlopen", transport):
        sbx = _create_sandbox(transport)
        client_obj = sbx.connect()
        transport.add_json(
            lambda method, url: method == "POST" and url.endswith("/v1/vms/vm_csb/run"),
            200,
            _completed(),
        )
        client_obj.fs.mkdir("/sandbox/deep", recursive=True)
        body = json.loads(transport.calls[-1]["body"])
    assert body["command"] == "mkdir -p /sandbox/deep"


def test_fs_remove_recursive() -> None:
    transport = FakeTransport()
    with patch("urllib.request.urlopen", transport):
        sbx = _create_sandbox(transport)
        client_obj = sbx.connect()
        transport.add_json(
            lambda method, url: method == "POST" and url.endswith("/v1/vms/vm_csb/run"),
            200,
            _completed(),
        )
        client_obj.fs.remove("/sandbox/junk", recursive=True)
        body = json.loads(transport.calls[-1]["body"])
    assert body["command"] == "rm -rf /sandbox/junk"


def test_fs_rename_uses_mv() -> None:
    transport = FakeTransport()
    with patch("urllib.request.urlopen", transport):
        sbx = _create_sandbox(transport)
        client_obj = sbx.connect()
        transport.add_json(
            lambda method, url: method == "POST" and url.endswith("/v1/vms/vm_csb/run"),
            200,
            _completed(),
        )
        client_obj.fs.rename("/a", "/b")
        body = json.loads(transport.calls[-1]["body"])
    assert body["command"] == "mv /a /b"


def test_fs_copy_uses_cp() -> None:
    transport = FakeTransport()
    with patch("urllib.request.urlopen", transport):
        sbx = _create_sandbox(transport)
        client_obj = sbx.connect()
        transport.add_json(
            lambda method, url: method == "POST" and url.endswith("/v1/vms/vm_csb/run"),
            200,
            _completed(),
        )
        client_obj.fs.copy("/src", "/dst", recursive=True)
        body = json.loads(transport.calls[-1]["body"])
    assert body["command"] == "cp -r /src /dst"


def test_fs_watch_raises_not_implemented() -> None:
    transport = FakeTransport()
    with patch("urllib.request.urlopen", transport):
        sbx = _create_sandbox(transport)
        client_obj = sbx.connect()
        with pytest.raises(NotImplementedError, match="fs.watch"):
            client_obj.fs.watch("/tmp")


def test_fs_download_raises_not_implemented() -> None:
    transport = FakeTransport()
    with patch("urllib.request.urlopen", transport):
        sbx = _create_sandbox(transport)
        client_obj = sbx.connect()
        with pytest.raises(NotImplementedError, match="fs.download"):
            client_obj.fs.download("/tmp/x")


# ----- Unsupported namespaces -----

def test_shells_namespace_raises() -> None:
    transport = FakeTransport()
    with patch("urllib.request.urlopen", transport):
        sbx = _create_sandbox(transport)
        client_obj = sbx.connect()
        with pytest.raises(NotImplementedError, match="shells"):
            client_obj.shells.run("ls")


def test_tasks_namespace_raises() -> None:
    transport = FakeTransport()
    with patch("urllib.request.urlopen", transport):
        sbx = _create_sandbox(transport)
        client_obj = sbx.connect()
        with pytest.raises(NotImplementedError, match="tasks"):
            client_obj.tasks.run("build")


def test_ports_namespace_raises() -> None:
    transport = FakeTransport()
    with patch("urllib.request.urlopen", transport):
        sbx = _create_sandbox(transport)
        client_obj = sbx.connect()
        with pytest.raises(NotImplementedError, match="ports"):
            client_obj.ports.list()


def test_hosts_on_client_raises() -> None:
    csb = CodeSandbox(api_token="x", _arker=client())
    with pytest.raises(NotImplementedError, match="hosts"):
        csb.hosts.token()
