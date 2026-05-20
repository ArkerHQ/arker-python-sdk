"""Code-interpreter `Sandbox` — subclass that adds `.run_code()`."""

from __future__ import annotations

import secrets
import shlex
from typing import Callable

from .._sandbox import Sandbox as BaseSandbox
from .._types import CommandExitException
from ._types import Execution, ExecutionError, Logs

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


def _runtime_for(language: str) -> tuple[str, str]:
    return _LANGUAGE_RUNTIME.get(language.lower(), ("python3", "py"))


class Sandbox(BaseSandbox):
    """Drop-in for `e2b_code_interpreter.Sandbox`. Inherits all e2b.Sandbox
    surface (commands, files, pty, kill, etc.) and adds `run_code`."""

    def run_code(
        self,
        code: str,
        *,
        language: str = "python",
        on_stdout: Callable[[str], None] | None = None,
        on_stderr: Callable[[str], None] | None = None,
        on_error: Callable[[ExecutionError], None] | None = None,
        on_result: Callable | None = None,
        envs: dict[str, str] | None = None,
        timeout: float | None = 60,
        request_timeout: float | None = None,
    ) -> Execution:
        interp, ext = _runtime_for(language)
        scratch = f"/tmp/arker-e2b-{secrets.token_hex(8)}.{ext}"
        self._computer.sync.write_file(scratch, code)

        try:
            result = self.commands.run(
                f"{interp} {shlex.quote(scratch)}",
                envs=envs,
                timeout=timeout,
                on_stdout=on_stdout,
                on_stderr=on_stderr,
            )
            error = None
            stdout = result.stdout
            stderr = result.stderr
        except CommandExitException as exit_exc:
            error = ExecutionError(
                name=f"{language}.runtime_error",
                value=exit_exc.result.stderr.strip() or f"exit {exit_exc.result.exit_code}",
                traceback=exit_exc.result.stderr,
            )
            if on_error:
                on_error(error)
            stdout = exit_exc.result.stdout
            stderr = exit_exc.result.stderr
        finally:
            # Best-effort cleanup; failures here are immaterial.
            try:
                self.files.remove(scratch)
            except Exception:
                pass

        return Execution(
            logs=Logs(
                stdout=[stdout] if stdout else [],
                stderr=[stderr] if stderr else [],
            ),
            error=error,
            results=[],
        )
