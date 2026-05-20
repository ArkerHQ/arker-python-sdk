"""`sandbox.commands` namespace."""

from __future__ import annotations

import logging
import shlex
from typing import TYPE_CHECKING, Callable

from ..computer import BackgroundRunResult, CompletedRunResult
from ._handle import CommandHandle
from ._types import CommandExitException, CommandResult, ProcessInfo

if TYPE_CHECKING:
    from ._sandbox import Sandbox

logger = logging.getLogger("arker.e2b")


def wrap_command(cmd: str, cwd: str | None, envs: dict[str, str] | None) -> str:
    """Build a shell command that applies cwd + env overrides before exec."""
    parts: list[str] = []
    if cwd:
        parts.append(f"cd {shlex.quote(cwd)} &&")
    if envs:
        parts.append("env")
        for key, value in envs.items():
            parts.append(f"{shlex.quote(str(key))}={shlex.quote(str(value))}")
    parts.append(cmd)
    return " ".join(parts)


def decode_stream(data: bytes) -> str:
    return data.decode("utf-8", errors="replace")


class Commands:
    def __init__(self, sandbox: "Sandbox") -> None:
        self._sandbox = sandbox

    def run(
        self,
        cmd: str,
        *,
        timeout: float | None = 60,
        envs: dict[str, str] | None = None,
        cwd: str | None = None,
        user: str = "user",
        on_stdout: Callable[[str], None] | None = None,
        on_stderr: Callable[[str], None] | None = None,
        background: bool = False,
        request_timeout: float | None = None,
    ) -> CommandResult | CommandHandle:
        merged_envs = {**self._sandbox._default_envs, **(envs or {})}
        wrapped = wrap_command(cmd, cwd, merged_envs)
        run_timeout = int(timeout) if timeout is not None else None

        if background:
            result = self._sandbox._computer.run(wrapped, background=True, timeout=run_timeout)
            if not isinstance(result, BackgroundRunResult):
                raise RuntimeError(
                    f"background run returned unexpected type {type(result).__name__}"
                )
            return self._sandbox._register_run(result.run_id, wrapped)

        result = self._sandbox._computer.run(wrapped, timeout=run_timeout)
        if not isinstance(result, CompletedRunResult):
            raise RuntimeError(
                f"foreground run returned unexpected type {type(result).__name__}"
            )

        cmd_result = CommandResult(
            stdout=decode_stream(result.stdout),
            stderr=decode_stream(result.stderr),
            exit_code=result.exit_code,
        )
        if on_stdout and cmd_result.stdout:
            on_stdout(cmd_result.stdout)
        if on_stderr and cmd_result.stderr:
            on_stderr(cmd_result.stderr)

        if cmd_result.exit_code != 0:
            raise CommandExitException(cmd_result)
        return cmd_result

    def list(self, request_timeout: float | None = None) -> list[ProcessInfo]:
        """List background runs created via this Sandbox instance.

        Arker has no server-side process listing for run_ids; this only
        reflects handles created in the current client session.
        """
        return [
            ProcessInfo(pid=pid, tag=str(run_id), cmd=cmd)
            for pid, (run_id, cmd) in self._sandbox._bg_runs.items()
        ]

    def kill(self, pid: int, request_timeout: float | None = None) -> bool:
        run_id = self._sandbox._run_id_for(pid)
        if run_id is None:
            return False
        try:
            return bool(self._sandbox._computer.cancel_run(run_id).cancelled)
        finally:
            self._sandbox._forget_pid(pid)

    def send_stdin(self, pid: int, data: str, request_timeout: float | None = None) -> None:
        raise NotImplementedError(
            "arker.e2b: commands.send_stdin is not supported — Arker has no "
            "non-PTY stdin primitive. Use a PTY session for interactive input."
        )

    def connect(self, pid: int, timeout: float | None = 60, request_timeout: float | None = None) -> CommandHandle:
        run_id = self._sandbox._run_id_for(pid)
        if run_id is None:
            raise ValueError(f"no background run is registered for pid={pid}")
        cmd = self._sandbox._bg_runs[pid][1]
        return CommandHandle(self._sandbox, pid, run_id, cmd)
