"""`Sandbox` — returned by `sandboxes.create/resume/get/restart`."""

from __future__ import annotations

import logging
from typing import TYPE_CHECKING, Any

from ..computer import Arker, Computer
from ._sandbox_client import SandboxClient
from ._types import BootupType

if TYPE_CHECKING:
    pass

logger = logging.getLogger("arker.codesandbox")


class Sandbox:
    """Drop-in for `@codesandbox/sdk` Sandbox.

    `.connect()` returns a `SandboxClient` with `.commands` / `.fs`. Two-step
    pattern matches codesandbox — `sandboxes.create()` returns this, and you
    call `.connect()` to actually run things.
    """

    def __init__(
        self,
        arker: Arker,
        computer: Computer,
        bootup_type: BootupType = BootupType.FORK,
        cluster: str = "",
    ) -> None:
        self._arker = arker
        self._computer = computer
        self.id: str = computer.id
        self.bootupType: BootupType = bootup_type  # noqa: N815 — matches @codesandbox/sdk
        self.cluster: str = cluster
        # The agent version pair codesandbox uses for the `isUpToDate` check.
        # Always True on our shim (no agent version to compare).
        self.isUpToDate: bool = True  # noqa: N815

    # snake_case aliases
    @property
    def bootup_type(self) -> BootupType:
        return self.bootupType

    @property
    def is_up_to_date(self) -> bool:
        return self.isUpToDate

    def updateTier(self, tier: Any) -> None:  # noqa: N802
        """Codesandbox lets you live-rescale a sandbox between predefined
        VMTier names. Arker has no VM-tier concept — throw."""
        raise NotImplementedError(
            "arker.codesandbox: Sandbox.updateTier is not supported — Arker "
            "has no live VM-tier rescale. Fork with custom vcpu/memory at "
            "create time instead."
        )

    def updateHibernationTimeout(self, timeout_seconds: int) -> None:  # noqa: N802
        """Codesandbox's hibernation timeout — local-only warning since
        Arker has no SDK-level VM TTL."""
        import warnings

        warnings.warn(
            f"arker.codesandbox: updateHibernationTimeout({timeout_seconds}) "
            "is stored locally only — Arker has no server-side hibernation "
            "or auto-stop yet. VMs live until explicitly killed.",
            stacklevel=2,
        )
        self._hibernation_timeout_seconds = timeout_seconds

    update_tier = updateTier
    update_hibernation_timeout = updateHibernationTimeout

    def connect(self, custom_session: Any = None) -> SandboxClient:
        """Returns a SandboxClient bound to this Sandbox. The codesandbox
        version optionally opens a separate session; we ignore that."""
        del custom_session
        return SandboxClient(self)
