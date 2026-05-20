"""Unit tests for `arker.daytona` Phase A surface.

Reuses the FakeTransport pattern from `test_computer.py` — no live infra.
"""
from __future__ import annotations

import base64
import json
from unittest.mock import patch

import pytest

from arker.daytona import (
    CodeRunParams,
    Daytona,
    DaytonaConfig,
    ExecuteResponse,
    Sandbox,
    SandboxNotFoundError,
    SandboxState,
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


def _make_daytona(transport: FakeTransport) -> Daytona:
    return Daytona(DaytonaConfig(api_key="ark_live_test"), _arker=client())


def _make_sandbox(transport: FakeTransport, vm_id: str = "vm_daytona") -> Sandbox:
    transport.add_json(
        lambda method, url: method == "POST" and url.endswith("/v1/vms/base/fork"),
        200,
        {"vm_id": vm_id, "owner_id": "o", "created_at": "now", "sessions": [session()]},
    )
    d = _make_daytona(transport)
    return d.create()


# ----- Client surface -----

def test_daytona_create_forks_default_template() -> None:
    transport = FakeTransport()
    with patch("urllib.request.urlopen", transport):
        sbx = _make_sandbox(transport)
    assert sbx.id == "vm_daytona"


def test_daytona_get_returns_sandbox() -> None:
    transport = FakeTransport()
    transport.add_json(
        lambda method, url: method == "GET" and url.endswith("/v1/vms/vm_x"),
        200,
        {"vm_id": "vm_x", "owner_id": "o", "created_at": "now", "state": "running", "sessions": [], "source_golden": "base"},
    )
    with patch("urllib.request.urlopen", transport):
        d = _make_daytona(transport)
        sbx = d.get("vm_x")
    assert sbx.id == "vm_x"
    assert sbx.snapshot == "base"


def test_daytona_get_raises_not_found() -> None:
    transport = FakeTransport()
    transport.add_json(
        lambda method, url: method == "GET" and url.endswith("/v1/vms/missing"),
        404,
        {"code": "not_found", "message": "no such vm"},
    )
    with patch("urllib.request.urlopen", transport):
        d = _make_daytona(transport)
        with pytest.raises(SandboxNotFoundError):
            d.get("missing")


def test_daytona_list_returns_sandboxes() -> None:
    transport = FakeTransport()
    transport.add_json(
        lambda method, url: method == "GET" and url.endswith("/v1/vms"),
        200,
        {
            "vms": [
                {"vm_id": "vm_a", "owner_id": "o", "created_at": "now", "state": "running", "sessions": [], "source_golden": "base"},
                {"vm_id": "vm_b", "owner_id": "o", "created_at": "now", "state": "running", "sessions": []},
            ],
        },
    )
    with patch("urllib.request.urlopen", transport):
        d = _make_daytona(transport)
        items = d.list()
    assert [s.id for s in items] == ["vm_a", "vm_b"]


def test_daytona_remove_deletes_vm() -> None:
    transport = FakeTransport()
    transport.add_json(
        lambda method, url: method == "DELETE" and url.endswith("/v1/vms/vm_x"),
        200,
        {"deleted": True},
    )
    with patch("urllib.request.urlopen", transport):
        d = _make_daytona(transport)
        d.remove("vm_x")


# ----- Process -----

def test_process_exec_returns_execute_response() -> None:
    transport = FakeTransport()
    with patch("urllib.request.urlopen", transport):
        sbx = _make_sandbox(transport)
        transport.add_json(
            lambda method, url: method == "POST" and url.endswith("/v1/vms/vm_daytona/run"),
            200,
            _completed_run(stdout="hi\n"),
        )
        resp = sbx.process.exec("echo hi")
    assert isinstance(resp, ExecuteResponse)
    assert resp.exit_code == 0
    assert resp.result == "hi\n"
    assert resp.artifacts is not None
    assert resp.artifacts.stdout == "hi\n"


def test_process_exec_inlines_cwd_and_env() -> None:
    transport = FakeTransport()
    with patch("urllib.request.urlopen", transport):
        sbx = _make_sandbox(transport)
        transport.add_json(
            lambda method, url: method == "POST" and url.endswith("/v1/vms/vm_daytona/run"),
            200,
            _completed_run(stdout="ok"),
        )
        sbx.process.exec("ls", cwd="/srv", env={"X": "1"})
        body = json.loads(transport.calls[-1]["body"])
    # shlex.quote only adds quotes around values with shell-meaningful chars;
    # plain alphanumerics pass through unquoted.
    assert "cd /srv &&" in body["command"]
    assert "env X=1" in body["command"]


def test_process_code_run_executes_python() -> None:
    transport = FakeTransport()
    with patch("urllib.request.urlopen", transport):
        sbx = _make_sandbox(transport)
        # write code to /tmp/...
        transport.add_json(
            lambda method, url: method == "POST" and url.endswith("/v1/vms/vm_daytona/sync"),
            200,
            {"results": [{"complete": True, "written": True}]},
        )
        # python3 /tmp/...
        transport.add_json(
            lambda method, url: method == "POST" and url.endswith("/v1/vms/vm_daytona/run"),
            200,
            _completed_run(stdout="4\n"),
        )
        # cleanup rm
        transport.add_json(
            lambda method, url: method == "POST" and url.endswith("/v1/vms/vm_daytona/run"),
            200,
            _completed_run(),
        )
        resp = sbx.process.code_run("print(2+2)")

    assert resp.result == "4\n"
    assert resp.exit_code == 0


def test_process_code_run_threads_argv_and_env() -> None:
    transport = FakeTransport()
    with patch("urllib.request.urlopen", transport):
        sbx = _make_sandbox(transport)
        transport.add_json(
            lambda method, url: method == "POST" and url.endswith("/v1/vms/vm_daytona/sync"),
            200,
            {"results": [{"complete": True, "written": True}]},
        )
        transport.add_json(
            lambda method, url: method == "POST" and url.endswith("/v1/vms/vm_daytona/run"),
            200,
            _completed_run(),
        )
        transport.add_json(
            lambda method, url: method == "POST" and url.endswith("/v1/vms/vm_daytona/run"),
            200,
            _completed_run(),
        )
        sbx.process.code_run("print(1)", params=CodeRunParams(argv=["a", "b"], env={"K": "V"}))
        body = json.loads(transport.calls[-2]["body"])
    assert "env K=V" in body["command"]
    assert body["command"].endswith(" a b")


# ----- Filesystem -----

def test_fs_upload_bytes_writes_to_remote() -> None:
    transport = FakeTransport()
    with patch("urllib.request.urlopen", transport):
        sbx = _make_sandbox(transport)
        transport.add_json(
            lambda method, url: method == "POST" and url.endswith("/v1/vms/vm_daytona/sync"),
            200,
            {"results": [{"complete": True, "written": True}]},
        )
        sbx.fs.upload_file(b"payload", "/tmp/y.bin")


def test_fs_download_returns_bytes() -> None:
    transport = FakeTransport()
    with patch("urllib.request.urlopen", transport):
        sbx = _make_sandbox(transport)
        transport.add_json(
            lambda method, url: method == "POST" and url.endswith("/v1/vms/vm_daytona/sync"),
            200,
            {"content": _b64("hello"), "encoding": "base64"},
        )
        data = sbx.fs.download_file("/tmp/x")
    assert data == b"hello"


def test_fs_download_to_local_path(tmp_path) -> None:
    transport = FakeTransport()
    with patch("urllib.request.urlopen", transport):
        sbx = _make_sandbox(transport)
        transport.add_json(
            lambda method, url: method == "POST" and url.endswith("/v1/vms/vm_daytona/sync"),
            200,
            {"content": _b64("hello"), "encoding": "base64"},
        )
        target = tmp_path / "out.bin"
        result = sbx.fs.download_file("/tmp/x", str(target))
    assert result is None
    assert target.read_bytes() == b"hello"


# ----- Sandbox lifecycle / state -----

def test_sandbox_state_reflects_vm_state() -> None:
    transport = FakeTransport()
    with patch("urllib.request.urlopen", transport):
        sbx = _make_sandbox(transport)
        transport.add_json(
            lambda method, url: method == "GET" and url.endswith("/v1/vms/vm_daytona"),
            200,
            {"vm_id": "vm_daytona", "owner_id": "o", "created_at": "now", "state": "running", "sessions": []},
        )
        assert sbx.state == SandboxState.STARTED


def test_sandbox_set_labels_is_local() -> None:
    transport = FakeTransport()
    with patch("urllib.request.urlopen", transport):
        sbx = _make_sandbox(transport)
        before = len(transport.calls)
        out = sbx.set_labels({"env": "test"})
        assert len(transport.calls) == before
    assert out == {"env": "test"}
    assert sbx.labels == {"env": "test"}


def test_sandbox_start_stop_are_noops() -> None:
    transport = FakeTransport()
    with patch("urllib.request.urlopen", transport):
        sbx = _make_sandbox(transport)
        before = len(transport.calls)
        sbx.start()
        sbx.stop()
        sbx.archive()
        assert len(transport.calls) == before


def test_sandbox_context_manager_deletes_on_exit() -> None:
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
        d = _make_daytona(transport)
        with d.create() as sbx:
            assert sbx.id == "vm_ctx"
        assert any(c["method"] == "DELETE" and c["url"].endswith("/vm_ctx") for c in transport.calls)


def test_sandbox_delete_swallows_arker_errors() -> None:
    transport = FakeTransport()
    with patch("urllib.request.urlopen", transport):
        sbx = _make_sandbox(transport)
        transport.add_json(
            lambda method, url: method == "DELETE" and url.endswith("/v1/vms/vm_daytona"),
            500,
            {"code": "internal", "message": "boom"},
        )
        # Should not raise; daytona's delete is fire-and-forget.
        sbx.delete()
