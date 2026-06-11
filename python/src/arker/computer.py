"""Arker Python SDK.

A small wrapper around the VM API. Configure a region for the standard Arker
endpoints, or pass base_url directly for internal/dev targets.
"""

from __future__ import annotations

import base64
import dataclasses
import json
import os
import re
import secrets
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
from typing import Any, Callable

CHUNK_SIZE = 4 * 1024 * 1024

# Org id for the "Arker" org — the org that owns the public golden VMs
# (`arkuntu`, `ubuntu`, `ubuntu-full`, `ubuntu-py-repl`, …). Pass it as
# ``source_org_id`` to fork a public golden:
#
#     arker.fork(source_vm_name="ubuntu-full", source_org_id=ARKER_ORG_ID)
ARKER_ORG_ID = "ArkerHQ"

DEFAULT_RETRY_ATTEMPTS = 4
DEFAULT_RETRY_BASE_DELAY_S = 0.2
DEFAULT_RETRY_MAX_DELAY_S = 2.0
DEFAULT_RETRY_JITTER_S = 0.05
PRESIGNED_PUT_TIMEOUT_S = 600
RETRYABLE_HTTP = {429, 502, 503, 504}
RETRYABLE_CODES = {"routing_unavailable", "unavailable", "temporarily_unavailable"}
TRANSIENT_HINTS = ("503", "Service Unavailable", "throttle", "SlowDown", "ThrottlingException")
ULID_ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ"
DEFAULT_REGION_ENV = "ARKER_REGION"
DEFAULT_PROVIDER_ENV = "ARKER_PROVIDER"
DEFAULT_PROVIDER = "aws"
DEFAULT_CONTROL_BASE_URL = "https://arker.ai/api"
BURST_SOURCE_REFS = {"arkuntu"}
BURST_VM_ID = re.compile(r"^[0-9A-HJKMNP-TV-Z]{26}_[A-Za-z0-9]+$")

# Public golden VM names owned by the Arker org. Forking one of these by name
# auto-fills source_org_id = ARKER_ORG_ID (see Arker.fork).
GOLDEN_NAMES = frozenset({
    "arkuntu",
    "ubuntu", "ubuntu-small", "ubuntu-nodisk", "ubuntu-nonet-nodisk",
    "ubuntu-full", "ubuntu-full-32",
    "ubuntu-py-repl", "ubuntu-js-repl",
    "ubuntu-docker", "ubuntu-chromium", "ubuntu-servo",
    "ubuntu-servo-js-repl", "ubuntu-chromium-js-repl",
})


@dataclasses.dataclass(frozen=True)
class RetryOptions:
    attempts: int = DEFAULT_RETRY_ATTEMPTS
    base_delay_s: float = DEFAULT_RETRY_BASE_DELAY_S
    max_delay_s: float = DEFAULT_RETRY_MAX_DELAY_S
    jitter_s: float = DEFAULT_RETRY_JITTER_S


# ── Resources ───────────────────────────────────────────────────────


@dataclasses.dataclass(frozen=True)
class Session:
    session_id: str
    state: str  # "idle" | "running"
    cwd: str
    session_idx: int = 0
    env: dict[str, str] | None = None
    started_at: str | None = None


@dataclasses.dataclass(frozen=True)
class Tunnel:
    vm_id: str
    port: int
    visibility: str
    protocol: str
    state: str  # "starting" | "open" | "closed"
    run_id: str | None = None
    url: str | None = None
    message: str | None = None
    started_at: str | None = None


@dataclasses.dataclass(frozen=True)
class Vm:
    vm_id: str
    owner_org_id: str
    created_at: str
    public: bool
    state: str  # "idle" | "running"
    sessions: list[Session]
    name: str | None = None
    root_source_vm_id: str | None = None
    root_source_vm_name: str | None = None
    region: str | None = None
    provider: str | None = None
    started_at: str | None = None
    vcpu_count: int | None = None
    memory_mib: int | None = None
    disk_mib: int | None = None
    worker_id: str | None = None
    tunnels: list[Tunnel] = dataclasses.field(default_factory=list)


@dataclasses.dataclass(frozen=True)
class ListVmsResponse:
    vms: list[VM]
    next_cursor: str | None = None

    @property
    def items(self) -> list[VM]:
        return self.vms

    @property
    def total(self) -> int:
        return len(self.vms)

    def __iter__(self):
        return iter(self.vms)

    def __len__(self) -> int:
        return len(self.vms)


VmSummary = Vm
VmList = ListVmsResponse

# Backwards-compat aliases — pre-rename names. Drop in a future major.
VmInfo = Vm
SessionInfo = Session


@dataclasses.dataclass(frozen=True)
class DeleteVmResponse:
    deleted: bool


@dataclasses.dataclass(frozen=True)
class DeleteSessionResponse:
    deleted: bool


@dataclasses.dataclass(frozen=True)
class CompletedRunResult:
    stdout: bytes
    stdout_encoding: str
    stderr: bytes
    stderr_encoding: str
    exit_code: int
    run_id: str | None = None  # present for executed runs; None for operation acks
    state: str = "completed"   # "completed" | "failed"; mirrors the run-status (Run) shape
    # System failure explanation when state is "failed"; distinct from
    # stderr (the program's own error output). None otherwise.
    fail_reason: str | None = None
    type: str = "completed"


@dataclasses.dataclass(frozen=True)
class BackgroundRunResult:
    run_id: str
    state: str = "running"
    tunnels: list[Tunnel] = dataclasses.field(default_factory=list)
    type: str = "background"


RunResult = CompletedRunResult | BackgroundRunResult


@dataclasses.dataclass(frozen=True)
class Run:
    run_id: str
    state: str  # "running" | "completed" | "failed" | "cancelled"
    started_at: str
    stdout: bytes
    stdout_encoding: str
    stderr: bytes
    stderr_encoding: str
    tunnels: list[Tunnel]
    exit_code: int | None = None
    # System failure explanation when state is "failed"; distinct from
    # stderr (the program's own error output). None otherwise.
    fail_reason: str | None = None
    session_id: str | None = None
    command: str | None = None
    completed_at: str | None = None
    retry_count: int = 0


@dataclasses.dataclass(frozen=True)
class RunSummary:
    """Strict field-subset of `Run` — every field is present on `Run`."""
    run_id: str
    state: str
    started_at: str
    exit_code: int | None = None
    # System failure explanation when state is "failed"; see Run.fail_reason.
    fail_reason: str | None = None
    session_id: str | None = None
    command: str | None = None
    completed_at: str | None = None


@dataclasses.dataclass(frozen=True)
class ListRunsResponse:
    runs: list[RunSummary]
    next_cursor: str | None = None


@dataclasses.dataclass(frozen=True)
class CancelRunResponse:
    cancelled: bool


@dataclasses.dataclass(frozen=True)
class ListSessionsResponse:
    sessions: list[Session]
    next_cursor: str | None = None


@dataclasses.dataclass(frozen=True)
class ListTunnelsResponse:
    tunnels: list[Tunnel]
    next_cursor: str | None = None


@dataclasses.dataclass(frozen=True)
class DeleteTunnelResponse:
    deleted: bool


@dataclasses.dataclass(frozen=True)
class ResizeResponse:
    resized: bool


@dataclasses.dataclass(frozen=True)
class Filesystem:
    filesystem_id: str
    name: str
    owner_org_id: str
    created_at: str
    size_bytes: int | None = None


@dataclasses.dataclass(frozen=True)
class ListFilesystemsResponse:
    filesystems: list[Filesystem]
    next_cursor: str | None = None


@dataclasses.dataclass(frozen=True)
class DeleteFilesystemResponse:
    deleted: bool


@dataclasses.dataclass(frozen=True)
class Sync:
    sync_id: str
    vm_id: str
    filesystem_id: str
    path: str
    region: str | None = None


@dataclasses.dataclass(frozen=True)
class ListSyncsResponse:
    syncs: list[Sync]
    next_cursor: str | None = None


@dataclasses.dataclass(frozen=True)
class DeleteSyncResponse:
    deleted: bool


@dataclasses.dataclass(eq=False)
class ArkerError(Exception):
    code: str
    message: str
    status: int

    def __post_init__(self) -> None:
        Exception.__init__(self, f"{self.code}: {self.message}")


# ── Client ──────────────────────────────────────────────────────────


class Arker:
    def __init__(
        self,
        api_key: str | None = None,
        base_url: str | None = None,
        burst_base_url: str | None = None,
        control_base_url: str | None = None,
        region: str | None = None,
        provider: str | None = None,
        retry: RetryOptions | dict[str, Any] | bool | None = None,
    ) -> None:
        resolved_api_key = api_key or _env("ARKER_API_KEY") or _env("AUTH_KEY")
        explicit_base_url = base_url or _env("ARKER_BASE_URL")
        raw_region = region or (None if explicit_base_url else _env(DEFAULT_REGION_ENV))
        raw_provider = provider or _env(DEFAULT_PROVIDER_ENV) or DEFAULT_PROVIDER
        provider_value = _parse_provider(raw_provider)
        resolved_region, provider_from_region = _split_region(raw_region)
        effective_provider = provider_from_region or provider_value

        resolved_base_url = explicit_base_url or (
            _compute_base_url(effective_provider, resolved_region) if resolved_region else None
        )
        resolved_burst_base_url = (
            burst_base_url
            or _env("ARKER_BURST_BASE_URL")
            or (_compute_base_url("aws-burst", resolved_region) if resolved_region else None)
        )
        resolved_control_base_url = (
            control_base_url
            or _env("ARKER_CONTROL_BASE_URL")
            or DEFAULT_CONTROL_BASE_URL
        )

        if not resolved_api_key:
            raise ValueError("api_key is required; pass api_key or set ARKER_API_KEY")
        if not resolved_base_url:
            raise ValueError("region or base_url is required; pass region, base_url, ARKER_REGION, or ARKER_BASE_URL")

        self._api_key = resolved_api_key
        self._base_url = _normalize_base_url(resolved_base_url)
        self._burst_base_url = _normalize_base_url(resolved_burst_base_url) if resolved_burst_base_url else None
        self._control_base_url = _normalize_base_url(resolved_control_base_url)
        self._region = _normalize_region(resolved_region) if resolved_region else None
        self._provider = effective_provider
        self._retry = _normalize_retry(retry)

    @property
    def base_url(self) -> str:
        return self._base_url

    @property
    def burst_base_url(self) -> str | None:
        return self._burst_base_url

    @property
    def control_base_url(self) -> str:
        return self._control_base_url

    @property
    def region(self) -> str | None:
        return self._region

    @property
    def provider(self) -> str:
        return self._provider

    def vm(self, vm_id: str) -> "VM":
        return VM(self, vm_id, self._base_url_for(vm_id))

    def fork(
        self,
        source: "VM | str | None" = None,
        *,
        source_vm_id: str | None = None,
        source_vm_name: str | None = None,
        source_org_id: str | None = None,
        name: str | None = None,
        public: bool | None = None,
        network: bool | str | dict[str, Any] | None = None,
        disk: bool | None = None,
        vcpu_count: int | None = None,
        memory_mib: int | None = None,
        max_memory_mib: int | None = None,
        disk_mib: int | None = None,
        durable: bool | None = None,
    ) -> "VM":
        """Create a new VM by forking from a source.

        The source can be passed positionally or by keyword:

        - ``fork("ubuntu-full")`` — fork a public golden by name (the Arker
          org is filled in automatically for known goldens).
        - ``fork("base")`` — fork a VM by name in your own org.
        - ``fork(vm)`` — fork an existing ``VM`` (uses its id).
        - ``fork(source_vm_id="vm_abc...")`` — fork by global id.
        - ``fork(source_vm_name="base", source_org_id="org_...")`` — fork a
          named VM in a specific org (it must be ``public``).

        ``source_org_id`` defaults to the Arker org when ``source_vm_name`` is
        a known public golden, otherwise to your own org; an explicit value
        always wins, and it's irrelevant when forking by id. ``name``
        (optional) is the *new* VM's name in your org.
        """
        # Positional source: a VM handle (use its id) or a name string.
        if source is not None:
            if source_vm_id or source_vm_name:
                raise ArkerError("bad_request", "fork: pass the source positionally or by keyword, not both", 400)
            if isinstance(source, VM):
                source_vm_id = source.id
            elif isinstance(source, str):
                source_vm_name = source
            else:
                raise ArkerError("bad_request", "fork source must be a VM or a source-name string", 400)
        if not source_vm_id and not source_vm_name:
            raise ArkerError("bad_request", "fork requires a source (a VM, a name, source_vm_name, or source_vm_id)", 400)
        if source_vm_id and source_vm_name:
            raise ArkerError("bad_request", "fork: pass only one of source_vm_id or source_vm_name", 400)
        # A public golden by name defaults to the Arker org; any other name
        # defaults (server-side) to the caller's own org. Explicit wins;
        # irrelevant when forking by id.
        if source_vm_name and source_org_id is None and source_vm_name in GOLDEN_NAMES:
            source_org_id = ARKER_ORG_ID
        body = {
            "source_vm_id": source_vm_id,
            "source_vm_name": source_vm_name,
            "source_org_id": source_org_id,
            "name": name,
            "public": public,
            "network": network,
            "disk": disk if disk is not None else True,
            "vcpu_count": vcpu_count,
            "memory_mib": memory_mib,
            "max_memory_mib": max_memory_mib,
            "disk_mib": disk_mib,
            "durable": durable,
        }
        burst_ref = source_vm_name or source_vm_id
        use_burst = bool(burst_ref) and _is_burst_ref(burst_ref) and self._burst_base_url is not None
        base_url = self._burst_base_url if use_burst else self._base_url
        payload = self._request("POST", "/v1/fork", body, base_url=base_url)
        info = _vm_info(payload)
        # Child lives on the host the fork was posted to.
        return VM(self, info.vm_id, base_url, info)

    def list_vms(
        self,
        *,
        cursor: str | None = None,
        limit: int | None = None,
        region: str | None = None,
        provider: str | None = None,
        state: str | None = None,
        source_org_id: str | None = None,
        started_after: str | None = None,
        started_before: str | None = None,
    ) -> ListVmsResponse:
        """Admin call — goes through the control plane so it can
        aggregate across providers and regions.
        """
        path = _build_query("/v1/vms", {
            "cursor": cursor,
            "limit": limit,
            "region": region,
            "provider": provider,
            "state": state,
            "source_org_id": source_org_id,
            "started_after": started_after,
            "started_before": started_before,
        })
        payload = self._request("GET", path, base_url=self._control_base_url)
        vms = []
        for item in payload.get("vms", []):
            info = _vm_info(item)
            vms.append(VM(self, info.vm_id, self._base_url_for(info.vm_id), info))
        return ListVmsResponse(vms=vms, next_cursor=_optional_str(payload.get("next_cursor")))

    def get_vm(self, vm_id: str) -> VM:
        info = _vm_info(self._request("GET", _vm_path(vm_id), base_url=self._base_url_for(vm_id)))
        return VM(self, vm_id, self._base_url_for(vm_id), info)

    # ── Filesystems (org-scoped, control-plane) ─────────────────────────
    def list_filesystems(self, *, cursor: str | None = None, limit: int | None = None, name_prefix: str | None = None) -> ListFilesystemsResponse:
        path = _build_query("/v1/filesystems", {"cursor": cursor, "limit": limit, "name_prefix": name_prefix})
        # Filesystems are region-scoped and served by arkerd directly. Route to
        # the regional endpoint (base_url) rather than the control plane: the
        # control-plane path (arker.ai → api_proxy_bash) does not route
        # /v1/filesystems, while the regional NLB → arkerd serves it.
        payload = self._request("GET", path, base_url=self._base_url)
        return ListFilesystemsResponse(
            filesystems=[_filesystem(item) for item in payload.get("filesystems", [])],
            next_cursor=_optional_str(payload.get("next_cursor")),
        )

    def create_filesystem(self, *, name: str) -> Filesystem:
        return _filesystem(self._request("POST", "/v1/filesystems", {"name": name}, base_url=self._base_url))

    def get_filesystem(self, filesystem_id: str) -> Filesystem:
        return _filesystem(self._request("GET", f"/v1/filesystems/{_segment(filesystem_id)}", base_url=self._base_url))

    def delete_filesystem(self, filesystem_id: str) -> DeleteFilesystemResponse:
        payload = self._request("DELETE", f"/v1/filesystems/{_segment(filesystem_id)}", base_url=self._base_url)
        return DeleteFilesystemResponse(deleted=bool(payload.get("deleted")))

    def _request(
        self,
        method: str,
        path: str,
        body: dict[str, Any] | None = None,
        *,
        base_url: str | None = None,
        extra_headers: dict[str, str] | None = None,
    ) -> dict[str, Any]:
        url = (base_url or self._base_url) + path
        headers = {"authorization": f"Bearer {self._api_key}"}
        if extra_headers:
            for key, value in extra_headers.items():
                if value is not None:
                    headers[key] = value
        data = None

        if body is not None:
            headers["content-type"] = "application/json"
            data = json.dumps(_drop_none(body)).encode("utf-8")

        last_status = 0
        last_text = ""
        last_error: dict[str, str] | None = None

        for attempt in range(self._retry.attempts):
            try:
                status, raw = _http(method, url, headers, data)
            except urllib.error.URLError as error:
                if attempt < self._retry.attempts - 1:
                    time.sleep(self._retry_delay(attempt))
                    continue
                raise ArkerError("network_error", str(error), 0) from error

            text = raw.decode("utf-8", "replace")
            payload = _parse_json(text)
            parsed_error = _extract_error(payload)
            last_status = status
            last_text = text
            last_error = parsed_error

            if _is_retryable(status, parsed_error) and attempt < self._retry.attempts - 1:
                time.sleep(self._retry_delay(attempt))
                continue

            if parsed_error:
                raise ArkerError(parsed_error["code"], parsed_error["message"], status)
            if status >= 400:
                raise ArkerError("internal", last_text[:300] or f"HTTP {status}", status)
            if not isinstance(payload, dict):
                raise ArkerError("internal", "response must be a JSON object", status)
            return payload

        if last_error:
            raise ArkerError(last_error["code"], last_error["message"], last_status)
        raise ArkerError("internal", last_text[:300] or f"HTTP {last_status}", last_status)

    def _retry_delay(self, attempt: int) -> float:
        base = min(self._retry.max_delay_s, self._retry.base_delay_s * (2 ** attempt))
        return base + secrets.randbelow(max(1, int(self._retry.jitter_s * 1000) + 1)) / 1000.0

    def _base_url_for(self, ref: str) -> str:
        if _is_burst_ref(ref) and self._burst_base_url:
            return self._burst_base_url
        return self._base_url


class VM:
    # Data fields — populated from fork/get/list/refresh; ``None`` on a bare
    # handle from ``arker.vm(id)`` until you call ``refresh()``. Names mirror
    # the contract ``Vm``.
    vm_id: str | None
    name: str | None
    state: str | None
    owner_org_id: str | None
    created_at: str | None
    public: bool | None
    region: str | None
    provider: str | None
    vcpu_count: int | None
    memory_mib: int | None
    disk_mib: int | None
    started_at: str | None
    sessions: list[Session] | None
    tunnels: list[Tunnel] | None

    def __init__(self, client: Arker, vm_id: str, base_url: str | None = None, data: Vm | None = None) -> None:
        self._client = client
        self.id = vm_id
        self.base_url = base_url or client._base_url_for(vm_id)
        for f in dataclasses.fields(Vm):
            setattr(self, f.name, getattr(data, f.name) if data is not None else None)

    def __repr__(self) -> str:
        return f"VM(id={self.id!r}, name={self.name!r}, state={self.state!r})"

    def refresh(self) -> VM:
        """Re-fetch this VM and return a fresh, fully-populated handle."""
        info = _vm_info(self._client._request("GET", _vm_path(self.id), base_url=self.base_url))
        return VM(self._client, self.id, self.base_url, info)

    def fork(self, **kwargs: Any) -> VM:
        """Deprecated: prefer ``Arker.fork(source_vm_id=..., ...)``."""
        return self._client.fork(source_vm_id=self.id, **kwargs)

    def run(
        self,
        command: str,
        *,
        session_id: str | None = None,
        session_idx: int | None = None,
        background: bool | None = None,
        timeout: int | None = None,
        end_symbol: str | None = None,
        vcpu_count: int | None = None,
        memory_mib: int | None = None,
        disk_mib: int | None = None,
        network: dict[str, Any] | None = None,
        acquire: str | list[str] | None = None,
        release: str | list[str] | None = None,
        signal: str | None = None,
        idempotency_key: str | None = None,
    ) -> RunResult:
        body = {
            "command": command,
            "session_id": session_id,
            "session_idx": session_idx,
            "background": background,
            "timeout": timeout,
            "end_symbol": end_symbol,
            "vcpu_count": vcpu_count,
            "memory_mib": memory_mib,
            "disk_mib": disk_mib,
            "network": network,
            "acquire": ",".join(acquire) if isinstance(acquire, list) else acquire,
            "release": ",".join(release) if isinstance(release, list) else release,
            "signal": signal,
        }
        headers = {"Idempotency-Key": idempotency_key} if idempotency_key else None
        return _run_response(self._client._request(
            "POST",
            f"{_vm_path(self.id)}/runs",
            body,
            base_url=self.base_url,
            extra_headers=headers,
        ))

    def resize(
        self,
        *,
        vcpu_count: int | None = None,
        memory_mib: int | None = None,
        disk_mib: int | None = None,
    ) -> ResizeResponse:
        body = {"vcpu_count": vcpu_count, "memory_mib": memory_mib, "disk_mib": disk_mib}
        payload = self._client._request("POST", f"{_vm_path(self.id)}/resize", body, base_url=self.base_url)
        return ResizeResponse(resized=bool(payload.get("resized")))

    def delete(self) -> DeleteVmResponse:
        payload = self._client._request("DELETE", _vm_path(self.id), base_url=self.base_url)
        return DeleteVmResponse(deleted=bool(payload.get("deleted")))

    def sync(self, path: str, data: bytes | str | None = None) -> bytes | None:
        """Read or write a file in this VM over ``POST /v1/vms/{id}/sync``.

        Omit ``data`` to read (returns ``bytes``); pass ``data`` to write
        (returns ``None``). Inline transfer for small files, presigned
        uploads for large ones. To mount a standalone filesystem into the
        VM, use ``vm.syncs.create``.
        """
        if data is None:
            return self._sync_read(path)
        payload = data.encode("utf-8") if isinstance(data, str) else data
        if len(payload) <= CHUNK_SIZE:
            self._sync_write_inline(path, payload)
        else:
            self._sync_write_presigned(path, payload)
        return None

    def _sync_read(self, path: str) -> bytes:
        payload = self._client._request(
            "POST", f"{_vm_path(self.id)}/sync",
            {"op": "read", "path": path}, base_url=self.base_url,
        )
        if "content" in payload:
            return _decode_bytes(str(payload.get("content", "")), str(payload.get("encoding", "utf-8")))
        url = payload.get("presigned_url")
        if not isinstance(url, str) or not url:
            raise ArkerError("internal", "read response missing content/presigned_url", 200)
        with urllib.request.urlopen(url, timeout=300) as response:
            return response.read()

    def _sync_write_inline(self, path: str, data: bytes) -> None:
        result = self._send_one_write({
            "path": path, "size": len(data), "upload_id": _ulid(),
            "content": base64.b64encode(data).decode("ascii"), "start": 0, "end": len(data),
        })
        _assert_write_complete(result, "inline write")

    def _sync_write_presigned(self, path: str, data: bytes) -> None:
        request = self._send_one_write({"path": path, "size": len(data), "presigned": True})
        url = request.get("presigned_url")
        upload_id = request.get("upload_id")
        if not isinstance(url, str) or not url or not isinstance(upload_id, str) or not upload_id:
            raise ArkerError("internal", "write response missing presigned upload fields", 200)
        self._put_presigned(url, data)
        result = self._send_one_write({"path": path, "size": len(data), "upload_id": upload_id})
        _assert_write_complete(result, "presigned write commit")

    def _put_presigned(self, url: str, data: bytes) -> None:
        for attempt in range(self._client._retry.attempts):
            try:
                req = urllib.request.Request(url, method="PUT", data=data)
                with urllib.request.urlopen(req, timeout=PRESIGNED_PUT_TIMEOUT_S) as response:
                    if response.status < 400:
                        return
                    status = response.status
            except urllib.error.HTTPError as error:
                status = error.code
            except urllib.error.URLError as error:
                if attempt == self._client._retry.attempts - 1:
                    raise ArkerError("network_error", f"upload PUT failed: {error}", 0) from error
                time.sleep(self._client._retry_delay(attempt))
                continue
            if status not in RETRYABLE_HTTP or attempt == self._client._retry.attempts - 1:
                raise ArkerError("internal", f"upload PUT failed: {status}", status)
            time.sleep(self._client._retry_delay(attempt))

    def _send_one_write(self, entry: dict[str, Any]) -> dict[str, Any]:
        last_error: dict[str, str] | None = None
        for attempt in range(self._client._retry.attempts):
            payload = self._client._request(
                "POST", f"{_vm_path(self.id)}/sync",
                {"op": "write", "writes": [entry]}, base_url=self.base_url,
            )
            results = payload.get("results")
            if not isinstance(results, list) or not results:
                raise ArkerError("internal", "write response missing results[0]", 200)
            result = results[0]
            if not isinstance(result, dict):
                raise ArkerError("internal", "write response result must be an object", 200)
            error = result.get("error")
            if not error:
                return result
            if not isinstance(error, dict):
                raise ArkerError("internal", "write response error must be an object", 200)
            last_error = {"code": str(error.get("code", "internal")), "message": str(error.get("message", ""))}
            if not _is_retryable(200, last_error) or attempt == self._client._retry.attempts - 1:
                break
            time.sleep(self._client._retry_delay(attempt))
        raise ArkerError(
            last_error["code"] if last_error else "internal",
            last_error["message"] if last_error else "write failed",
            200,
        )

    # ── Syncs: bindings of a filesystem into this VM at a path ────────
    def list_syncs(self, *, cursor: str | None = None, limit: int | None = None, filesystem_id: str | None = None) -> ListSyncsResponse:
        path = _build_query(f"{_vm_path(self.id)}/syncs", {"cursor": cursor, "limit": limit, "filesystem_id": filesystem_id})
        payload = self._client._request("GET", path, base_url=self.base_url)
        return ListSyncsResponse(
            syncs=[_sync(item) for item in payload.get("syncs", [])],
            next_cursor=_optional_str(payload.get("next_cursor")),
        )

    def create_sync(self, *, filesystem_id: str, path: str | None = None) -> Sync:
        """Bind a filesystem into this VM at ``path``."""
        payload = self._client._request("POST", f"{_vm_path(self.id)}/syncs", {
            "filesystem_id": filesystem_id, "path": path,
        }, base_url=self.base_url)
        return _sync(payload)

    def delete_sync(self, sync_id: str) -> DeleteSyncResponse:
        payload = self._client._request("DELETE", f"{_vm_path(self.id)}/syncs/{_segment(sync_id)}", base_url=self.base_url)
        return DeleteSyncResponse(deleted=bool(payload.get("deleted")))

    # ── Runs ──────────────────────────────────────────────────────────
    def list_runs(self, *, cursor: str | None = None, limit: int | None = None, state: str | None = None,
                  started_after: str | None = None, started_before: str | None = None, completed_after: str | None = None) -> ListRunsResponse:
        path = _build_query(f"{_vm_path(self.id)}/runs", {
            "cursor": cursor, "limit": limit, "state": state,
            "started_after": started_after, "started_before": started_before, "completed_after": completed_after,
        })
        payload = self._client._request("GET", path, base_url=self.base_url)
        return ListRunsResponse(
            runs=[_run_summary(item) for item in payload.get("runs", [])],
            next_cursor=_optional_str(payload.get("next_cursor")),
        )

    def get_run(self, run_id: str) -> Run:
        return _run_status_response(self._client._request("GET", f"{_vm_path(self.id)}/runs/{_segment(run_id)}", base_url=self.base_url))

    def cancel_run(self, run_id: str) -> CancelRunResponse:
        payload = self._client._request("DELETE", f"{_vm_path(self.id)}/runs/{_segment(run_id)}", base_url=self.base_url)
        return CancelRunResponse(cancelled=bool(payload.get("cancelled")))

    # ── Sessions ──────────────────────────────────────────────────────
    def list_sessions(self, *, cursor: str | None = None, limit: int | None = None, state: str | None = None) -> ListSessionsResponse:
        path = _build_query(f"{_vm_path(self.id)}/sessions", {"cursor": cursor, "limit": limit, "state": state})
        payload = self._client._request("GET", path, base_url=self.base_url)
        return ListSessionsResponse(
            sessions=[_session_info(item) for item in payload.get("sessions", [])],
            next_cursor=_optional_str(payload.get("next_cursor")),
        )

    def create_session(self, *, env: dict[str, str] | None = None, cwd: str | None = None) -> Session:
        payload = self._client._request("POST", f"{_vm_path(self.id)}/sessions", {"env": env, "cwd": cwd}, base_url=self.base_url)
        return _session_info(payload)

    def get_session(self, session_id: str) -> Session:
        payload = self._client._request("GET", f"{_vm_path(self.id)}/sessions/{_segment(session_id)}", base_url=self.base_url)
        return _session_info(payload)

    def delete_session(self, session_id: str) -> DeleteSessionResponse:
        payload = self._client._request("DELETE", f"{_vm_path(self.id)}/sessions/{_segment(session_id)}", base_url=self.base_url)
        return DeleteSessionResponse(deleted=bool(payload.get("deleted")))

    def create_pty(
        self,
        *,
        on_data: Callable[[bytes], None],
        cols: int = 80,
        rows: int = 24,
        command: str | None = None,
        session_id: str | None = None,
        persist: bool = True,
        on_exit: Callable[[], None] | None = None,
    ) -> "Pty":
        """Open an interactive pseudo-terminal in this VM over a WebSocket.

        Raw terminal bytes (ANSI escapes/colors) are delivered to ``on_data``
        from a background reader thread. Send keystrokes with
        ``pty.send_input(b"...")`` (control chars like Ctrl-C = b"\\x03" work),
        resize with ``pty.resize(cols, rows)``, tear down with ``pty.kill()``.
        ``isatty()`` is true inside, so a shell, vim, htop, a REPL or ``claude``
        all work.

        With ``persist=True`` (the default), a disconnect keeps the shell
        running so you can reconnect to the SAME shell — call ``connect_pty``
        (or ``create_pty``) again with the same ``session_id`` and recent
        scrollback is replayed. ``pty.kill()`` destroys it immediately; a plain
        ``close()`` only detaches. Set ``persist=False`` for an ephemeral
        terminal torn down on disconnect.

        ``command`` is a single executable path (no shell-splitting); defaults
        to the login shell. Requires the optional ``websocket-client`` package
        (``pip install 'arker[pty]'``).
        """
        try:
            from websocket import create_connection  # type: ignore[import-untyped]
        except ImportError as exc:  # pragma: no cover - import guard
            raise ArkerError(
                "dependency",
                "create_pty requires the optional 'websocket-client' package "
                "(pip install 'arker[pty]')",
                0,
            ) from exc

        sid = session_id or self.create_session().session_id
        ws_base = re.sub(r"^http", "ws", self.base_url)  # https→wss, http→ws
        params: dict[str, Any] = {"cols": cols, "rows": rows, "persist": str(persist).lower()}
        if command:
            params["command"] = command
        url = f"{ws_base}{_vm_path(self.id)}/sessions/{_segment(sid)}/pty?{urllib.parse.urlencode(params)}"
        ws = create_connection(
            url,
            header=[f"Authorization: Bearer {self._client._api_key}"],
        )
        return Pty(ws, sid, on_data, on_exit)

    def connect_pty(
        self,
        *,
        session_id: str,
        on_data: Callable[[bytes], None],
        cols: int = 80,
        rows: int = 24,
        on_exit: Callable[[], None] | None = None,
    ) -> "Pty":
        """Reconnect to a persistent PTY by ``session_id`` (replays scrollback)."""
        return self.create_pty(
            on_data=on_data, cols=cols, rows=rows, session_id=session_id, on_exit=on_exit,
        )

    def create_pty_ticket(self, session_id: str) -> dict[str, Any]:
        """Mint a short-lived (5 min) ticket for opening the PTY WebSocket from a
        browser, which cannot send an Authorization header. Open
        ``wss://.../pty?ticket=<ticket>`` with it. Returns ``{ticket, expires_in}``."""
        return self._client._request(
            "POST",
            f"{_vm_path(self.id)}/sessions/{_segment(session_id)}/pty-ticket",
            base_url=self.base_url,
        )

    # ── Tunnels: opened as a side effect of fork/run, addressed by port ─
    def list_tunnels(self, *, cursor: str | None = None, limit: int | None = None, state: str | None = None) -> ListTunnelsResponse:
        path = _build_query(f"{_vm_path(self.id)}/tunnels", {"cursor": cursor, "limit": limit, "state": state})
        payload = self._client._request("GET", path, base_url=self.base_url)
        return ListTunnelsResponse(
            tunnels=[_tunnel(item) for item in payload.get("tunnels", [])],
            next_cursor=_optional_str(payload.get("next_cursor")),
        )

    def get_tunnel(self, port: int) -> Tunnel:
        payload = self._client._request("GET", f"{_vm_path(self.id)}/tunnels/{port}", base_url=self.base_url)
        return _tunnel(payload)

    def delete_tunnel(self, port: int) -> DeleteTunnelResponse:
        payload = self._client._request("DELETE", f"{_vm_path(self.id)}/tunnels/{port}", base_url=self.base_url)
        return DeleteTunnelResponse(deleted=bool(payload.get("deleted")))


class Pty:
    """A live interactive pseudo-terminal inside a VM (see ``VM.create_pty``).

    Output is delivered to the ``on_data`` callback from a daemon reader
    thread. Sends are serialized with a lock so input/resize/kill are safe to
    call from another thread while the reader runs.
    """

    def __init__(
        self,
        ws: Any,
        session_id: str,
        on_data: Callable[[bytes], None],
        on_exit: Callable[[], None] | None,
    ) -> None:
        self.session_id = session_id
        self._ws = ws
        self._on_data = on_data
        self._on_exit = on_exit
        self._send_lock = threading.Lock()
        self._closed = False
        self._reader = threading.Thread(target=self._read_loop, daemon=True)
        self._reader.start()

    def _read_loop(self) -> None:
        from websocket import ABNF  # type: ignore[import-untyped]

        try:
            while not self._closed:
                opcode, data = self._ws.recv_data()
                if opcode in (ABNF.OPCODE_BINARY, ABNF.OPCODE_TEXT):
                    if data:
                        self._on_data(bytes(data))
                elif opcode == ABNF.OPCODE_CLOSE:
                    break
        except Exception:
            pass
        finally:
            self._closed = True
            if self._on_exit is not None:
                self._on_exit()

    def send_input(self, data: bytes) -> None:
        """Send raw input bytes (keystrokes), incl. control chars like b"\\x03"."""
        with self._send_lock:
            if not self._closed:
                self._ws.send_binary(data)

    def resize(self, cols: int, rows: int) -> None:
        """Resize the terminal; a running full-screen app reflows."""
        with self._send_lock:
            if not self._closed:
                self._ws.send(json.dumps({"type": "resize", "cols": cols, "rows": rows}))

    def kill(self) -> None:
        """Kill the remote shell and close the connection."""
        with self._send_lock:
            if not self._closed:
                try:
                    self._ws.send(json.dumps({"type": "kill"}))
                except Exception:
                    pass
        self.close()

    def close(self) -> None:
        """Close the WebSocket without sending a kill control message."""
        self._closed = True
        try:
            self._ws.close()
        except Exception:
            pass

    def wait(self) -> None:
        """Block until the terminal closes (the reader thread exits)."""
        self._reader.join()


# ── Helpers ─────────────────────────────────────────────────────────


def _http(method: str, url: str, headers: dict[str, str], data: bytes | None) -> tuple[int, bytes]:
    req = urllib.request.Request(url, method=method, headers=headers, data=data)
    try:
        with urllib.request.urlopen(req, timeout=120) as response:
            return response.status, response.read()
    except urllib.error.HTTPError as error:
        return error.code, error.read()


def _build_query(path: str, params: dict[str, Any]) -> str:
    pairs = [(k, str(v)) for k, v in params.items() if v is not None]
    qs = urllib.parse.urlencode(pairs)
    return f"{path}?{qs}" if qs else path


def _env(name: str) -> str | None:
    value = os.environ.get(name)
    return value.strip() if value and value.strip() else None


def _normalize_base_url(base_url: str) -> str:
    normalized = base_url.strip().rstrip("/")
    if not normalized:
        raise ValueError("base_url must not be empty")
    return normalized


def _normalize_region(region: str) -> str:
    normalized = region.strip().lower()
    if not normalized:
        raise ValueError("region must not be empty")
    return normalized


def _compute_base_url(provider: str, region: str) -> str:
    """The subdomain encodes provider+region.

    Today both ``aws-{region}.arker.ai`` and ``aws-burst-{region}.arker.ai``
    still resolve through the CF Worker (which dispatches based on hostname),
    so the path includes ``/api``. When DNS is split to bypass the worker on
    the compute subdomains, drop ``/api`` here.
    """
    normalized = _normalize_region(region)
    return f"https://{provider}-{normalized}.arker.ai/api"


def _parse_provider(value: str | None) -> str:
    if not value:
        return DEFAULT_PROVIDER
    trimmed = value.strip().lower()
    if trimmed in ("aws-burst", "burst"):
        return "aws-burst"
    return "aws"


def _split_region(value: str | None) -> tuple[str | None, str | None]:
    """Accept either ``us-west-2`` or the legacy combined form
    ``aws-us-west-2`` / ``aws-burst-us-west-2``.
    """
    if not value:
        return None, None
    normalized = value.strip().lower()
    if normalized.startswith("aws-burst-"):
        return normalized[len("aws-burst-"):], "aws-burst"
    if normalized.startswith("aws-"):
        return normalized[len("aws-"):], "aws"
    return normalized, None


def _is_burst_ref(ref: str) -> bool:
    trimmed = ref.strip()
    return trimmed.lower() in BURST_SOURCE_REFS or bool(BURST_VM_ID.match(trimmed))


def _normalize_retry(retry: RetryOptions | dict[str, Any] | bool | None) -> RetryOptions:
    if retry is False:
        return RetryOptions(attempts=1, base_delay_s=0, max_delay_s=0, jitter_s=0)
    if isinstance(retry, RetryOptions):
        return retry
    if isinstance(retry, dict):
        return RetryOptions(
            attempts=max(1, int(retry.get("attempts", DEFAULT_RETRY_ATTEMPTS))),
            base_delay_s=max(0.0, float(retry.get("base_delay_s", DEFAULT_RETRY_BASE_DELAY_S))),
            max_delay_s=max(0.0, float(retry.get("max_delay_s", DEFAULT_RETRY_MAX_DELAY_S))),
            jitter_s=max(0.0, float(retry.get("jitter_s", DEFAULT_RETRY_JITTER_S))),
        )
    return RetryOptions()


def _vm_path(vm_id: str) -> str:
    return f"/v1/vms/{_segment(vm_id)}"


def _segment(value: str) -> str:
    return urllib.parse.quote(value, safe="")


def _drop_none(value: Any) -> Any:
    if isinstance(value, list):
        return [_drop_none(item) for item in value]
    if isinstance(value, dict):
        return {key: _drop_none(item) for key, item in value.items() if item is not None}
    return value


def _parse_json(text: str) -> Any:
    if not text:
        return {}
    try:
        return json.loads(text)
    except json.JSONDecodeError:
        return None


def _extract_error(payload: Any) -> dict[str, str] | None:
    if not isinstance(payload, dict):
        return None

    if isinstance(payload.get("code"), str) and isinstance(payload.get("message"), str):
        return {"code": payload["code"], "message": payload["message"]}

    nested = payload.get("error")
    if isinstance(nested, dict):
        return {
            "code": str(nested.get("code", "internal")),
            "message": str(nested.get("message", "")),
        }

    return None


def _is_retryable(status: int, error: dict[str, str] | None) -> bool:
    if status in RETRYABLE_HTTP:
        return True
    if not error:
        return False
    if error["code"] in RETRYABLE_CODES:
        return True
    if error["code"] != "internal":
        return False
    return any(hint in error["message"] for hint in TRANSIENT_HINTS)


def _ulid() -> str:
    raw = ((int(time.time() * 1000) & ((1 << 48) - 1)) << 80) | secrets.randbits(80)
    out = []
    for _ in range(26):
        out.append(ULID_ALPHABET[raw & 31])
        raw >>= 5
    return "".join(reversed(out))


def _decode_bytes(text: str, encoding: str) -> bytes:
    if encoding == "base64":
        return base64.b64decode(text)
    return text.encode("utf-8", "replace")


def _assert_write_complete(result: dict[str, Any], context: str) -> None:
    if result.get("complete") and result.get("written"):
        return
    raise ArkerError("internal", f"{context} did not complete", 200)


def _session_info(payload: dict[str, Any]) -> Session:
    env_val = payload.get("env") if isinstance(payload.get("env"), dict) else None
    return Session(
        session_id=str(payload["session_id"]),
        state=str(payload["state"]),
        cwd=str(payload["cwd"]),
        session_idx=int(payload.get("session_idx") or 0),
        env=env_val,
        started_at=_optional_str(payload.get("started_at")),
    )


def _tunnel(payload: dict[str, Any]) -> Tunnel:
    return Tunnel(
        vm_id=str(payload["vm_id"]),
        port=int(payload["port"]),
        visibility=str(payload["visibility"]),
        protocol=str(payload["protocol"]),
        state=str(payload["state"]),
        run_id=_optional_str(payload.get("run_id")),
        url=_optional_str(payload.get("url")),
        message=_optional_str(payload.get("message")),
        started_at=_optional_str(payload.get("started_at")),
    )


def _filesystem(payload: dict[str, Any]) -> Filesystem:
    return Filesystem(
        filesystem_id=str(payload["filesystem_id"]),
        name=str(payload["name"]),
        owner_org_id=str(payload["owner_org_id"]),
        created_at=str(payload["created_at"]),
        size_bytes=_optional_int(payload.get("size_bytes")),
    )


def _sync(payload: dict[str, Any]) -> Sync:
    return Sync(
        sync_id=str(payload["sync_id"]),
        vm_id=str(payload["vm_id"]),
        filesystem_id=str(payload["filesystem_id"]),
        path=str(payload["path"]),
        region=_optional_str(payload.get("region")),
    )


def _vm_info(payload: dict[str, Any]) -> Vm:
    return Vm(
        vm_id=str(payload.get("vm_id") or payload.get("id") or ""),
        owner_org_id=str(payload.get("owner_org_id", "")),
        created_at=str(payload.get("created_at", "")),
        public=bool(payload.get("public", False)),
        state=str(payload.get("state", "")),
        sessions=[_session_info(item) for item in payload.get("sessions", [])],
        name=_optional_str(payload.get("name")),
        root_source_vm_id=_optional_str(payload.get("root_source_vm_id")),
        root_source_vm_name=_optional_str(payload.get("root_source_vm_name")),
        region=_optional_str(payload.get("region")),
        provider=_optional_str(payload.get("provider")),
        started_at=_optional_str(payload.get("started_at")),
        vcpu_count=_optional_int(payload.get("vcpu_count")),
        memory_mib=_optional_int(payload.get("memory_mib")),
        disk_mib=_optional_int(payload.get("disk_mib")),
        worker_id=_optional_str(payload.get("worker_id")),
        tunnels=[_tunnel(t) for t in payload.get("tunnels", []) if isinstance(t, dict)],
    )


def _run_response(payload: dict[str, Any]) -> RunResult:
    if isinstance(payload.get("stdout"), str):
        return CompletedRunResult(
            stdout=_decode_bytes(str(payload["stdout"]), str(payload["stdout_encoding"])),
            stdout_encoding=str(payload["stdout_encoding"]),
            stderr=_decode_bytes(str(payload["stderr"]), str(payload["stderr_encoding"])),
            stderr_encoding=str(payload["stderr_encoding"]),
            exit_code=int(payload["exit_code"]),
            run_id=str(payload["run_id"]) if isinstance(payload.get("run_id"), str) else None,
            state=str(payload["state"]) if isinstance(payload.get("state"), str) else "completed",
            fail_reason=_optional_str(payload.get("fail_reason")),
        )

    if isinstance(payload.get("run_id"), str):
        return BackgroundRunResult(
            run_id=str(payload["run_id"]),
            state=str(payload["state"]) if isinstance(payload.get("state"), str) else "running",
            tunnels=[_tunnel(t) for t in payload.get("tunnels", []) if isinstance(t, dict)],
        )

    raise ArkerError("internal", "unrecognized run response shape", 200)


def _run_status_response(payload: dict[str, Any]) -> Run:
    retry_count = payload.get("retry_count")
    return Run(
        run_id=str(payload["run_id"]),
        state=str(payload["state"]),
        started_at=str(payload["started_at"]),
        stdout=_decode_bytes(str(payload["stdout"]), str(payload["stdout_encoding"])),
        stdout_encoding=str(payload["stdout_encoding"]),
        stderr=_decode_bytes(str(payload["stderr"]), str(payload["stderr_encoding"])),
        stderr_encoding=str(payload["stderr_encoding"]),
        tunnels=[_tunnel(t) for t in payload.get("tunnels", []) if isinstance(t, dict)],
        exit_code=_optional_int(payload.get("exit_code")),
        fail_reason=_optional_str(payload.get("fail_reason")),
        session_id=_optional_str(payload.get("session_id")),
        command=_optional_str(payload.get("command")),
        completed_at=_optional_str(payload.get("completed_at")),
        retry_count=int(retry_count) if isinstance(retry_count, int) else 0,
    )


def _run_summary(payload: dict[str, Any]) -> RunSummary:
    return RunSummary(
        run_id=str(payload["run_id"]),
        state=str(payload["state"]),
        started_at=str(payload["started_at"]),
        exit_code=_optional_int(payload.get("exit_code")),
        fail_reason=_optional_str(payload.get("fail_reason")),
        session_id=_optional_str(payload.get("session_id")),
        command=_optional_str(payload.get("command")),
        completed_at=_optional_str(payload.get("completed_at")),
    )


def _optional_str(value: Any) -> str | None:
    return value if isinstance(value, str) else None


def _optional_int(value: Any) -> int | None:
    return int(value) if isinstance(value, int) else None

# Backwards-compat: previously RunStatusResponse.
RunStatusResponse = Run
