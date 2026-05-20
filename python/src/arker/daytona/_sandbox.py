"""`daytona.Sandbox` — backed by an Arker `Computer`."""

from __future__ import annotations

import logging
from typing import Any

from ..computer import Arker, ArkerError, Computer
from ._files import FileSystem
from ._process import Process
from ._types import SandboxState

logger = logging.getLogger("arker.daytona")


class Sandbox:
    """daytona.Sandbox drop-in. Many properties (cpu, memory, labels, ...)
    are populated from Arker `VmInfo` where possible; defaults otherwise.

    Pending behaviors live in `__init__.py` (top of module). Notable Phase A
    no-ops: `start`/`stop`/`archive`/`set_*` lifecycle is mostly cosmetic
    because Arker VMs don't have a separate stopped state today.
    """

    def __init__(
        self,
        arker: Arker,
        computer: Computer,
        *,
        env: dict[str, str] | None = None,
        labels: dict[str, str] | None = None,
        snapshot: str | None = None,
    ) -> None:
        self._arker = arker
        self._computer = computer
        self._env: dict[str, str] = dict(env or {})
        self._labels: dict[str, str] = dict(labels or {})
        self._snapshot_id = snapshot
        self.process = Process(self)
        self.fs = FileSystem(self)

    # ---- Properties ----

    @property
    def id(self) -> str:
        return self._computer.id

    @property
    def env(self) -> dict[str, str]:
        return dict(self._env)

    @property
    def labels(self) -> dict[str, str]:
        return dict(self._labels)

    @property
    def state(self) -> SandboxState:
        try:
            arker_state = self._arker.get(self._computer.id).state
        except ArkerError:
            return SandboxState.ERROR
        if arker_state == "running":
            return SandboxState.STARTED
        if arker_state == "stopped":
            return SandboxState.STOPPED
        return SandboxState.ERROR

    @property
    def snapshot(self) -> str | None:
        if self._snapshot_id is not None:
            return self._snapshot_id
        try:
            return self._arker.get(self._computer.id).source_golden
        except ArkerError:
            return None

    @property
    def user(self) -> str:
        return "user"

    @property
    def public(self) -> bool:
        return False

    @property
    def target(self) -> str:
        return self._arker.region or ""

    # ---- Lifecycle ----

    def delete(self, timeout: float | None = 60) -> None:
        try:
            self._computer.delete()
        except ArkerError as error:
            logger.debug("arker.daytona: delete() raised %s", error)

    def start(self, timeout: float | None = 60) -> None:
        # Arker VMs are running on fork; no separate start state. No-op.
        logger.debug("arker.daytona: start() — no-op; Arker VMs are running on fork")

    def stop(self, timeout: float | None = 60, force: bool = False) -> None:
        logger.debug("arker.daytona: stop() — no-op; Arker has no VM stop state")

    def archive(self) -> None:
        logger.debug("arker.daytona: archive() — no-op")

    # ---- Configuration ----

    def set_labels(self, labels: dict[str, str]) -> dict[str, str]:
        # Stored locally; Arker doesn't persist labels server-side.
        self._labels = dict(labels)
        return dict(self._labels)

    # ---- Info helpers ----

    def get_user_home_dir(self) -> str:
        return "/home/user"

    def get_work_dir(self) -> str:
        return "/home/user"

    def refresh_data(self) -> None:
        # Arker has no batched-refresh equivalent; properties read live.
        return None

    # ---- Context manager ----

    def __enter__(self) -> "Sandbox":
        return self

    def __exit__(self, *_exc: Any) -> None:
        try:
            self.delete()
        except Exception:
            pass
