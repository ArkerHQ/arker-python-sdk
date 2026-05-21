"""`CodeSandbox` top-level client + `Sandboxes` collection."""

from __future__ import annotations

import datetime as _dt
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


def _parse_dt(value: Any) -> _dt.datetime | None:
    if not isinstance(value, str) or not value:
        return None
    try:
        return _dt.datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError:
        return None

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
        """Fork a template into a new Sandbox.

        Most opts are accepted but ignored — see pending notes. Notable:
        `privacy` (when set to non-default) emits a warning, since silently
        defaulting to `public-hosts` would be a security-sensitive surprise.
        """
        import warnings

        opts = opts or {}
        template_id = _resolve_template(opts.get("id"))
        title = opts.get("title")
        privacy = opts.get("privacy")
        if privacy and privacy != "public-hosts":
            warnings.warn(
                f"arker.codesandbox: sandboxes.create(privacy={privacy!r}) is not "
                "enforced — Arker doesn't store per-VM privacy. The sandbox is "
                "accessible to anyone with the VM id. Set up network policies on "
                "Arker if you need access control.",
                stacklevel=2,
            )
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

    def get(self, sandbox_id: str) -> SandboxInfo:
        """Returns metadata (matches `@codesandbox/sdk`). For a connectable
        Sandbox, use `sandboxes.resume(id)` or hold the Sandbox returned by
        `sandboxes.create()` / `restart()` directly."""
        if not sandbox_id:
            raise CodeSandboxError("sandbox_id is required")
        try:
            info = self._arker.get(sandbox_id)
        except ArkerError as error:
            raise translate_arker_error(error) from error
        return _vm_to_info(info)

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
        """List sandboxes. Pagination is always populated (matches codesandbox
        invariant). Unsupported filters (`tags`, `status`, `orderBy`,
        `direction`) raise instead of silently dropping."""
        opts = opts or {}
        if opts.get("tags"):
            raise CodeSandboxError(
                "arker.codesandbox: sandboxes.list({tags}) is not supported — "
                "Arker doesn't store sandbox tags server-side. Filter client-side."
            )
        for unsupported in ("status", "orderBy", "direction"):
            if opts.get(unsupported):
                raise CodeSandboxError(
                    f"arker.codesandbox: sandboxes.list({{{unsupported}}}) is "
                    "not supported — Arker's list endpoint doesn't honor it."
                )
        try:
            vms = self._arker.list().vms
        except ArkerError as error:
            raise translate_arker_error(error) from error

        infos = [_vm_to_info(vm) for vm in vms]
        total = len(infos)
        pagination_opts = opts.get("pagination") or {}
        page = max(1, int(pagination_opts.get("page", 1)))
        page_size = max(1, int(pagination_opts.get("pageSize") or opts.get("limit", 50)))
        start = (page - 1) * page_size
        end = start + page_size
        page_items = infos[start:end]
        next_page = page + 1 if end < total else None
        return SandboxListResponse(
            sandboxes=page_items,
            total_count=total,
            pagination=PaginationInfo(
                current_page=page,
                next_page=next_page,
                page_size=page_size,
            ),
            has_more=end < total,
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
        created_at=_parse_dt(vm.created_at),
        updated_at=_parse_dt(vm.last_activity),
    )
