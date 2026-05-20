"""`sandbox.process` namespace — Phase A: exec + code_run."""

from __future__ import annotations

import secrets
import shlex
from typing import TYPE_CHECKING

from ..computer import ArkerError, BackgroundRunResult, CompletedRunResult
from ._types import (
    CodeRunParams,
    Command,
    ExecuteResponse,
    ExecutionArtifacts,
    ProcessError,
    Session,
    SessionCommandLogsResponse,
    SessionExecuteRequest,
    SessionExecuteResponse,
    SessionNotFoundError,
)

if TYPE_CHECKING:
    from ._sandbox import Sandbox


_LANGUAGE_RUNTIME = {
    "python": ("python3", "py"),
    "python3": ("python3", "py"),
    "javascript": ("node", "js"),
    "js": ("node", "js"),
    "node": ("node", "js"),
    "ts": ("ts-node", "ts"),
    "typescript": ("ts-node", "ts"),
    "bash": ("bash", "sh"),
    "sh": ("bash", "sh"),
    "ruby": ("ruby", "rb"),
}


def _wrap_command(cmd: str, cwd: str | None, env: dict[str, str] | None) -> str:
    """Inline cwd + env overrides into a shell command. Mirrors arker.e2b's
    wrap_command — duplicated locally so the shims don't cross-import."""
    parts: list[str] = []
    if cwd:
        parts.append(f"cd {shlex.quote(cwd)} &&")
    if env:
        parts.append("env")
        for key, value in env.items():
            parts.append(f"{shlex.quote(str(key))}={shlex.quote(str(value))}")
    parts.append(cmd)
    return " ".join(parts)


class Process:
    def __init__(self, sandbox: "Sandbox") -> None:
        self._sandbox = sandbox
        # Tracked session_ids (Arker creates them implicitly on first run;
        # we mirror state locally for list/get/delete semantics).
        self._sessions: dict[str, dict] = {}  # sid -> {"created_at": ..., "commands": list[Command]}
        # Foreground command-log cache: cmd_id -> SessionCommandLogsResponse
        self._command_logs: dict[str, SessionCommandLogsResponse] = {}

    def exec(
        self,
        command: str,
        *,
        cwd: str | None = None,
        env: dict[str, str] | None = None,
        timeout: int | None = None,
    ) -> ExecuteResponse:
        merged_env = {**self._sandbox._env, **(env or {})}
        wrapped = _wrap_command(command, cwd, merged_env)
        result = self._sandbox._computer.run(wrapped, timeout=timeout)
        if not isinstance(result, CompletedRunResult):
            raise ProcessError(f"unexpected run type {type(result).__name__}")
        stdout = result.stdout.decode("utf-8", errors="replace")
        return ExecuteResponse(
            exit_code=result.exit_code,
            result=stdout,
            artifacts=ExecutionArtifacts(stdout=stdout, charts=None),
        )

    # ---- Sessions (stateful shell) ----

    def create_session(self, session_id: str) -> None:
        """Register a session. Arker creates the underlying session implicitly
        on first `run(..., session_id=sid)`; this just tracks our intent so
        list/get/delete have something to return."""
        self._sessions.setdefault(session_id, {"commands": []})

    def list_sessions(self) -> list[Session]:
        """Best-effort: returns sessions Arker reports + any we tracked
        locally that haven't shown up on the VM yet."""
        try:
            remote = {s.session_id: s for s in self._sandbox._arker.get(self._sandbox._computer.id).sessions}
        except ArkerError:
            remote = {}
        out: list[Session] = []
        for sid in {*remote.keys(), *self._sessions.keys()}:
            r = remote.get(sid)
            commands = [Command(**c) if isinstance(c, dict) else c for c in self._sessions.get(sid, {}).get("commands", [])]
            out.append(Session(
                session_id=sid,
                state=r.state if r else "unknown",
                cwd=r.cwd if r else "/home/user",
                commands=commands,
            ))
        return out

    def get_session(self, session_id: str) -> Session:
        for s in self.list_sessions():
            if s.session_id == session_id:
                return s
        raise SessionNotFoundError(f"session {session_id!r} not found")

    def delete_session(self, session_id: str) -> None:
        """Local-only — Arker's session-delete (`DELETE /v1/vms/{id}/sessions/{sid}`)
        isn't exposed by the SDK yet (same situation as e2b's PTY kill).
        TODO(arker-daytona): wire to session-delete when SDK supports it.
        """
        self._sessions.pop(session_id, None)

    def execute_session_command(
        self,
        session_id: str,
        req: SessionExecuteRequest,
        timeout: int | None = None,
    ) -> SessionExecuteResponse:
        wrapped = _wrap_command(req.command, req.cwd, req.env)
        self._sessions.setdefault(session_id, {"commands": []})

        if req.runAsync:
            result = self._sandbox._computer.run(
                wrapped, background=True, session_id=session_id, timeout=timeout,
            )
            if not isinstance(result, BackgroundRunResult):
                raise ProcessError(f"async session run returned {type(result).__name__}")
            cmd_id = result.run_id
            self._sessions[session_id]["commands"].append(Command(id=cmd_id, command=req.command, exit_code=None))
            return SessionExecuteResponse(cmd_id=cmd_id, output=None, exit_code=None)

        result = self._sandbox._computer.run(wrapped, session_id=session_id, timeout=timeout)
        if not isinstance(result, CompletedRunResult):
            raise ProcessError(f"sync session run returned {type(result).__name__}")
        cmd_id = secrets.token_hex(8)
        stdout = result.stdout.decode("utf-8", errors="replace")
        stderr = result.stderr.decode("utf-8", errors="replace")
        self._command_logs[cmd_id] = SessionCommandLogsResponse(
            stdout=stdout, stderr=stderr, exit_code=result.exit_code,
        )
        self._sessions[session_id]["commands"].append(
            Command(id=cmd_id, command=req.command, exit_code=result.exit_code),
        )
        return SessionExecuteResponse(cmd_id=cmd_id, output=stdout, exit_code=result.exit_code)

    def get_session_command(self, session_id: str, command_id: str) -> Command:
        sess = self._sessions.get(session_id)
        if not sess:
            raise SessionNotFoundError(f"session {session_id!r} not found")
        for c in sess["commands"]:
            if c.id == command_id:
                return c
        raise SessionNotFoundError(f"command {command_id!r} not found in session {session_id!r}")

    def get_session_command_logs(self, session_id: str, command_id: str) -> SessionCommandLogsResponse:
        """For foreground runs, returns the cached output captured at run
        time. For background runs, polls `run_status` for the latest state."""
        cached = self._command_logs.get(command_id)
        if cached is not None:
            return cached
        # Background path: command_id == run_id; poll run_status once and cache
        # the snapshot. Repeated calls will re-poll for fresh state.
        try:
            status = self._sandbox._computer.run_status(command_id)
        except ArkerError as error:
            raise SessionNotFoundError(f"command {command_id!r} not found: {error.message}") from error
        return SessionCommandLogsResponse(
            stdout=status.stdout.decode("utf-8", errors="replace"),
            stderr=status.stderr.decode("utf-8", errors="replace"),
            exit_code=status.exit_code,
        )

    # ---- Not implemented in Phase C ----

    def get_entrypoint_session(self) -> Session:
        raise NotImplementedError(
            "arker.daytona: process.get_entrypoint_session is not implemented — "
            "Arker has no entrypoint-session concept; use create_session + execute_session_command."
        )

    def get_entrypoint_logs(self) -> SessionCommandLogsResponse:
        raise NotImplementedError(
            "arker.daytona: process.get_entrypoint_logs is not implemented (no entrypoint session)."
        )

    def get_entrypoint_logs_async(self, *args, **kwargs) -> None:
        raise NotImplementedError(
            "arker.daytona: process.get_entrypoint_logs_async is not implemented (no entrypoint session, no streaming)."
        )

    def get_session_command_logs_async(self, *args, **kwargs) -> None:
        # TODO(arker-daytona): wire to WS streaming when core SDK supports it.
        raise NotImplementedError(
            "arker.daytona: process.get_session_command_logs_async is not implemented — "
            "live streaming needs WS; poll get_session_command_logs instead."
        )

    def send_session_command_input(self, session_id: str, command_id: str, data: str) -> None:
        # TODO(arker-daytona): needs non-PTY stdin primitive (same gap as e2b).
        raise NotImplementedError(
            "arker.daytona: process.send_session_command_input is not implemented — "
            "Arker has no non-PTY stdin primitive."
        )

    # ---- PTY sessions: deferred to Phase D (all throw) ----

    _PTY_MSG = (
        "arker.daytona: PTY sessions require a WebSocket client we haven't "
        "shipped yet. See pending notes in __init__.py."
    )

    def create_pty_session(self, *args, **kwargs):
        raise NotImplementedError(self._PTY_MSG)

    def connect_pty_session(self, *args, **kwargs):
        raise NotImplementedError(self._PTY_MSG)

    def list_pty_sessions(self):
        raise NotImplementedError(self._PTY_MSG)

    def get_pty_session_info(self, *args, **kwargs):
        raise NotImplementedError(self._PTY_MSG)

    def kill_pty_session(self, *args, **kwargs):
        raise NotImplementedError(self._PTY_MSG)

    def resize_pty_session(self, *args, **kwargs):
        raise NotImplementedError(self._PTY_MSG)

    def code_run(
        self,
        code: str,
        params: CodeRunParams | None = None,
        timeout: int | None = None,
    ) -> ExecuteResponse:
        """Run code (default: Python). e2b/daytona expose this as a Jupyter-
        style stateful interpreter; ours is a per-call subprocess. State does
        not persist across calls. See pending #5 in __init__.py.
        """
        interp, ext = _LANGUAGE_RUNTIME["python"]
        scratch = f"/tmp/arker-daytona-{secrets.token_hex(8)}.{ext}"
        self._sandbox._computer.sync.write_file(scratch, code)
        try:
            argv = " ".join(shlex.quote(a) for a in (params.argv if params and params.argv else []))
            extra_env = (params.env if params else None) or {}
            cmd = f"{interp} {shlex.quote(scratch)}"
            if argv:
                cmd = f"{cmd} {argv}"
            return self.exec(cmd, env=extra_env, timeout=timeout)
        finally:
            try:
                self._sandbox._computer.run(f"rm -f {shlex.quote(scratch)}")
            except Exception:
                pass
