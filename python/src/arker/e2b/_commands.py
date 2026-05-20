"""`sandbox.commands` namespace — Phase A: foreground-only `run()`."""

from __future__ import annotations

import shlex
from typing import TYPE_CHECKING

from ..computer import CompletedRunResult
from ._types import CommandExitException, CommandResult

if TYPE_CHECKING:
    from ._sandbox import Sandbox


def wrap_command(cmd: str, cwd: str | None, envs: dict[str, str] | None) -> str:
    """Build a shell command that applies cwd + env overrides before exec.

    Shared between `commands.run` and (in later phases) `pty.create` /
    `commands.run(background=True)`. Keeping this in one place keeps the
    e2b → Arker command translation DRY.
    """
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
        on_stdout=None,
        on_stderr=None,
        background: bool = False,
        request_timeout: float | None = None,
    ) -> CommandResult:
        """Run a command (foreground only in Phase A).

        Background runs raise NotImplementedError until Phase B. The signature
        accepts the param so existing e2b call sites parse; we just refuse to
        execute that mode rather than silently dropping the call.
        """
        if background:
            raise NotImplementedError(
                "background=True is not supported until Phase B; use foreground for now"
            )

        merged_envs = {**self._sandbox._default_envs, **(envs or {})}
        wrapped = wrap_command(cmd, cwd, merged_envs)

        result = self._sandbox._computer.run(
            wrapped,
            timeout=int(timeout) if timeout is not None else None,
        )
        if not isinstance(result, CompletedRunResult):
            raise RuntimeError(
                f"foreground run returned unexpected type {type(result).__name__}"
            )

        stdout = decode_stream(result.stdout)
        stderr = decode_stream(result.stderr)
        cmd_result = CommandResult(stdout=stdout, stderr=stderr, exit_code=result.exit_code)

        if on_stdout and stdout:
            on_stdout(stdout)
        if on_stderr and stderr:
            on_stderr(stderr)

        if cmd_result.exit_code != 0:
            raise CommandExitException(cmd_result)
        return cmd_result
