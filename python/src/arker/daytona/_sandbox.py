"""`daytona.Sandbox` — backed by an Arker `Computer`.

Properties (`env`, `labels`, `state`, `snapshot`, `user`, `public`, `target`)
are plain assignable attributes set at construction (matching daytona's
SandboxDto-style API). Call `refresh_data()` to re-read from the server;
reading `.state` etc. is O(1) — no HTTP per access.
"""

from __future__ import annotations

import logging
from typing import Any

from ..computer import Arker, ArkerError, Computer, VmInfo
from ._files import FileSystem
from ._process import Process
from ._types import SandboxState, translate_arker_error

logger = logging.getLogger("arker.daytona")

# Internal alias for the process namespace.
_env_field = "_env"


def _arker_state_to_sandbox_state(arker_state: str | None) -> SandboxState:
    if arker_state == "running":
        return SandboxState.STARTED
    if arker_state == "stopped":
        return SandboxState.STOPPED
    if arker_state in {"creating", "starting"}:
        return SandboxState.STARTING
    if arker_state == "error":
        return SandboxState.ERROR
    return SandboxState.UNKNOWN


class Sandbox:
    """daytona.Sandbox drop-in. Properties are plain attributes; reading them
    doesn't issue HTTP. Call `refresh_data()` to re-sync from the server."""

    def __init__(
        self,
        arker: Arker,
        computer: Computer,
        *,
        env: dict[str, str] | None = None,
        labels: dict[str, str] | None = None,
        snapshot: str | None = None,
        info: VmInfo | None = None,
    ) -> None:
        self._arker = arker
        self._computer = computer
        self.id: str = computer.id
        self.env: dict[str, str] = dict(env or {})
        self.labels: dict[str, str] = dict(labels or {})
        self.snapshot: str | None = snapshot
        self.state: SandboxState = SandboxState.UNKNOWN
        self.user: str = "user"
        self.public: bool = False
        self.target: str = arker.region or ""

        # If the caller already has a `VmInfo` (e.g. from a get/list response),
        # use it directly. Otherwise leave state as UNKNOWN — the caller can
        # invoke `refresh_data()` explicitly. This keeps construction O(1)
        # (no HTTP) and matches daytona's "SandboxDto is built from the
        # response that returned it" pattern.
        if info is not None:
            self._apply_info(info)

        self.process = Process(self)
        self.fs = FileSystem(self)

    # `_env` alias used by the Process / FileSystem internals — they read
    # `self._sandbox._env`. Keep this in sync with the public `env` attribute.
    @property
    def _env(self) -> dict[str, str]:
        return self.env

    # ---- Configuration helpers ----

    def set_labels(self, labels: dict[str, str]) -> dict[str, str]:
        """Local-only (Arker doesn't persist labels server-side); future
        `Daytona.list()` label filters won't see these."""
        self.labels = dict(labels)
        return dict(self.labels)

    def get_user_home_dir(self) -> str:
        return "/home/user"

    def get_work_dir(self) -> str:
        return "/home/user"

    def refresh_data(self) -> None:
        try:
            self._refresh_from_info()
        except ArkerError as error:
            raise translate_arker_error(error) from error

    def _refresh_from_info(self) -> None:
        self._apply_info(self._arker.get(self._computer.id))

    def _apply_info(self, info: VmInfo) -> None:
        self.state = _arker_state_to_sandbox_state(info.state)
        if self.snapshot is None and info.source_golden is not None:
            self.snapshot = info.source_golden

    # ---- Lifecycle ----

    def delete(self, timeout: float | None = 60) -> None:
        """Raises DaytonaError (or subclass) on failure — silent swallow would
        mask VM leaks and break retry loops."""
        del timeout
        try:
            self._computer.delete()
        except ArkerError as error:
            raise translate_arker_error(error) from error
        self.state = SandboxState.DESTROYED

    def start(self, timeout: float | None = 60) -> None:
        del timeout
        logger.debug("arker.daytona: Sandbox.start — no-op; Arker VMs are running on fork")

    def stop(self, timeout: float | None = 60, force: bool = False) -> None:
        del timeout, force
        logger.debug("arker.daytona: Sandbox.stop — no-op; Arker has no VM stop state")

    def archive(self) -> None:
        logger.debug("arker.daytona: Sandbox.archive — no-op")

    # ---- Context manager ----

    def __enter__(self) -> "Sandbox":
        return self

    def __exit__(self, exc_type, exc_val, exc_tb) -> None:
        # On clean exit, propagate delete failures. If the block already raised,
        # don't suppress the original exception — log the delete failure instead.
        try:
            self.delete()
        except Exception:
            if exc_type is None:
                raise
            logger.debug("arker.daytona: __exit__ delete() failed during exception handling", exc_info=True)
