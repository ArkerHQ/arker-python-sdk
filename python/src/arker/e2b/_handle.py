"""`CommandHandle` — return type of `commands.run(..., background=True)`.

Wraps an Arker background run_id behind the e2b CommandHandle API:
`.pid`, `.wait()`, `.kill()`, `.disconnect()`, `__iter__`.

TODO(arker-e2b): true per-line `on_stdout` / `on_stderr` streaming.
Today `wait()` and `__iter__` poll `run_status` and emit whatever delta
arrived since the last poll — coarser than e2b's per-line WS push. Real
streaming uses the `ws_url` Arker already returns; needs a WS client
in core SDK. See pending-work item #3 in __init__.py.
"""

from __future__ import annotations

import logging
import time
from typing import TYPE_CHECKING, Callable, Iterator

from ..computer import RunStatusResponse
from ._types import CommandExitException, CommandResult

if TYPE_CHECKING:
    from ._sandbox import Sandbox

logger = logging.getLogger("arker.e2b")

POLL_BASE_S = 0.2
POLL_MAX_S = 1.0


def _status_to_command_result(status: RunStatusResponse) -> CommandResult:
    return CommandResult(
        stdout=status.stdout.decode("utf-8", errors="replace"),
        stderr=status.stderr.decode("utf-8", errors="replace"),
        exit_code=status.exit_code if status.exit_code is not None else -1,
    )


def _next_delay(last: float) -> float:
    return min(POLL_MAX_S, max(POLL_BASE_S, last * 1.5))


class CommandHandle:
    def __init__(self, sandbox: "Sandbox", pid: int, run_id: str, cmd: str) -> None:
        self._sandbox = sandbox
        self._pid = pid
        self._run_id = run_id
        self._cmd = cmd
        self._stdout_emitted = 0
        self._stderr_emitted = 0

    @property
    def pid(self) -> int:
        return self._pid

    def wait(
        self,
        on_stdout: Callable[[str], None] | None = None,
        on_stderr: Callable[[str], None] | None = None,
        on_pty: Callable | None = None,
    ) -> CommandResult:
        """Block until the run finishes; fire callbacks for delta chunks."""
        delay = POLL_BASE_S
        last_status: RunStatusResponse | None = None
        while True:
            status = self._sandbox._computer.run_status(self._run_id)
            self._fire_deltas(status, on_stdout, on_stderr)
            if status.completed:
                last_status = status
                break
            time.sleep(delay)
            delay = _next_delay(delay)

        result = _status_to_command_result(last_status)
        if result.exit_code != 0:
            raise CommandExitException(result)
        return result

    def kill(self) -> bool:
        try:
            return bool(self._sandbox._computer.cancel_run(self._run_id).cancelled)
        finally:
            self._sandbox._forget_pid(self._pid)

    def disconnect(self) -> None:
        self._sandbox._forget_pid(self._pid)

    def __iter__(self) -> Iterator[str]:
        """Yield stdout deltas until the run completes."""
        delay = POLL_BASE_S
        while True:
            status = self._sandbox._computer.run_status(self._run_id)
            new_stdout = status.stdout[self._stdout_emitted :]
            if new_stdout:
                self._stdout_emitted = len(status.stdout)
                yield new_stdout.decode("utf-8", errors="replace")
            if status.completed:
                return
            time.sleep(delay)
            delay = _next_delay(delay)

    def _fire_deltas(
        self,
        status: RunStatusResponse,
        on_stdout: Callable[[str], None] | None,
        on_stderr: Callable[[str], None] | None,
    ) -> None:
        if on_stdout:
            new_out = status.stdout[self._stdout_emitted :]
            if new_out:
                on_stdout(new_out.decode("utf-8", errors="replace"))
        if on_stderr:
            new_err = status.stderr[self._stderr_emitted :]
            if new_err:
                on_stderr(new_err.decode("utf-8", errors="replace"))
        self._stdout_emitted = len(status.stdout)
        self._stderr_emitted = len(status.stderr)
