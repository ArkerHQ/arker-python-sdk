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
    FileInfo,
    FileSystemError,
    Match,
    Sandbox,
    SandboxNotFoundError,
    SandboxState,
    SessionExecuteRequest,
    SessionNotFoundError,
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


# ----- Filesystem Phase B (shell-shim) -----

def _add_shell(transport: FakeTransport, vm_id: str, stdout: str = "", stderr: str = "", exit_code: int = 0) -> None:
    transport.add_json(
        lambda method, url: method == "POST" and url.endswith(f"/v1/vms/{vm_id}/run"),
        200,
        _completed_run(stdout=stdout, stderr=stderr, exit_code=exit_code),
    )


def test_fs_list_files_parses_find_output() -> None:
    transport = FakeTransport()
    with patch("urllib.request.urlopen", transport):
        sbx = _make_sandbox(transport)
        _add_shell(
            transport,
            "vm_daytona",
            stdout="readme.txt|f|42|644|alice|users|1735776000.0\nsrc|d|4096|755|alice|users|1735776100.0\n",
        )
        entries = sbx.fs.list_files("/work")

    assert [(e.name, e.is_dir, e.size, e.owner) for e in entries] == [
        ("readme.txt", False, 42, "alice"),
        ("src", True, 4096, "alice"),
    ]
    assert entries[1].mode == 0o755


def test_fs_create_folder_invokes_mkdir() -> None:
    transport = FakeTransport()
    with patch("urllib.request.urlopen", transport):
        sbx = _make_sandbox(transport)
        _add_shell(transport, "vm_daytona")
        sbx.fs.create_folder("/work/new", mode="700")
        body = json.loads(transport.calls[-1]["body"])
    assert body["command"] == "mkdir -m 700 -p /work/new"


def test_fs_create_folder_raises_on_failure() -> None:
    transport = FakeTransport()
    with patch("urllib.request.urlopen", transport):
        sbx = _make_sandbox(transport)
        _add_shell(transport, "vm_daytona", stderr="permission denied", exit_code=1)
        with pytest.raises(FileSystemError, match="create_folder"):
            sbx.fs.create_folder("/no/way")


def test_fs_delete_file_recursive_uses_rf() -> None:
    transport = FakeTransport()
    with patch("urllib.request.urlopen", transport):
        sbx = _make_sandbox(transport)
        _add_shell(transport, "vm_daytona")
        sbx.fs.delete_file("/work/junk", recursive=True)
        body = json.loads(transport.calls[-1]["body"])
    assert body["command"] == "rm -rf /work/junk"


def test_fs_delete_file_non_recursive_uses_f() -> None:
    transport = FakeTransport()
    with patch("urllib.request.urlopen", transport):
        sbx = _make_sandbox(transport)
        _add_shell(transport, "vm_daytona")
        sbx.fs.delete_file("/work/x.txt")
        body = json.loads(transport.calls[-1]["body"])
    assert body["command"] == "rm -f /work/x.txt"


def test_fs_get_file_info_returns_parsed() -> None:
    transport = FakeTransport()
    with patch("urllib.request.urlopen", transport):
        sbx = _make_sandbox(transport)
        _add_shell(
            transport,
            "vm_daytona",
            stdout="x.txt|f|10|644|alice|users|1735776000.0\n",
        )
        info = sbx.fs.get_file_info("/work/x.txt")
    assert isinstance(info, FileInfo)
    assert info.name == "x.txt"
    assert info.size == 10
    assert info.is_dir is False


def test_fs_get_file_info_raises_when_missing() -> None:
    transport = FakeTransport()
    with patch("urllib.request.urlopen", transport):
        sbx = _make_sandbox(transport)
        _add_shell(transport, "vm_daytona", stderr="No such", exit_code=1)
        with pytest.raises(FileSystemError):
            sbx.fs.get_file_info("/nope")


def test_fs_move_files_invokes_mv() -> None:
    transport = FakeTransport()
    with patch("urllib.request.urlopen", transport):
        sbx = _make_sandbox(transport)
        _add_shell(transport, "vm_daytona")
        sbx.fs.move_files("/a/b", "/c/d")
        body = json.loads(transport.calls[-1]["body"])
    assert body["command"] == "mv /a/b /c/d"


def test_fs_find_files_parses_grep_output() -> None:
    transport = FakeTransport()
    with patch("urllib.request.urlopen", transport):
        sbx = _make_sandbox(transport)
        _add_shell(
            transport,
            "vm_daytona",
            stdout="/work/a.py:3:def foo():\n/work/b.py:17:def foo_bar():\n",
        )
        matches = sbx.fs.find_files("/work", "def foo")

    assert matches == [
        Match(file="/work/a.py", line=3, content="def foo():"),
        Match(file="/work/b.py", line=17, content="def foo_bar():"),
    ]


def test_fs_find_files_returns_empty_on_no_match() -> None:
    transport = FakeTransport()
    with patch("urllib.request.urlopen", transport):
        sbx = _make_sandbox(transport)
        # grep exit code 1 = no matches; we treat as not-an-error
        _add_shell(transport, "vm_daytona", exit_code=1)
        assert sbx.fs.find_files("/work", "xyz") == []


def test_fs_set_file_permissions_mode_only() -> None:
    transport = FakeTransport()
    with patch("urllib.request.urlopen", transport):
        sbx = _make_sandbox(transport)
        _add_shell(transport, "vm_daytona")
        sbx.fs.set_file_permissions("/work/x", mode="755")
        body = json.loads(transport.calls[-1]["body"])
    assert body["command"] == "chmod 755 /work/x"


def test_fs_set_file_permissions_owner_and_group() -> None:
    transport = FakeTransport()
    with patch("urllib.request.urlopen", transport):
        sbx = _make_sandbox(transport)
        _add_shell(transport, "vm_daytona")  # chmod
        _add_shell(transport, "vm_daytona")  # chown
        sbx.fs.set_file_permissions("/work/x", mode="600", owner="alice", group="staff")
        body_chmod = json.loads(transport.calls[-2]["body"])
        body_chown = json.loads(transport.calls[-1]["body"])
    assert body_chmod["command"] == "chmod 600 /work/x"
    assert body_chown["command"] == "chown alice:staff /work/x"


def test_fs_unsupported_ops_raise_not_implemented() -> None:
    transport = FakeTransport()
    with patch("urllib.request.urlopen", transport):
        sbx = _make_sandbox(transport)
        with pytest.raises(NotImplementedError, match="search_files"):
            sbx.fs.search_files("/work", "x")
        with pytest.raises(NotImplementedError, match="replace_in_files"):
            sbx.fs.replace_in_files(["/x"], "a", "b")
        with pytest.raises(NotImplementedError, match="upload_files"):
            sbx.fs.upload_files([])
        with pytest.raises(NotImplementedError, match="upload_file_stream"):
            sbx.fs.upload_file_stream(b"", "/x")
        with pytest.raises(NotImplementedError, match="download_file_stream"):
            sbx.fs.download_file_stream("/x")
        with pytest.raises(NotImplementedError, match="download_files"):
            sbx.fs.download_files([])


# ----- Process sessions (Phase C) -----


def test_session_create_and_list() -> None:
    transport = FakeTransport()
    with patch("urllib.request.urlopen", transport):
        sbx = _make_sandbox(transport)
        sbx.process.create_session("s1")
        # list_sessions hits the VM for the latest session list:
        transport.add_json(
            lambda method, url: method == "GET" and url.endswith("/v1/vms/vm_daytona"),
            200,
            {"vm_id": "vm_daytona", "owner_id": "o", "created_at": "now", "state": "running",
             "sessions": [{"session_id": "s1", "state": "ready", "cwd": "/home/user"}]},
        )
        sessions = sbx.process.list_sessions()

    sids = {s.session_id for s in sessions}
    assert "s1" in sids
    s1 = next(s for s in sessions if s.session_id == "s1")
    assert s1.state == "ready"
    assert s1.cwd == "/home/user"


def test_session_get_raises_when_missing() -> None:
    transport = FakeTransport()
    with patch("urllib.request.urlopen", transport):
        sbx = _make_sandbox(transport)
        transport.add_json(
            lambda method, url: method == "GET" and url.endswith("/v1/vms/vm_daytona"),
            200,
            {"vm_id": "vm_daytona", "owner_id": "o", "created_at": "now", "state": "running", "sessions": []},
        )
        with pytest.raises(SessionNotFoundError):
            sbx.process.get_session("missing")


def test_session_execute_sync_returns_output_and_caches_logs() -> None:
    transport = FakeTransport()
    with patch("urllib.request.urlopen", transport):
        sbx = _make_sandbox(transport)
        sbx.process.create_session("s1")
        transport.add_json(
            lambda method, url: method == "POST" and url.endswith("/v1/vms/vm_daytona/run"),
            200,
            _completed_run(stdout="ok\n"),
        )
        resp = sbx.process.execute_session_command("s1", SessionExecuteRequest(command="echo ok"))
        body = json.loads(transport.calls[-1]["body"])

    assert resp.output == "ok\n"
    assert resp.exit_code == 0
    assert body.get("session_id") == "s1"

    # Logs are cached for foreground runs — no extra HTTP call.
    before = len(transport.calls)
    logs = sbx.process.get_session_command_logs("s1", resp.cmd_id)
    assert logs.stdout == "ok\n"
    assert len(transport.calls) == before


def test_session_execute_async_returns_cmd_id_without_output() -> None:
    transport = FakeTransport()
    with patch("urllib.request.urlopen", transport):
        sbx = _make_sandbox(transport)
        sbx.process.create_session("s2")
        transport.add_json(
            lambda method, url: method == "POST" and url.endswith("/v1/vms/vm_daytona/run"),
            200,
            {"run_id": "run_async_1", "completed": False, "tunnels": []},
        )
        resp = sbx.process.execute_session_command(
            "s2", SessionExecuteRequest(command="sleep 1", runAsync=True),
        )
    assert resp.cmd_id == "run_async_1"
    assert resp.output is None
    assert resp.exit_code is None


def test_session_get_command_logs_polls_for_async() -> None:
    transport = FakeTransport()
    with patch("urllib.request.urlopen", transport):
        sbx = _make_sandbox(transport)
        sbx.process.create_session("s3")
        # Kick off the async run.
        transport.add_json(
            lambda method, url: method == "POST" and url.endswith("/v1/vms/vm_daytona/run"),
            200,
            {"run_id": "run_async_2", "completed": False, "tunnels": []},
        )
        sbx.process.execute_session_command(
            "s3", SessionExecuteRequest(command="sleep 1", runAsync=True),
        )
        # Then ask for logs — should poll run_status.
        transport.add_json(
            lambda method, url: method == "GET" and "/runs/run_async_2" in url,
            200,
            {
                "run_id": "run_async_2",
                "stdout": _b64("partial"),
                "stdout_encoding": "base64",
                "stderr": _b64(""),
                "stderr_encoding": "base64",
                "exit_code": None,
                "completed": False,
                "tunnels": [],
            },
        )
        logs = sbx.process.get_session_command_logs("s3", "run_async_2")
    assert logs.stdout == "partial"
    assert logs.exit_code is None


def test_session_delete_is_local() -> None:
    transport = FakeTransport()
    with patch("urllib.request.urlopen", transport):
        sbx = _make_sandbox(transport)
        sbx.process.create_session("s4")
        before = len(transport.calls)
        sbx.process.delete_session("s4")
        # No remote DELETE — see TODO in _process.py.
        assert len(transport.calls) == before
        # Subsequent get_session_command should raise.
        with pytest.raises(SessionNotFoundError):
            sbx.process.get_session_command("s4", "any")


def test_session_async_command_recorded_in_session_commands() -> None:
    transport = FakeTransport()
    with patch("urllib.request.urlopen", transport):
        sbx = _make_sandbox(transport)
        sbx.process.create_session("s5")
        transport.add_json(
            lambda method, url: method == "POST" and url.endswith("/v1/vms/vm_daytona/run"),
            200,
            {"run_id": "run_y", "completed": False, "tunnels": []},
        )
        sbx.process.execute_session_command("s5", SessionExecuteRequest(command="x", runAsync=True))
        cmd = sbx.process.get_session_command("s5", "run_y")
    assert cmd.command == "x"
    assert cmd.id == "run_y"


def test_process_pty_methods_all_raise() -> None:
    transport = FakeTransport()
    with patch("urllib.request.urlopen", transport):
        sbx = _make_sandbox(transport)
        for fn, args in [
            (sbx.process.create_pty_session, ("s", )),
            (sbx.process.connect_pty_session, ("s", )),
            (sbx.process.list_pty_sessions, ()),
            (sbx.process.get_pty_session_info, ("s", )),
            (sbx.process.kill_pty_session, ("s", )),
            (sbx.process.resize_pty_session, ("s", None)),
        ]:
            with pytest.raises(NotImplementedError, match="PTY sessions"):
                fn(*args)


def test_process_entrypoint_methods_raise() -> None:
    transport = FakeTransport()
    with patch("urllib.request.urlopen", transport):
        sbx = _make_sandbox(transport)
        with pytest.raises(NotImplementedError, match="entrypoint"):
            sbx.process.get_entrypoint_session()
        with pytest.raises(NotImplementedError, match="entrypoint"):
            sbx.process.get_entrypoint_logs()


def test_process_send_session_command_input_raises() -> None:
    transport = FakeTransport()
    with patch("urllib.request.urlopen", transport):
        sbx = _make_sandbox(transport)
        with pytest.raises(NotImplementedError, match="send_session_command_input"):
            sbx.process.send_session_command_input("s", "c", "x")


def test_async_daytona_full_round_trip() -> None:
    import asyncio

    from arker.daytona import AsyncDaytona, AsyncSandbox

    transport = FakeTransport()
    transport.add_json(
        lambda method, url: method == "POST" and url.endswith("/v1/vms/base/fork"),
        200,
        {"vm_id": "vm_async", "owner_id": "o", "created_at": "now", "sessions": [session()]},
    )
    transport.add_json(
        lambda method, url: method == "POST" and url.endswith("/v1/vms/vm_async/run"),
        200,
        _completed_run(stdout="hi\n"),
    )
    transport.add_json(
        lambda method, url: method == "DELETE" and url.endswith("/v1/vms/vm_async"),
        200,
        {"deleted": True},
    )

    sync = Daytona(DaytonaConfig(api_key="ark_live_test"), _arker=client())

    async def run() -> tuple[str, int, str]:
        with patch("urllib.request.urlopen", transport):
            async with AsyncDaytona(_sync=sync) as d:
                async with await d.create() as sbx:
                    assert isinstance(sbx, AsyncSandbox)
                    sid = sbx.id
                    resp = await sbx.process.exec("echo hi")
                    return sid, resp.exit_code, resp.result

    sid, exit_code, output = asyncio.run(run())
    assert sid == "vm_async"
    assert exit_code == 0
    assert output == "hi\n"


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
