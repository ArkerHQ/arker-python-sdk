"""`Daytona` client — backed by `arker.Arker`."""

from __future__ import annotations

import logging
import os
from typing import Any

from ..computer import Arker, ArkerError, VmInfo
from ._sandbox import Sandbox
from ._types import DaytonaConfig, SandboxNotFoundError

logger = logging.getLogger("arker.daytona")

DEFAULT_TEMPLATE_ENV = "ARKER_DAYTONA_DEFAULT_TEMPLATE"
DEFAULT_TEMPLATE = "base"


def _resolve_template(template: str | None) -> str:
    if template:
        return template
    return os.environ.get(DEFAULT_TEMPLATE_ENV, DEFAULT_TEMPLATE)


def _build_arker(config: DaytonaConfig | None) -> Arker:
    api_key = config.api_key if config else None
    # `target` is daytona-speak for region; pass through if it looks like one.
    region: str | None = None
    if config and config.target and config.target not in {"us", "eu"}:
        region = config.target
    return Arker(api_key=api_key, region=region)


class Daytona:
    """daytona.Daytona drop-in.

    Construct with a `DaytonaConfig` (or rely on environment variables for
    the underlying Arker client). All sandbox creation/listing flows go
    through this object.
    """

    def __init__(self, config: DaytonaConfig | None = None, *, _arker: Arker | None = None) -> None:
        self._config = config or DaytonaConfig()
        self._arker = _arker or _build_arker(self._config)

    # ---- Lifecycle ----

    def create(self, *, image: str | None = None, name: str | None = None, env: dict[str, str] | None = None, labels: dict[str, str] | None = None) -> Sandbox:
        """Fork an Arker VM from a golden and wrap as `Sandbox`.

        `image` overrides the default template; if omitted, uses
        `$ARKER_DAYTONA_DEFAULT_TEMPLATE` or `"base"`. `env` and `labels`
        are stored on the returned Sandbox (Arker doesn't persist them
        server-side — see pending #1 / #2 in `__init__.py`).
        """
        source = _resolve_template(image)
        computer = self._arker.vm(source).fork(name=name)
        return Sandbox(self._arker, computer, env=env, labels=labels, snapshot=source)

    def get(self, sandbox_id: str) -> Sandbox:
        try:
            info = self._arker.get(sandbox_id)
        except ArkerError as error:
            raise SandboxNotFoundError(f"sandbox {sandbox_id!r}: {error.message}") from error
        return Sandbox(
            self._arker,
            self._arker.vm(info.vm_id),
            snapshot=info.source_golden,
        )

    def list(self) -> list[Sandbox]:
        try:
            vms = self._arker.list().vms
        except ArkerError:
            return []
        return [self._sandbox_for_info(vm) for vm in vms]

    def find(self, **filters: Any) -> Sandbox | None:
        """Filter by VM properties. Arker doesn't index metadata server-side,
        so the filter runs client-side over `Daytona.list()`. Supported keys:
        `id`, `name`, `snapshot` (template).
        """
        for sbx in self.list():
            ok = True
            for key, expected in filters.items():
                actual: Any
                if key == "id":
                    actual = sbx.id
                elif key == "name":
                    actual = None
                    try:
                        actual = self._arker.get(sbx.id).name
                    except ArkerError:
                        actual = None
                elif key == "snapshot":
                    actual = sbx.snapshot
                else:
                    actual = None
                if actual != expected:
                    ok = False
                    break
            if ok:
                return sbx
        return None

    def remove(self, sandbox_id: str) -> None:
        try:
            self._arker.vm(sandbox_id).delete()
        except ArkerError as error:
            raise SandboxNotFoundError(f"sandbox {sandbox_id!r}: {error.message}") from error

    # ---- Context manager (matches daytona's blessed pattern) ----

    def __enter__(self) -> "Daytona":
        return self

    def __exit__(self, *_exc: Any) -> None:
        return None

    # ---- Internals ----

    def _sandbox_for_info(self, info: VmInfo) -> Sandbox:
        return Sandbox(
            self._arker,
            self._arker.vm(info.vm_id),
            snapshot=info.source_golden,
        )
