"""`CodeSandbox` top-level client + `Sandboxes` collection."""

from __future__ import annotations

import logging
import os
from typing import Any

from ..computer import Arker, ArkerError, VmInfo
from ._sandbox import Sandbox
from ._types import (
    BootupType,
    CodeSandboxError,
    PaginationInfo,
    SandboxInfo,
    SandboxListResponse,
    translate_arker_error,
)

logger = logging.getLogger("arker.codesandbox")

DEFAULT_TEMPLATE_ENV = "ARKER_CODESANDBOX_DEFAULT_TEMPLATE"
DEFAULT_TEMPLATE = "base"


def _resolve_template(template_id: str | None) -> str:
    if template_id:
        return template_id
    return os.environ.get(DEFAULT_TEMPLATE_ENV, DEFAULT_TEMPLATE)


def _build_arker(api_token: str | None) -> Arker:
    return Arker(api_key=api_token)


class Sandboxes:
    """Mirrors `@codesandbox/sdk` Sandboxes collection."""

    def __init__(self, arker: Arker) -> None:
        self._arker = arker

    @property
    def defaultTemplateId(self) -> str:  # noqa: N802 — matches @codesandbox/sdk
        return _resolve_template(None)

    default_template_id = defaultTemplateId

    def create(
        self,
        opts: dict | None = None,
    ) -> Sandbox:
        """Fork a template into a new Sandbox. Codesandbox's `opts` includes:
        - `id`: template id (we map to Arker golden)
        - `title`/`description`/`tags`/`path`/`privacy`: codesandbox-only metadata
        - `vmTier`, `automaticWakeupConfig`, `hibernationTimeoutSeconds`,
          `ipcountry`: codesandbox-only routing/sizing
        """
        opts = opts or {}
        template_id = _resolve_template(opts.get("id"))
        title = opts.get("title")
        try:
            computer = self._arker.vm(template_id).fork(name=title)
        except ArkerError as error:
            raise translate_arker_error(error) from error
        return Sandbox(
            self._arker,
            computer,
            bootup_type=BootupType.FORK,
            cluster=self._arker.region or "",
        )

    def get(self, sandbox_id: str) -> Sandbox:
        if not sandbox_id:
            raise CodeSandboxError("sandbox_id is required")
        try:
            info = self._arker.get(sandbox_id)
        except ArkerError as error:
            raise translate_arker_error(error) from error
        bootup = BootupType.RUNNING if info.state == "running" else BootupType.CLEAN
        return Sandbox(
            self._arker,
            self._arker.vm(info.vm_id),
            bootup_type=bootup,
            cluster=self._arker.region or "",
        )

    def resume(self, sandbox_id: str) -> Sandbox:
        """Codesandbox: wakes up from hibernation. Arker has no hibernation —
        we just return a Sandbox attached to the existing VM with bootupType
        RESUME so client code that branches on it sees the right value."""
        if not sandbox_id:
            raise CodeSandboxError("sandbox_id is required")
        try:
            info = self._arker.get(sandbox_id)
        except ArkerError as error:
            raise translate_arker_error(error) from error
        return Sandbox(
            self._arker,
            self._arker.vm(info.vm_id),
            bootup_type=BootupType.RESUME,
            cluster=self._arker.region or "",
        )

    def shutdown(self, sandbox_id: str) -> None:
        """Codesandbox: stop the VM but keep files. Arker has no stop —
        shutdown is a no-op + warning so customers aren't surprised the VM
        keeps running. Use `delete()` to actually destroy."""
        import warnings

        warnings.warn(
            "arker.codesandbox: sandboxes.shutdown() is a no-op — Arker has no "
            "stop-without-delete primitive. The VM keeps running. Use delete() "
            "to destroy it, or hibernate() (also a no-op).",
            stacklevel=2,
        )

    def delete(self, sandbox_id: str) -> None:
        if not sandbox_id:
            raise CodeSandboxError("sandbox_id is required")
        try:
            self._arker.vm(sandbox_id).delete()
        except ArkerError as error:
            raise translate_arker_error(error) from error

    def hibernate(self, sandbox_id: str) -> None:
        """Codesandbox: snapshot + stop. Arker has no snapshot — no-op + warning."""
        import warnings

        warnings.warn(
            "arker.codesandbox: sandboxes.hibernate() is a no-op — Arker has no "
            "VM snapshot/hibernate primitive. The VM keeps running.",
            stacklevel=2,
        )

    def restart(self, sandbox_id: str, opts: dict | None = None) -> Sandbox:
        """Codesandbox: shutdown then start fresh. Arker has no equivalent —
        we return a Sandbox attached to the existing VM with bootupType CLEAN
        so client logic branching on it sees the expected value."""
        del opts
        if not sandbox_id:
            raise CodeSandboxError("sandbox_id is required")
        try:
            info = self._arker.get(sandbox_id)
        except ArkerError as error:
            raise translate_arker_error(error) from error
        return Sandbox(
            self._arker,
            self._arker.vm(info.vm_id),
            bootup_type=BootupType.CLEAN,
            cluster=self._arker.region or "",
        )

    def list(self, opts: dict | None = None) -> SandboxListResponse:
        """Codesandbox: list sandboxes with optional tag filter + pagination.
        Tags aren't stored server-side in Arker — we honor `limit` and
        `pagination.page/pageSize` client-side."""
        opts = opts or {}
        if opts.get("tags"):
            raise CodeSandboxError(
                "arker.codesandbox: sandboxes.list({tags}) is not supported — "
                "Arker doesn't store sandbox tags server-side. Filter client-side."
            )
        try:
            vms = self._arker.list().vms
        except ArkerError as error:
            raise translate_arker_error(error) from error

        infos = [_vm_to_info(vm) for vm in vms]
        total = len(infos)
        pagination_opts = opts.get("pagination")
        if pagination_opts:
            page = max(1, int(pagination_opts.get("page", 1)))
            page_size = max(1, int(pagination_opts.get("pageSize", 50)))
            start = (page - 1) * page_size
            page_items = infos[start:start + page_size]
            next_page = page + 1 if start + page_size < total else None
            return SandboxListResponse(
                sandboxes=page_items,
                total_count=total,
                pagination=PaginationInfo(
                    current_page=page,
                    next_page=next_page,
                    page_size=page_size,
                ),
            )
        limit = int(opts.get("limit", 50))
        return SandboxListResponse(
            sandboxes=infos[:limit],
            total_count=total,
            pagination=None,
        )

    def fork(self, sandbox_id: str, opts: dict | None = None) -> Sandbox:
        """Deprecated in upstream codesandbox too — alias for create({"id": id})."""
        import warnings

        warnings.warn(
            "sandboxes.fork() is deprecated in @codesandbox/sdk; use "
            "sandboxes.create({'id': sandbox_id}).",
            DeprecationWarning,
            stacklevel=2,
        )
        return self.create({**(opts or {}), "id": sandbox_id})


class CodeSandbox:
    """Drop-in for `@codesandbox/sdk` CodeSandbox top-level client."""

    def __init__(
        self,
        api_token: str | None = None,
        opts: dict | None = None,
        *,
        _arker: Arker | None = None,
    ) -> None:
        self._opts = opts or {}
        self._arker = _arker or _build_arker(api_token)
        self.sandboxes = Sandboxes(self._arker)
        # `hosts` (HostTokens) is codesandbox auth-server primitive; throws on use.
        from ._sandbox_client import _NotImplementedNamespace
        self.hosts = _NotImplementedNamespace(
            "hosts",
            "host tokens are codesandbox auth-server primitives",
        )


def _vm_to_info(vm: VmInfo) -> SandboxInfo:
    return SandboxInfo(
        id=vm.vm_id,
        title=vm.name,
        description=None,
        tags=[],
        privacy="public-hosts",
        created_at=vm.created_at,
        updated_at=vm.last_activity,
    )
