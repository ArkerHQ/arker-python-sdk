"""`ContainerProcess` — return type of `sandbox.exec()`.

Mirrors modal's `ContainerProcess`: `.wait()`, `.poll()`, `.kill()`,
`.returncode`, and `.stdout` / `.stderr` / `.stdin` stream handles.
Backed by an Arker background run (`run(..., background=True)`).
"""

from __future__ import annotations

import time
from typing import TYPE_CHECKING, Iterator

from ..computer import ArkerError
from ._types import SandboxError, translate_arker_error

if TYPE_CHECKING:
    from ._sandbox import Sandbox


POLL_BASE_S = 0.2
POLL_MAX_S = 1.0


def _next_delay(last: float) -> float:
    return min(POLL_MAX_S, max(POLL_BASE_S, last * 1.5))


class StreamReader:
    """Mirrors `modal.io_streams.StreamReader`. The real one is async + line-
    oriented over gRPC; ours is a thin polling wrapper over Arker `run_status`.

    `read()` blocks until the process finishes and returns the full output.
    Iterating yields output lines as they appear (poll-based, not real-time).
    """

    def __init__(self, process: "ContainerProcess", which: str, text: bool = True) -> None:
        self._process = process
        self._which = which  # "stdout" or "stderr"
        self._text = text
        self._cursor = 0

    def read(self) -> str | bytes:
        """Block until the process finishes; return the full stream output."""
        self._process.wait()
        data = self._process._snapshot()[self._which]
        return data if not self._text else data.decode("utf-8", errors="replace")

    def __iter__(self) -> Iterator[str | bytes]:
        """Poll-yield lines as the underlying run produces them."""
        delay = POLL_BASE_S
        buffer = b""
        while True:
            snap = self._process._snapshot()
            new = snap[self._which][self._cursor:]
            self._cursor = len(snap[self._which])
            if new:
                buffer += new
                while b"\n" in buffer:
                    line, _, buffer = buffer.partition(b"\n")
                    line += b"\n"
                    yield line.decode("utf-8", errors="replace") if self._text else line
            if snap["completed"]:
                if buffer:
                    yield buffer.decode("utf-8", errors="replace") if self._text else buffer
                return
            time.sleep(delay)
            delay = _next_delay(delay)


class StreamWriter:
    """Placeholder for `sandbox.stdin`. Arker has no non-PTY stdin primitive,
    so writes raise (loud over silent). Real PTY stdin needs WS — out of scope."""

    def __init__(self, _process: "ContainerProcess") -> None:
        pass

    def write(self, _data: bytes) -> None:
        raise NotImplementedError(
            "arker.modal: ContainerProcess.stdin.write is not supported — "
            "Arker has no non-PTY stdin primitive."
        )

    def drain(self) -> None:
        raise NotImplementedError(
            "arker.modal: ContainerProcess.stdin.drain is not supported."
        )

    def write_eof(self) -> None:
        raise NotImplementedError(
            "arker.modal: ContainerProcess.stdin.write_eof is not supported."
        )


class ContainerProcess:
    def __init__(self, sandbox: "Sandbox", run_id: str, text: bool = True) -> None:
        self._sandbox = sandbox
        self._run_id = run_id
        self._text = text
        self._returncode: int | None = None
        self._final_stdout: bytes = b""
        self._final_stderr: bytes = b""
        self.stdout = StreamReader(self, "stdout", text=text)
        self.stderr = StreamReader(self, "stderr", text=text)
        self.stdin = StreamWriter(self)

    @property
    def returncode(self) -> int | None:
        return self._returncode

    def poll(self) -> int | None:
        """Non-blocking returncode check. Returns None if still running."""
        if self._returncode is not None:
            return self._returncode
        try:
            status = self._sandbox._computer.run_status(self._run_id)
        except ArkerError as error:
            raise translate_arker_error(error) from error
        self._final_stdout = status.stdout
        self._final_stderr = status.stderr
        if status.completed:
            self._returncode = status.exit_code if status.exit_code is not None else -1
        return self._returncode

    def wait(self) -> int:
        """Block until the process finishes; return the returncode."""
        delay = POLL_BASE_S
        while self.poll() is None:
            time.sleep(delay)
            delay = _next_delay(delay)
        assert self._returncode is not None
        return self._returncode

    def kill(self) -> None:
        """Cancel the underlying run; ignore errors since the process may
        already be gone."""
        try:
            self._sandbox._computer.cancel_run(self._run_id)
        except ArkerError:
            pass

    def terminate(self) -> None:
        """Alias for kill — modal has both names on `ContainerProcess`."""
        self.kill()

    def _snapshot(self) -> dict:
        """Internal: re-poll status and return both streams + completion."""
        if self._returncode is not None:
            return {
                "stdout": self._final_stdout,
                "stderr": self._final_stderr,
                "completed": True,
            }
        try:
            status = self._sandbox._computer.run_status(self._run_id)
        except ArkerError as error:
            raise translate_arker_error(error) from error
        if status.completed and self._returncode is None:
            self._returncode = status.exit_code if status.exit_code is not None else -1
            self._final_stdout = status.stdout
            self._final_stderr = status.stderr
        return {
            "stdout": status.stdout,
            "stderr": status.stderr,
            "completed": status.completed,
        }
