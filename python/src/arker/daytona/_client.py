"""`Daytona` client — backed by `arker.Arker`.

Surface matches the upstream `daytonaio/daytona` Python SDK:
- `Daytona.create(params=None)` accepts `CreateSandboxFromSnapshotParams` or
  `CreateSandboxFromImageParams` (positional). Bare `.create()` still works
  (forks the default golden) for parity with `daytona.create()`.
- `Daytona.delete(sandbox)`, `Daytona.start(sandbox)`, `Daytona.stop(sandbox)`
  take the Sandbox *object* (matching daytona).
- `Daytona.list()` returns `PaginatedSandboxes` with `.items`, `.total`, `.page`,
  `.total_pages` — supports `daytona.list().items` destructuring.
- `Daytona.get(sandbox_id)` returns a `Sandbox` (404 → DaytonaNotFoundError).
- No `Daytona.find()` — that method doesn't exist in upstream daytona.
- `Daytona.remove(id)` is deprecated alias for `delete(get(id))`.
"""

from __future__ import annotations

import logging
import os
from typing import Any

from ..computer import Arker, ArkerError, VmInfo
from ._sandbox import Sandbox
from ._types import (
    CreateSandboxFromImageParams,
    CreateSandboxFromSnapshotParams,
    DaytonaConfig,
    DaytonaNotFoundError,
    DaytonaValidationError,
    PaginatedSandboxes,
    translate_arker_error,
)

logger = logging.getLogger("arker.daytona")

DEFAULT_TEMPLATE_ENV = "ARKER_DAYTONA_DEFAULT_TEMPLATE"
DEFAULT_TEMPLATE = "base"


def _resolve_template(template: str | None) -> str:
    if template:
        return template
    return os.environ.get(DEFAULT_TEMPLATE_ENV, DEFAULT_TEMPLATE)


def _build_arker(config: DaytonaConfig | None) -> Arker:
    api_key = config.api_key if config else None
    region: str | None = None
    if config and config.target and config.target not in {"us", "eu"}:
        region = config.target
    return Arker(api_key=api_key, region=region)


def _resolve_create_params(
    params: Any,
    *,
    image: str | None,
    name: str | None,
    env: dict[str, str] | None,
    env_vars: dict[str, str] | None,
    labels: dict[str, str] | None,
    snapshot: str | None,
) -> tuple[str, str | None, dict[str, str], dict[str, str]]:
    """Returns (source_template, name, env_vars, labels) from a params
    object or loose kwargs. Centralises the create() input normalisation
    so the typed `params=` path and the legacy kwarg path don't drift."""
    p_snapshot: str | None = snapshot
    p_image: str | None = image
    p_name: str | None = name
    p_env: dict[str, str] = dict(env_vars or env or {})
    p_labels: dict[str, str] = dict(labels or {})

    if isinstance(params, CreateSandboxFromSnapshotParams):
        p_snapshot = params.snapshot or p_snapshot
        p_name = params.name or p_name
        if params.env_vars:
            p_env.update(params.env_vars)
        if params.labels:
            p_labels.update(params.labels)
    elif isinstance(params, CreateSandboxFromImageParams):
        p_image = params.image or p_image
        p_name = params.name or p_name
        if params.env_vars:
            p_env.update(params.env_vars)
        if params.labels:
            p_labels.update(params.labels)
        # `Resources(...)` is the canonical nested path; flat `cpu`/`memory`/...
        # are still accepted (deprecated). The shim only consumes name+env+labels
        # for now — resource overrides are forwarded once Arker SDK accepts them.

    source = _resolve_template(p_snapshot or p_image)
    return source, p_name, p_env, p_labels


class Daytona:
    def __init__(self, config: DaytonaConfig | None = None, *, _arker: Arker | None = None) -> None:
        self._config = config or DaytonaConfig()
        self._arker = _arker or _build_arker(self._config)

    # ---- Lifecycle ----

    def create(
        self,
        params: CreateSandboxFromSnapshotParams | CreateSandboxFromImageParams | None = None,
        *,
        timeout: float = 60,
        # Legacy/extra kwargs accepted for back-compat with our earlier Phase A signature.
        image: str | None = None,
        name: str | None = None,
        env: dict[str, str] | None = None,
        env_vars: dict[str, str] | None = None,
        labels: dict[str, str] | None = None,
        snapshot: str | None = None,
    ) -> Sandbox:
        """Fork an Arker VM from a snapshot/image and return a Sandbox.

        Canonical daytona form:
            daytona.create(CreateSandboxFromSnapshotParams(snapshot="py-base",
                                                            env_vars={"K": "V"}))
        Legacy form (still supported):
            daytona.create(image="py-base", env_vars={"K": "V"})
        """
        del timeout  # we don't enforce a fork timeout client-side
        source, vm_name, p_env, p_labels = _resolve_create_params(
            params,
            image=image,
            name=name,
            env=env,
            env_vars=env_vars,
            labels=labels,
            snapshot=snapshot,
        )
        try:
            computer = self._arker.vm(source).fork(name=vm_name)
        except ArkerError as error:
            raise translate_arker_error(error) from error
        return Sandbox(self._arker, computer, env=p_env, labels=p_labels, snapshot=source)

    def get(self, sandbox_id: str) -> Sandbox:
        if not sandbox_id:
            raise DaytonaValidationError("sandbox_id is required")
        try:
            info = self._arker.get(sandbox_id)
        except ArkerError as error:
            raise translate_arker_error(error) from error
        return Sandbox(
            self._arker,
            self._arker.vm(info.vm_id),
            snapshot=info.source_golden,
            info=info,
        )

    def list(
        self,
        labels: dict[str, str] | None = None,
        page: int | None = None,
        limit: int | None = None,
    ) -> PaginatedSandboxes:
        """Returns a `PaginatedSandboxes` wrapper.

        Raises `DaytonaValidationError` for:
          - `labels=` non-empty (Arker doesn't store metadata server-side,
            so filtering it would silently drop sandboxes — better to fail
            loud than mislead the caller across tenancy boundaries)
          - `page < 1` or `limit < 1`
        """
        if labels:
            raise DaytonaValidationError(
                "Daytona.list(labels=...) is not supported by the arker.daytona "
                "shim — Arker doesn't store sandbox metadata server-side. "
                "Pass labels=None and filter client-side after list()."
            )
        if page is not None and page < 1:
            raise DaytonaValidationError("page must be >= 1")
        if limit is not None and limit < 1:
            raise DaytonaValidationError("limit must be >= 1")

        try:
            vms = self._arker.list().vms
        except ArkerError as error:
            raise translate_arker_error(error) from error

        sandboxes = [self._sandbox_for_info(vm) for vm in vms]
        total = len(sandboxes)
        effective_limit = limit if limit and limit > 0 else total or 1
        effective_page = page if page and page > 0 else 1
        start = (effective_page - 1) * effective_limit
        end = start + effective_limit
        page_items = sandboxes[start:end]
        total_pages = max(1, (total + effective_limit - 1) // effective_limit)
        return PaginatedSandboxes(
            items=page_items,
            total=total,
            page=effective_page,
            total_pages=total_pages,
        )

    def delete(self, sandbox: Sandbox, timeout: float = 60) -> None:
        """Daytona-canonical: takes a Sandbox object, not an id. Raises
        DaytonaError (or subclass) on failure — routes through
        `Sandbox.delete()` so the customer sees the same typed error."""
        sandbox.delete(timeout=timeout)

    def start(self, sandbox: Sandbox, timeout: float = 60) -> None:
        del sandbox, timeout
        logger.debug("arker.daytona: Daytona.start — no-op; Arker VMs are running on fork")

    def stop(self, sandbox: Sandbox, timeout: float = 60) -> None:
        del sandbox, timeout
        logger.debug("arker.daytona: Daytona.stop — no-op; Arker has no VM stop state")

    def remove(self, sandbox_id: str) -> None:
        """Deprecated: not in upstream daytona. Use `daytona.delete(sandbox)`."""
        import warnings
        warnings.warn(
            "Daytona.remove(id) is not in upstream daytona; use "
            "Daytona.delete(sandbox). This alias may be removed.",
            DeprecationWarning,
            stacklevel=2,
        )
        try:
            self._arker.vm(sandbox_id).delete()
        except ArkerError as error:
            raise translate_arker_error(error) from error

    # ---- Context manager ----

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
            info=info,
        )
