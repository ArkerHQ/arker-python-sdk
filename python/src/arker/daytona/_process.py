"""`sandbox.process` namespace.

Mirrors `daytonaio/daytona`'s Process API. Session commands route through
Arker's `session_id` parameter (sync foreground runs cache their logs
locally so `get_session_command_logs(cmd_id)` works without a server-side
log endpoint).
"""

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
    translate_arker_error,
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
        # we mirror state locally so list/get/delete have something to return).
        self._sessions: dict[str, list[Command]] = {}
        # Foreground command-log cache: cmd_id -> SessionCommandLogsResponse
        self._command_logs: dict[str, SessionCommandLogsResponse] = {}

    def exec(
        self,
        command: str,
        cwd: str | None = None,
        env: dict[str, str] | None = None,
        timeout: int | None = None,
    ) -> ExecuteResponse:
        merged_env = {**self._sandbox._env, **(env or {})}
        wrapped = _wrap_command(command, cwd, merged_env)
        try:
            result = self._sandbox._computer.run(wrapped, timeout=timeout)
        except ArkerError as error:
            raise translate_arker_error(error) from error
        if not isinstance(result, CompletedRunResult):
            raise ProcessError(f"unexpected run type {type(result).__name__}")
        stdout = result.stdout.decode("utf-8", errors="replace")
        return ExecuteResponse(
            exit_code=result.exit_code,
            result=stdout,
            artifacts=ExecutionArtifacts(stdout=stdout, charts=[]),
        )

    # ---- Sessions ----

    def create_session(self, session_id: str) -> None:
        """Register a session. Arker creates the underlying session implicitly
        on first `run(..., session_id=sid)`."""
        self._sessions.setdefault(session_id, [])

    def list_sessions(self) -> list[Session]:
        """Sessions Arker reports + locally-tracked ones."""
        try:
            remote_ids = {s.session_id for s in self._sandbox._arker.get(self._sandbox._computer.id).sessions}
        except ArkerError:
            remote_ids = set()
        sids = {*remote_ids, *self._sessions.keys()}
        return [
            Session(session_id=sid, commands=list(self._sessions.get(sid, [])))
            for sid in sids
        ]

    def get_session(self, session_id: str) -> Session:
        for s in self.list_sessions():
            if s.session_id == session_id:
                return s
        raise SessionNotFoundError(f"session {session_id!r} not found")

    def delete_session(self, session_id: str) -> None:
        """Mirror daytona: raise DaytonaNotFoundError if session doesn't exist.
        TODO(arker-daytona): wire to DELETE /v1/vms/{id}/sessions/{sid} once
        the Arker SDK exposes it; today this is local-bookkeeping only."""
        if session_id not in self._sessions:
            raise SessionNotFoundError(f"session {session_id!r} not found")
        del self._sessions[session_id]

    def execute_session_command(
        self,
        session_id: str,
        req: SessionExecuteRequest,
        timeout: int | None = None,
    ) -> SessionExecuteResponse:
        wrapped = req.command  # daytona's req has no cwd/env — caller inlines.
        self._sessions.setdefault(session_id, [])

        try:
            if req.run_async:
                result = self._sandbox._computer.run(
                    wrapped, background=True, session_id=session_id, timeout=timeout,
                )
            else:
                result = self._sandbox._computer.run(
                    wrapped, session_id=session_id, timeout=timeout,
                )
        except ArkerError as error:
            raise translate_arker_error(error) from error

        if req.run_async:
            if not isinstance(result, BackgroundRunResult):
                raise ProcessError(f"async session run returned {type(result).__name__}")
            cmd_id = result.run_id
            self._sessions[session_id].append(Command(id=cmd_id, command=req.command, exit_code=None))
            # Daytona coerces None → "" so `len(resp.stdout)` doesn't TypeError.
            return SessionExecuteResponse(
                cmd_id=cmd_id,
                exit_code=None,
                output="",
                stdout="",
                stderr="",
            )

        if not isinstance(result, CompletedRunResult):
            raise ProcessError(f"sync session run returned {type(result).__name__}")
        cmd_id = secrets.token_hex(8)
        stdout = result.stdout.decode("utf-8", errors="replace")
        stderr = result.stderr.decode("utf-8", errors="replace")
        # daytona's `output` is a combined stream; we approximate by
        # interleaving stdout then stderr (the real protocol uses 3-byte
        # mux prefixes — out of scope for this shim).
        output = stdout + stderr
        self._command_logs[cmd_id] = SessionCommandLogsResponse(
            output=output, stdout=stdout, stderr=stderr,
        )
        self._sessions[session_id].append(
            Command(id=cmd_id, command=req.command, exit_code=result.exit_code),
        )
        return SessionExecuteResponse(
            cmd_id=cmd_id,
            exit_code=result.exit_code,
            output=output,
            stdout=stdout,
            stderr=stderr,
        )

    def get_session_command(self, session_id: str, command_id: str) -> Command:
        commands = self._sessions.get(session_id)
        if commands is None:
            raise SessionNotFoundError(f"session {session_id!r} not found")
        for c in commands:
            if c.id == command_id:
                return c
        raise SessionNotFoundError(f"command {command_id!r} not found in session {session_id!r}")

    def get_session_command_logs(self, session_id: str, command_id: str) -> SessionCommandLogsResponse:
        """Foreground runs: cached at exec time. Background: poll run_status."""
        cached = self._command_logs.get(command_id)
        if cached is not None:
            return cached
        try:
            status = self._sandbox._computer.run_status(command_id)
        except ArkerError as error:
            raise SessionNotFoundError(f"command {command_id!r} not found: {error.message}") from error
        stdout = status.stdout.decode("utf-8", errors="replace")
        stderr = status.stderr.decode("utf-8", errors="replace")
        return SessionCommandLogsResponse(
            output=stdout + stderr,
            stdout=stdout,
            stderr=stderr,
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
            "arker.daytona: process.get_entrypoint_logs_async is not implemented."
        )

    def get_session_command_logs_async(self, *args, **kwargs) -> None:
        raise NotImplementedError(
            "arker.daytona: process.get_session_command_logs_async is not implemented — "
            "live streaming needs WS; poll get_session_command_logs instead."
        )

    def send_session_command_input(self, session_id: str, command_id: str, data: str) -> None:
        raise NotImplementedError(
            "arker.daytona: process.send_session_command_input is not implemented — "
            "Arker has no non-PTY stdin primitive."
        )

    # ---- PTY sessions: deferred (all throw) ----

    _PTY_MSG = (
        "arker.daytona: PTY sessions require a WebSocket client we haven't "
        "shipped yet."
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

    # ---- code_run (per-call subprocess; no Jupyter state) ----

    def code_run(
        self,
        code: str,
        params: CodeRunParams | None = None,
        timeout: int | None = None,
    ) -> ExecuteResponse:
        interp, ext = _LANGUAGE_RUNTIME["python"]
        scratch = f"/tmp/arker-daytona-{secrets.token_hex(8)}.{ext}"
        try:
            self._sandbox._computer.sync.write_file(scratch, code)
        except ArkerError as error:
            raise translate_arker_error(error) from error
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
