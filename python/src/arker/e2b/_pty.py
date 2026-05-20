"""`sandbox.pty` namespace — Phase D scaffold.

Real interactive PTY requires a WebSocket client (Arker exposes the PTY via
the `ws_url` returned from `run(session_id=…)`). To keep `arker` zero-dep
and stay aligned with the "silent no-op + debug log" policy for surface that
isn't ready, we expose the e2b API shape so existing code paths don't crash:

- `pty.create()` provisions the server-side PTY (real Arker call) and
  returns a CommandHandle wrapping the session_id. The handle is live for
  `kill()` purposes (cancels the run); `wait()` will hang waiting for run
  completion the same way a real PTY does.
- `send_stdin` / `resize` log at DEBUG and return None — input is dropped.
  Real interactive use will require the WS upgrade tracked in the plan's
  open questions.
"""

from __future__ import annotations

import dataclasses
import logging
import secrets
from typing import TYPE_CHECKING

from ..computer import PtyRunResult
from ._handle import CommandHandle

if TYPE_CHECKING:
    from ._sandbox import Sandbox

logger = logging.getLogger("arker.e2b")


@dataclasses.dataclass(frozen=True)
class PtySize:
    rows: int
    cols: int


class Pty:
    def __init__(self, sandbox: "Sandbox") -> None:
        self._sandbox = sandbox

    def create(
        self,
        size: PtySize,
        *,
        user: str = "user",
        cwd: str | None = None,
        envs: dict[str, str] | None = None,
        timeout: float | None = 60,
        request_timeout: float | None = None,
    ) -> CommandHandle:
        session_id = secrets.token_hex(8)
        result = self._sandbox._computer.run(
            "/bin/bash",
            session_id=session_id,
            timeout=int(timeout) if timeout is not None else None,
        )
        if not isinstance(result, PtyRunResult):
            raise RuntimeError(
                f"pty.create expected PtyRunResult, got {type(result).__name__}"
            )
        logger.debug("arker.e2b: pty session %s opened at %s", session_id, result.ws_url)
        return self._sandbox._register_run(session_id, "/bin/bash")

    def send_stdin(self, pid: int, data: bytes, request_timeout: float | None = None) -> None:
        logger.debug("arker.e2b: pty.send_stdin(pid=%s, %d bytes) — WS not wired up yet", pid, len(data))

    def resize(self, pid: int, size: PtySize, request_timeout: float | None = None) -> None:
        logger.debug("arker.e2b: pty.resize(pid=%s, %dx%d) — WS not wired up yet", pid, size.cols, size.rows)

    def kill(self, pid: int, request_timeout: float | None = None) -> bool:
        # Arker PTYs are session-backed (DELETE /v1/vms/{id}/sessions/{sid}),
        # and the core SDK doesn't expose session-delete yet. We forget the
        # local pid so subsequent .connect(pid) is honest about its absence.
        # Real cleanup lands together with WS streaming in the follow-up.
        logger.debug("arker.e2b: pty.kill(pid=%s) — local-only; WS not wired up", pid)
        self._sandbox._forget_pid(pid)
        return True
