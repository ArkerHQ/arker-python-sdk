"""`sandbox.process` namespace — Phase A: exec + code_run."""

from __future__ import annotations

import secrets
import shlex
from typing import TYPE_CHECKING

from ..computer import CompletedRunResult
from ._types import (
    CodeRunParams,
    ExecuteResponse,
    ExecutionArtifacts,
    ProcessError,
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
