"""`sandbox.pty` namespace.

Interactive PTY requires a WebSocket client (Arker exposes the PTY via the
`ws_url` returned from `run(session_id=…)`), and the SDK has no WS client
yet. All methods raise NotImplementedError until that lands — loud so callers
discover the gap immediately instead of silently dropping input.
"""

from __future__ import annotations

import dataclasses
from typing import TYPE_CHECKING

from ._handle import CommandHandle

if TYPE_CHECKING:
    from ._sandbox import Sandbox


@dataclasses.dataclass(frozen=True)
class PtySize:
    rows: int
    cols: int


class Pty:
    def __init__(self, sandbox: "Sandbox") -> None:
        self._sandbox = sandbox

    _UNSUPPORTED = (
        "arker.e2b.pty is not supported yet — Arker exposes PTY over WebSocket "
        "(`ws_url` on the run response) but the SDK has no WS client. Use "
        "commands.run for non-interactive work, or wait for the WS upgrade."
    )

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
        raise NotImplementedError(self._UNSUPPORTED)

    def send_stdin(self, pid: int, data: bytes, request_timeout: float | None = None) -> None:
        raise NotImplementedError(self._UNSUPPORTED)

    def resize(self, pid: int, size: PtySize, request_timeout: float | None = None) -> None:
        raise NotImplementedError(self._UNSUPPORTED)

    def kill(self, pid: int, request_timeout: float | None = None) -> bool:
        raise NotImplementedError(self._UNSUPPORTED)
