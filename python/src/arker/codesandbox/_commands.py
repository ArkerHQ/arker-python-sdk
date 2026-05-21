"""`SandboxClient.commands` namespace."""

from __future__ import annotations

import shlex
from typing import TYPE_CHECKING

from ..computer import ArkerError, BackgroundRunResult, CompletedRunResult
from ._types import Command, CommandError, CommandStatus, translate_arker_error

if TYPE_CHECKING:
    from ._sandbox_client import SandboxClient


def _wrap(cmd: str | list[str], cwd: str | None, env: dict[str, str] | None) -> str:
    parts: list[str] = []
    if cwd:
        parts.append(f"cd {shlex.quote(cwd)} &&")
    if env:
        parts.append("env")
        for k, v in env.items():
            parts.append(f"{shlex.quote(str(k))}={shlex.quote(str(v))}")
    if isinstance(cmd, list):
        parts.append(" ".join(shlex.quote(a) for a in cmd))
    else:
        parts.append(cmd)
    return " ".join(parts)


class Commands:
    """Mirrors `@codesandbox/sdk` SandboxClient.commands.

    `run()` blocks until completion and returns the combined output string —
    matches codesandbox's signature `async run(...) -> string`. Non-zero
    exit raises `CommandError`.
    """

    def __init__(self, client: "SandboxClient") -> None:
        self._client = client
        # cmd name -> Command (for getAll() / get())
        self._tracked: dict[str, Command] = {}

    def run(self, command: str | list[str], opts: dict | None = None) -> str:
        """Run a command and return its combined output. Raises CommandError
        on non-zero exit (matches codesandbox)."""
        opts = opts or {}
        wrapped = _wrap(command, opts.get("cwd"), opts.get("env"))
        try:
            result = self._client._sandbox._computer.run(wrapped)
        except ArkerError as error:
            raise translate_arker_error(error) from error
        if not isinstance(result, CompletedRunResult):
            raise CommandError(
                f"unexpected run result type {type(result).__name__}", -1, ""
            )
        stdout = result.stdout.decode("utf-8", errors="replace")
        stderr = result.stderr.decode("utf-8", errors="replace")
        output = stdout + stderr
        if result.exit_code != 0:
            raise CommandError(
                f"command exited with code {result.exit_code}",
                result.exit_code,
                output,
            )
        return output

    def runBackground(self, command: str | list[str], opts: dict | None = None) -> Command:  # noqa: N802
        opts = opts or {}
        wrapped = _wrap(command, opts.get("cwd"), opts.get("env"))
        name = opts.get("name") or f"cmd-{len(self._tracked) + 1}"
        try:
            result = self._client._sandbox._computer.run(wrapped, background=True)
        except ArkerError as error:
            raise translate_arker_error(error) from error
        if not isinstance(result, BackgroundRunResult):
            raise CommandError(
                f"unexpected background run result type {type(result).__name__}",
                -1,
                "",
            )
        cmd_obj = Command(name=name, status=CommandStatus.RUNNING)
        # Stash the run_id on the Command for later polling.
        object.__setattr__(cmd_obj, "_run_id", result.run_id)
        self._tracked[name] = cmd_obj
        return cmd_obj

    # snake_case alias
    run_background = runBackground

    def getAll(self) -> list[Command]:  # noqa: N802
        return list(self._tracked.values())

    get_all = getAll

    def get(self, name: str) -> Command | None:
        return self._tracked.get(name)
