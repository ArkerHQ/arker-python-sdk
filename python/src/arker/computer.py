"""Arker Python SDK.

A small wrapper around the VM API. Configure a region for the standard Arker
endpoints, or pass base_url directly for internal/dev targets.
"""

from __future__ import annotations

import base64
import dataclasses
import gzip
import hashlib
import io
import json
import os
import shlex
import tarfile
import tempfile
import re
import secrets
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
from typing import Any, Callable

CHUNK_SIZE = 4 * 1024 * 1024

# Target byte budget per batched sync_dir write request. Small changed files are
# accumulated up to this size and uploaded in one writes[] request, so a tree of
# many small files becomes a handful of round-trips instead of one-per-file.
# Kept well under the server's ~100 MiB request cap to leave room for base64
# expansion (~1.33x) and JSON overhead.
SYNC_DIR_BATCH_BYTES = 5 * 1024 * 1024

# Gzip a sync-write request body once it clears this size. Below it, gzip's CPU +
# framing overhead outweighs the wire savings on a fast link.
_GZIP_MIN_BYTES = 16 * 1024

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
    network: dict[str, Any] | None = None
    max_vcpus: int | None = None
    max_memory_mib: int | None = None
    min_memory_mib: int | None = None
    worker_id: str | None = None


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
    memory_requested_mib: int | None = None
    memory_achieved_mib: int | None = None
    memory_partial: bool = False
    type: str = "completed"


@dataclasses.dataclass(frozen=True)
class BackgroundRunResult:
    run_id: str
    state: str = "running"
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
class OrgRunListRow:
    source: str
    t_ms: int
    request_id: str
    run_id: str
    vm_id: str
    session_id: str
    region: str
    status: int
    total_ms: float
    queue_ms: float
    lambda_call_ms: float
    lambda_duration_ms: int
    executor_duration_ms: int
    executor_kind: str
    executor_cpu_ms: int
    executor_mem_mb: int
    lambda_cpu_ms: int
    lambda_mem_mb: int
    vm_vcpus: int
    vm_memory_mib: int
    path: str
    method: str
    command: str
    source_vm_id: str
    exit_code: int | None
    endpoint: str
    api_key_prefix: str
    body_bytes_in: int
    body_bytes_out: int
    body_in: str
    body_out: str


@dataclasses.dataclass(frozen=True)
class ListOrgRunsResponse:
    since: int
    until: int
    limit: int
    offset: int
    lite: bool
    rows: list[OrgRunListRow]


@dataclasses.dataclass(frozen=True)
class CancelRunResponse:
    cancelled: bool


@dataclasses.dataclass(frozen=True)
class ListSessionsResponse:
    sessions: list[Session]
    next_cursor: str | None = None


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
        egress: bool | str | dict[str, Any] | None = None,
        disk: bool | None = None,
        vcpu_count: int | None = None,
        memory_mib: int | None = None,
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
        # The contract folds vcpu/memory/disk into a single `resources` object.
        resources: dict[str, Any] | None = None
        if vcpu_count is not None or memory_mib is not None or disk_mib is not None:
            resources = {
                "vcpu": vcpu_count,
                "memory_mib": memory_mib,
                "disk_mib": disk_mib,
            }
        body = {
            "source_vm_id": source_vm_id,
            "source_vm_name": source_vm_name,
            "source_org_id": source_org_id,
            "name": name,
            "public": public,
            "network": network,
            "egress": egress,
            "disk": disk if disk is not None else True,
            "durable": durable,
            "resources": resources,
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

    def list_runs(
        self,
        *,
        since: int | None = None,
        until: int | None = None,
        vm: str | None = None,
        vm_ids: list[str] | None = None,
        region: str | None = None,
        provider: str | None = None,
        source: str | None = None,
        search: str | None = None,
        limit: int | None = None,
        offset: int | None = None,
        lite: bool | None = None,
        runtime: str | None = None,
        endpoint: str | None = None,
        actions: list[str] | None = None,
        status: list[str] | None = None,
        status_min: int | None = None,
        status_max: int | None = None,
        sort: str | None = None,
        dir: str | None = None,
    ) -> ListOrgRunsResponse:
        """List run activity across VMs through the control plane."""
        path = _build_query("/v1/runs", {
            "since": since,
            "until": until,
            "vm": vm,
            "vms": ",".join(vm_ids) if vm_ids else None,
            "region": region,
            "provider": provider,
            "source": source,
            "search": search,
            "limit": limit,
            "offset": offset,
            "lite": lite,
            "runtime": runtime,
            "endpoint": endpoint,
            "actions": ",".join(actions) if actions else None,
            "status": ",".join(status) if status else None,
            "status_min": status_min,
            "status_max": status_max,
            "sort": sort,
            "dir": dir,
        })
        payload = self._request("GET", path, base_url=self._control_base_url)
        return _org_runs_response(payload)

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
        gzip_body: bool = False,
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
            # gzip the request body on write-heavy sync calls: a JSON body of
            # base64 file content compresses ~1.3x for incompressible (recovering
            # base64's +33%) and much more for source, so the wire carries ~raw
            # bytes in one hop. Only the /sync route decodes content-encoding, so
            # callers opt in; below the threshold gzip's overhead isn't worth it.
            if gzip_body and len(data) >= _GZIP_MIN_BYTES:
                data = gzip.compress(data, 1)  # level 1: ~5x faster gzip, near-same ratio; sync is throughput-bound not ratio-bound
                headers["content-encoding"] = "gzip"

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
    network: dict[str, Any] | None
    max_vcpus: int | None
    max_memory_mib: int | None
    min_memory_mib: int | None
    started_at: str | None
    sessions: list[Session] | None

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
        network: bool | str | dict[str, Any] | None = None,
    ) -> Vm:
        """Update this VM's resource allocation (and optionally network) via
        ``PATCH /v1/vms/{id}``. Returns the updated :class:`Vm`."""
        resources: dict[str, Any] | None = None
        if vcpu_count is not None or memory_mib is not None or disk_mib is not None:
            resources = {"vcpu": vcpu_count, "memory_mib": memory_mib, "disk_mib": disk_mib}
        body: dict[str, Any] = {"resources": resources, "network": network}
        payload = self._client._request("PATCH", _vm_path(self.id), body, base_url=self.base_url)
        return _vm_info(payload)

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

    def _sync_write_stream(self, path: str, data: bytes, extract: str | None = None) -> None:
        """Pipelined raw streaming write to a LIVE VM: POST the raw file bytes to
        `/vms/{id}/sync-stream`; arkerd streams them to the guest over vsock AS
        THEY ARRIVE (one apparent hop, no base64, no S3 round-trip). Fastest path
        for a large write — the upload and the guest write fully overlap, so it
        matches/beats a host-side writer. Raises ArkerError(status=404) on an
        arkerd that predates the endpoint, so callers can fall back.

        When ``extract`` is set (``tar.gz``) the body is a gzip tar and ``path``
        is the destination DIRECTORY: arkerd untars it server-side in ONE round
        trip (the many-files win)."""
        import hashlib
        from urllib.parse import quote

        sha = hashlib.sha256(data).hexdigest()
        url = (
            f"{self.base_url}{_vm_path(self.id)}/sync-stream"
            f"?path={quote(path)}&size={len(data)}&sha256={sha}"
            + (f"&extract={extract}" if extract else "")
        )
        headers = {
            "authorization": f"Bearer {self._client._api_key}",
            "content-type": "application/octet-stream",
        }
        for attempt in range(self._client._retry.attempts):
            try:
                req = urllib.request.Request(url, method="POST", data=data, headers=headers)
                with urllib.request.urlopen(req, timeout=PRESIGNED_PUT_TIMEOUT_S) as response:
                    if response.status < 400:
                        try:
                            return json.loads(response.read())
                        except Exception:
                            return {}
                    status = response.status
            except urllib.error.HTTPError as error:
                status = error.code
            except urllib.error.URLError as error:
                if attempt == self._client._retry.attempts - 1:
                    raise ArkerError("network_error", f"stream write failed: {error}", 0) from error
                time.sleep(self._client._retry_delay(attempt))
                continue
            if status not in RETRYABLE_HTTP or attempt == self._client._retry.attempts - 1:
                raise ArkerError("internal", f"stream write failed: {status}", status)
            time.sleep(self._client._retry_delay(attempt))

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
                gzip_body=True,
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

    # ── Directory sync (rsync-style, manifest diff) ──────────────────
    def sync_dir(
        self,
        local_dir: str,
        remote_dir: str,
        *,
        cache: dict[str, tuple[int, int, str]] | None = None,
    ) -> "SyncDirResult":
        """Recursively sync a local directory INTO this VM at ``remote_dir``,
        rsync-style: fetch the VM's file *manifest* (per-file sha256) in one
        request, diff it against the local tree, and upload ONLY the files that
        are new or changed — batched into few requests instead of one-per-file.

        The remote manifest is authoritative. ``cache`` (an optional dict you own
        and reuse across calls) is a pure accelerator: it skips re-hashing local
        files whose (size, mtime) are unchanged. It never decides remote state,
        so it can never cause a stale or missing upload — worst case it hashes a
        file it didn't need to.

        Returns a :class:`SyncDirResult` (sent / skipped / bytes).
        """
        local_root = os.path.abspath(local_dir)
        remote_root = "/" + remote_dir.strip("/")

        # 1. Authoritative remote manifest: rel_path -> sha256, for DELTA re-sync.
        #    SKIP it on the FIRST sync to a given remote_root: there is nothing to
        #    diff against (every local file is new), so the manifest round-trip +
        #    its host-side rootfs open is pure overhead on the common
        #    fork -> sync-workspace path. sync_dir is additive (never deletes
        #    remote files), so sending everything is identical to diffing against
        #    an empty remote. Subsequent syncs to the same remote do the manifest
        #    for a true delta. Time the manifest round-trip as the cost model's
        #    RTT estimate; on the skipped first sync use a small default.
        synced = getattr(self, "_synced_remotes", None)
        if synced is None:
            synced = self._synced_remotes = set()
        if remote_root in synced:
            remote = self._remote_manifest(remote_root)
        else:
            remote = {}
        synced.add(remote_root)
        rtt_s = self._sync_rtt_estimate()

        # 2. Enumerate local regular files (skip symlinks — the manifest lists
        #    regular files only, so a symlink would always look "missing").
        local_files: dict[str, tuple[str, int, int]] = {}
        for root, _dirs, files in os.walk(local_root):
            for name in files:
                abs_path = os.path.join(root, name)
                if os.path.islink(abs_path) or not os.path.isfile(abs_path):
                    continue
                rel = os.path.relpath(abs_path, local_root).replace(os.sep, "/")
                st = os.stat(abs_path)
                local_files[rel] = (abs_path, st.st_size, st.st_mtime_ns)

        # 3. Diff → the set of new/changed files (relative paths).
        result = SyncDirResult()
        changed: list[tuple[str, str]] = []  # (rel, abs_path)
        remote_empty = not remote  # cold sync → every local file is new, skip hashing
        for rel, (abs_path, size, mtime_ns) in sorted(local_files.items()):
            if not remote_empty:
                local_hash = _file_hash_cached(abs_path, size, mtime_ns, cache)
                if remote.get(rel) == local_hash:
                    result.skipped += 1
                    continue
            changed.append((rel, abs_path))
            result.sent += 1
            result.bytes_sent += size

        # 4. Ship the changed files as ONE tarball and extract it in the guest.
        #    The GUEST does the file writes (via `tar -x`), so they are always
        #    consistent with its own filesystem — no host-side XFS races — and a
        #    single stream + one extract is far faster than one write per file.
        #    The extract's exit code is checked, so a failure is surfaced, never
        #    a silent partial (the manifest also fails safe: any omitted file is
        #    re-sent next call).
        if changed:
            self._sync_changed(changed, remote_root, rtt_s)
        return result

    def _sync_rtt_estimate(self) -> float:
        """Cached client->arkerd round-trip estimate for the sync cost model:
        ~<1 ms co-located, ~30 ms over WAN. Distinguishes co-located (parallel
        direct wins for few files) from WAN (batched extract wins).

        Probes with a GET on the VM's OWN metadata endpoint — a pure arkerd hop
        that never touches the guest. The old probe wrote a byte through to the
        guest, which measured guest exec cold-start (~60 ms on a freshly booted
        VM), not network RTT: it both mis-sized the cost model AND wasted ~60 ms
        of real time on every first sync. Cached per computer instance."""
        r = getattr(self, "_rtt_cache", None)
        if r is not None:
            return r
        r = 0.01
        try:
            t0 = time.time()
            self._client._request("GET", _vm_path(self.id), base_url=self.base_url)
            r = max(3e-4, time.time() - t0)
        except Exception:
            pass
        self._rtt_cache = r
        return r

    def _sync_changed(
        self, changed: list[tuple[str, str]], remote_root: str, rtt_s: float
    ) -> None:
        """Pick the cheapest way to ship ``changed`` from a concrete cost model,
        so we win at any RTT and file count.

        Two strategies, each a real measured cost:
          - DIRECT: one streamed raw write per file (no tar, no guest untar). Cost
            ≈ N round-trips + bytes/BW. Best for FEW files — a single tiny file is
            ~3 ms here vs ~60-460 ms through the extract path's guest untar
            cold-start (which has no work to amortize it).
          - EXTRACT: one gzip tar streamed + untarred server-side in ONE round
            trip. Cost ≈ 1 round-trip + bytes/BW + N*untar + a fixed untar
            overhead. Best for MANY files — batches N writes into one hop.

        The crossover is data-driven: co-located (RTT≈0) DIRECT wins up to ~tens
        of files; over a 27 ms WAN it flips to EXTRACT after just a few. """
        import math
        n = len(changed)
        total = sum(os.path.getsize(a) for _, a in changed)
        nested = any("/" in rel.strip("/") for rel, _ in changed)
        BW = 15e6              # bytes/s streamed write throughput (measured ~13-15 MB/s)
        # DIRECT's per-file cost is NOT just network: each keep-alive connection
        # serializes request→response (HTTP/1.1, no pipelining), so every write
        # also pays the server's per-request handling (parse+sha+guest write). This
        # ~5 ms/req dominates when RTT≈0 (co-located) and is why direct grows with
        # N (measured ~5-7 ms/req on loopback: 600→~250 ms, 2000→~650 ms).
        REQ_PROC = 5e-3        # server-side handling per serialized keep-alive write
        # EXTRACT is one guest `tar -x`: a fixed spawn/cold-start plus a per-file
        # cost that AMORTIZES with batch size (the untar streams). A flat per-file
        # term badly over-charges large N; the real curve is sub-linear. Measured
        # clean (status-checked, correctness-verified): n=1→~90 ms, 600→~336 ms,
        # 2000→~557 ms — an almost exact 0.080 s + 0.0104·√n fit.
        EXTRACT_FLOOR = 0.080  # guest.exec untar spawn/cold-start
        EXTRACT_SQRT = 0.0104  # per-√file streamed-untar cost (batch amortized)
        P = self._SYNC_DIRECT_PARALLELISM
        # Estimate the extract path's upload size by probing compressibility on a
        # small sample — for code this shrinks the upload a lot (extract wins on
        # bytes); for incompressible blobs it's ~1.0 (extract only adds untar
        # overhead, so parallel direct wins for small/moderate N).
        probe = b"".join(open(a, "rb").read(4096) for _, a in changed[:12])
        gz_ratio = len(gzip.compress(probe, 1)) / max(1, len(probe)) if probe else 1.0
        total_gz = int(total * min(1.0, gz_ratio))
        # DIRECT: parallel raw writes, no untar → ceil(N/P) serialized waves, each
        # paying one RTT plus the server's per-request handling.
        direct_cost = math.ceil(n / P) * (rtt_s + REQ_PROC) + total / BW
        # EXTRACT: one round-trip, gzip'd upload + server untar (floor + √n).
        extract_cost = (
            rtt_s + total_gz / BW + EXTRACT_FLOOR + EXTRACT_SQRT * math.sqrt(n)
        )
        # ROBUSTNESS CAP: direct issues N per-file requests, and arkerd's
        # per-request handling degrades with host load / VM count — a many-file
        # direct sync that clocks ~250 ms in isolation was measured ~2 s on a busy
        # host, whereas extract (ONE request, ONE guest untar) stays flat. So above
        # a modest file count we take the single-request path even if the clean
        # cost model marginally prefers direct: bounded worst case beats a slightly
        # better best case. Below the cap, direct is 1-few waves and low-risk.
        DIRECT_MAX_FILES = 256
        if n <= DIRECT_MAX_FILES and direct_cost <= extract_cost:
            self._sync_direct_write(changed, remote_root, nested)
        else:
            # Many files → ONE round-trip: gzip tar + server-side guest untar. A
            # single `tar -x` batches the writes/fsync in one guest process, which
            # is at parity with E2B's batched write_files (both ~500-600 ms for
            # ~2000 incompressible files) and beat a per-file batched-binary
            # endpoint in testing — the in-guest agent serializes per-file writes,
            # so `tar`'s single-process untar is the more efficient guest path.
            self._upload_and_extract_tarball(changed, remote_root)

    _SYNC_DIRECT_PARALLELISM = 16

    def _sync_direct_write(
        self, changed: list[tuple[str, str]], remote_root: str, nested: bool
    ) -> None:
        """Write each changed file straight to remote_root/rel via the pipelined
        stream endpoint (no tar, no guest untar), fanned out concurrently over a
        POOL of keep-alive connections. The stream write creates missing parent
        directories, so there is NO separate mkdir round-trip.

        E2B batches N files into one request; we instead parallelize N raw
        single-file streams, each reusing a persistent HTTP/1.1 connection (one
        per worker thread, NOT one per file — that per-write connection setup was
        the whole remaining gap). Wall time becomes bandwidth-bound, with no
        untar/gzip overhead — the win for many small or incompressible files."""
        import concurrent.futures
        import hashlib
        import http.client
        import threading as _threading
        from urllib.parse import quote, urlsplit

        sp = urlsplit(self.base_url)
        is_https = sp.scheme == "https"
        host = sp.hostname
        port = sp.port or (443 if is_https else 80)
        base_path = sp.path.rstrip("/")
        vm_path = _vm_path(self.id)
        api_key = self._client._api_key
        tls = _threading.local()
        conns: list[http.client.HTTPConnection] = []
        conns_lock = _threading.Lock()

        def _conn() -> "http.client.HTTPConnection":
            c = getattr(tls, "conn", None)
            if c is None:
                cls = http.client.HTTPSConnection if is_https else http.client.HTTPConnection
                c = cls(host, port, timeout=PRESIGNED_PUT_TIMEOUT_S)
                tls.conn = c
                with conns_lock:
                    conns.append(c)
            return c

        def _one(item: tuple[str, str]) -> None:
            rel, abs_path = item
            with open(abs_path, "rb") as fh:
                data = fh.read()
            dest = f"{remote_root}/{rel}"
            sha = hashlib.sha256(data).hexdigest()
            path = (
                f"{base_path}{vm_path}/sync-stream"
                f"?path={quote(dest)}&size={len(data)}&sha256={sha}"
            )
            headers = {
                "authorization": f"Bearer {api_key}",
                "content-type": "application/octet-stream",
                "content-length": str(len(data)),
            }
            for attempt in range(self._client._retry.attempts):
                try:
                    conn = _conn()
                    conn.request("POST", path, body=data, headers=headers)
                    resp = conn.getresponse()
                    status = resp.status
                    resp.read()  # drain so the connection can be reused
                    if status < 400:
                        return
                    if status == 404:
                        # arkerd predates /sync-stream: inline/presigned fallback.
                        if len(data) > CHUNK_SIZE:
                            self._sync_write_presigned(dest, data)
                        else:
                            self._sync_write_inline(dest, data)
                        return
                    if status in RETRYABLE_HTTP and attempt < self._client._retry.attempts - 1:
                        tls.conn = None  # drop a poisoned connection, reconnect
                        time.sleep(self._client._retry_delay(attempt))
                        continue
                    raise ArkerError("internal", f"direct write failed: {status}", status)
                except (http.client.HTTPException, OSError) as error:
                    tls.conn = None  # connection died; force a fresh one
                    if attempt == self._client._retry.attempts - 1:
                        raise ArkerError(
                            "network_error", f"direct write failed: {error}", 0
                        ) from error
                    time.sleep(self._client._retry_delay(attempt))

        try:
            if len(changed) <= 1:
                for item in changed:
                    _one(item)
            else:
                workers = min(self._SYNC_DIRECT_PARALLELISM, len(changed))
                with concurrent.futures.ThreadPoolExecutor(max_workers=workers) as ex:
                    for _ in ex.map(_one, changed):
                        pass
        finally:
            for c in conns:
                try:
                    c.close()
                except Exception:
                    pass

    def _upload_and_extract_tarball(
        self, changed: list[tuple[str, str]], remote_root: str
    ) -> None:
        """Tar the changed files (paths relative to ``remote_root``), upload the
        tarball in one write, and extract it in the guest with `tar -x`."""
        # Build the tar entirely IN MEMORY — no temp file. A temp file adds a
        # write+read of the whole payload (tens of ms on the hot path) for no
        # benefit; the tar is already bounded by the changed-set we chose to batch.
        buf = io.BytesIO()
        with tarfile.open(fileobj=buf, mode="w") as tar:
            for rel, abs_path in changed:
                tar.add(abs_path, arcname=rel, recursive=False)
        data = buf.getvalue()

        # Always gzip for the 1-round-trip extract endpoint (level 1: ~5x faster
        # gzip, near-same ratio; sync is throughput-bound not ratio-bound).
        payload = gzip.compress(data, 1)

        # 1 ROUND-TRIP: stream the gzip tar and extract it server-side straight
        # into remote_root. Same round-trip count as E2B's batched write_files,
        # but gzip'd bytes + a faster co-located untar — the many-files win.
        try:
            resp = self._sync_write_stream(remote_root, payload, extract="tar.gz")
            if isinstance(resp, dict) and resp.get("op") == "extract_stream":
                return
            # Server has /sync-stream but ignored `extract` (arkerd predating the
            # extract param): the gzip tar landed AT remote_root as a file —
            # recover it into the directory (one extra guest op, old servers only).
            q = shlex.quote
            self.run(
                f'set -e; d={q(remote_root)}; t="$d.__arksync.tgz"; '
                f'mv "$d" "$t"; mkdir -p "$d"; tar -xzf "$t" -C "$d"; rm -f "$t"'
            )
            return
        except ArkerError as e:
            if e.status != 404:
                raise
            # No /sync-stream endpoint at all: fall through to the legacy
            # temp-write + guest-untar path below.

        remote_tar = f"/tmp/.arker-sync-{_ulid()}.tar.gz"
        if len(payload) > CHUNK_SIZE:
            self._sync_write_presigned(remote_tar, payload)
        else:
            self._sync_write_inline(remote_tar, payload)
        q = shlex.quote
        cmd = (
            f"set -e; mkdir -p {q(remote_root)}; "
            f"tar -xzf {q(remote_tar)} -C {q(remote_root)}; "
            f"rm -f {q(remote_tar)}"
        )
        res = self.run(cmd)
        code = getattr(res, "exit_code", None)
        state = getattr(res, "state", None)
        if code not in (0, None) or state == "failed":
            stderr = getattr(res, "stderr", b"")
            if isinstance(stderr, (bytes, bytearray)):
                stderr = stderr.decode("utf-8", "replace")
            raise ArkerError(
                "internal",
                f"sync_dir tar extract failed (exit={code}, state={state}): {stderr[:300]}",
                200,
            )

    def _remote_manifest(self, path: str) -> dict[str, str]:
        """Fetch the VM's file manifest under ``path`` → {rel_path: sha256}."""
        payload = self._client._request(
            "POST", f"{_vm_path(self.id)}/sync",
            {"op": "manifest", "path": path}, base_url=self.base_url,
        )
        entries = payload.get("entries")
        if not isinstance(entries, list):
            return {}
        out: dict[str, str] = {}
        for entry in entries:
            if isinstance(entry, dict) and "path" in entry and "hash" in entry:
                out[str(entry["path"])] = str(entry["hash"])
        return out

    def _flush_write_batch(self, items: list[tuple[str, bytes]]) -> None:
        """Upload a batch of small files in ONE write request (writes[])."""
        if not items:
            return
        entries = [
            {
                "path": path, "size": len(data), "upload_id": _ulid(),
                "content": base64.b64encode(data).decode("ascii"),
                "start": 0, "end": len(data),
            }
            for path, data in items
        ]
        payload = self._client._request(
            "POST", f"{_vm_path(self.id)}/sync",
            {"op": "write", "writes": entries}, base_url=self.base_url,
            gzip_body=True,
        )
        results = payload.get("results")
        if not isinstance(results, list) or len(results) != len(entries):
            raise ArkerError("internal", "batch write results count mismatch", 200)
        for result, (path, _data) in zip(results, items):
            if not isinstance(result, dict):
                raise ArkerError("internal", "batch write result must be an object", 200)
            _assert_write_complete(result, f"batch write {path}")

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

    # ── Interactive PTY ────────────────────────────────────────────────
    def create_pty(
        self,
        *,
        on_data: Callable[[bytes], None] | None = None,
        session_id: str | None = None,
        cols: int | None = None,
        rows: int | None = None,
        command: str | None = None,
        persist: bool | None = None,
        cancel_ttl_secs: int | None = None,
        on_close: Callable[[Pty.CloseEvent], None] | None = None,
        on_error: Callable[[Exception], None] | None = None,
        use_ticket: bool = True,
    ) -> Pty:
        """Open an interactive pseudo-terminal in this VM over a WebSocket.

        Mirrors the TypeScript ``connectPty``. Creates a session if
        ``session_id`` is omitted, mints a browser PTY ticket
        (``POST .../pty-ticket``), then opens the PTY WebSocket against this
        VM's *regional* base url. Server→client binary frames are delivered to
        ``on_data`` from a background reader thread.

        Reconnect/persist: pass an existing ``session_id`` with
        ``persist=True`` (the default backend behavior) to reattach to a
        running shell (scrollback is replayed).

        Requires the ``websocket-client`` package — ``pip install 'arker[pty]'``.
        """
        sid = session_id or self.create_session().session_id

        params: dict[str, Any] = {
            "cols": _clamp_pty_dimension(cols) if cols is not None else None,
            "rows": _clamp_pty_dimension(rows) if rows is not None else None,
            "command": command,
            "persist": persist,
            "cancel_ttl_secs": int(cancel_ttl_secs)
            if cancel_ttl_secs and cancel_ttl_secs > 0
            else None,
        }

        ticket: str | None = None
        headers: dict[str, str] | None = None
        if use_ticket:
            response = self._client._request(
                "POST",
                f"{_vm_path(self.id)}/sessions/{_segment(sid)}/pty-ticket",
                {},
                base_url=self.base_url,
            )
            ticket = str(response["ticket"])
        else:
            # Header auth (server-side use): Bearer key on the WS upgrade.
            headers = {"authorization": f"Bearer {self._client._api_key}"}

        ws_params = dict(params)
        if ticket is not None:
            ws_params["ticket"] = ticket
        url = _build_pty_ws_url(self.base_url, self.id, sid, ws_params)

        return Pty(
            session_id=sid,
            url=url,
            headers=headers,
            on_data=on_data,
            on_close=on_close,
            on_error=on_error,
        )


class Pty:
    """An interactive pseudo-terminal connection to a VM over a WebSocket.

    Mirrors the TypeScript ``PtyConnection``. Server→client terminal output is
    delivered to the ``on_data`` callback from a background reader thread; use
    :meth:`send_input` to write stdin, :meth:`resize` to change dimensions,
    :meth:`kill` to destroy the shell, and :meth:`close` to detach.

    Obtain one via :meth:`VM.create_pty`. Requires the ``websocket-client``
    package (``pip install 'arker[pty]'``).
    """

    @dataclasses.dataclass
    class CloseEvent:
        code: int | None = None
        reason: str | None = None

    def __init__(
        self,
        *,
        session_id: str,
        url: str,
        headers: dict[str, str] | None = None,
        on_data: Callable[[bytes], None] | None = None,
        on_close: Callable[[Pty.CloseEvent], None] | None = None,
        on_error: Callable[[Exception], None] | None = None,
        connect_timeout: float = 30.0,
    ) -> None:
        try:
            import websocket  # type: ignore
        except ImportError as error:  # pragma: no cover - import guard
            raise ArkerError(
                "missing_dependency",
                "interactive PTY needs the 'websocket-client' package; "
                "install with: pip install 'arker[pty]'",
                0,
            ) from error

        self.session_id = session_id
        self._data_listeners: list[Callable[[bytes], None]] = []
        self._close_listeners: list[Callable[[Pty.CloseEvent], None]] = []
        self._error_listeners: list[Callable[[Exception], None]] = []
        if on_data is not None:
            self._data_listeners.append(on_data)
        if on_close is not None:
            self._close_listeners.append(on_close)
        if on_error is not None:
            self._error_listeners.append(on_error)

        self._open = threading.Event()
        self._open_error: Exception | None = None
        self._closed = False

        header_list = [f"{k}: {v}" for k, v in (headers or {}).items()]
        self._ws = websocket.WebSocketApp(
            url,
            header=header_list,
            on_open=self._handle_open,
            on_message=self._handle_message,
            on_error=self._handle_error,
            on_close=self._handle_close,
        )
        self._thread = threading.Thread(
            target=self._ws.run_forever, name="arker-pty", daemon=True
        )
        self._thread.start()

        if not self._open.wait(timeout=connect_timeout):
            self.close()
            raise ArkerError("network_error", "PTY WebSocket failed to open (timeout)", 0)
        if self._open_error is not None:
            raise ArkerError("network_error", f"PTY WebSocket failed to open: {self._open_error}", 0)

    # ── Listener registration ──────────────────────────────────────────
    def on_data(self, listener: Callable[[bytes], None]) -> Callable[[], None]:
        self._data_listeners.append(listener)
        return lambda: self._data_listeners.remove(listener) if listener in self._data_listeners else None

    def on_close(self, listener: Callable[[Pty.CloseEvent], None]) -> Callable[[], None]:
        self._close_listeners.append(listener)
        return lambda: self._close_listeners.remove(listener) if listener in self._close_listeners else None

    def on_error(self, listener: Callable[[Exception], None]) -> Callable[[], None]:
        self._error_listeners.append(listener)
        return lambda: self._error_listeners.remove(listener) if listener in self._error_listeners else None

    # ── I/O ─────────────────────────────────────────────────────────────
    def send_input(self, data: bytes | str) -> None:
        """Write stdin bytes to the terminal (a binary frame)."""
        import websocket  # type: ignore

        payload = data.encode("utf-8") if isinstance(data, str) else bytes(data)
        self._ws.send(payload, opcode=websocket.ABNF.OPCODE_BINARY)

    # Alias matching the TS ``send`` surface.
    send = send_input

    def resize(self, cols: int, rows: int) -> None:
        """Resize the terminal (a JSON control frame)."""
        self._send_control({
            "type": "resize",
            "cols": _clamp_pty_dimension(cols),
            "rows": _clamp_pty_dimension(rows),
        })

    def kill(self) -> None:
        """Destroy the shell (a JSON ``kill`` control frame)."""
        self._send_control({"type": "kill"})

    def ping(self) -> None:
        self._send_control({"type": "ping"})

    def close(self, code: int | None = None, reason: str | None = None) -> None:
        """Detach: close the WebSocket. With ``persist`` the shell keeps
        running and can be reattached via the same ``session_id``."""
        try:
            if code is not None:
                self._ws.close(status=code, reason=(reason or "").encode("utf-8"))
            else:
                self._ws.close()
        except Exception:
            pass

    # ── Internals ───────────────────────────────────────────────────────
    def _send_control(self, message: dict[str, Any]) -> None:
        import websocket  # type: ignore

        self._ws.send(json.dumps(message), opcode=websocket.ABNF.OPCODE_TEXT)

    def _handle_open(self, _ws: Any) -> None:
        self._open.set()

    def _handle_message(self, _ws: Any, message: Any) -> None:
        if isinstance(message, str):
            message = message.encode("utf-8")
        for listener in list(self._data_listeners):
            listener(message)

    def _handle_error(self, _ws: Any, error: Any) -> None:
        exc = error if isinstance(error, Exception) else Exception(str(error))
        if not self._open.is_set():
            self._open_error = exc
            self._open.set()
        for listener in list(self._error_listeners):
            listener(exc)

    def _handle_close(self, _ws: Any, code: Any, reason: Any) -> None:
        self._closed = True
        # Unblock the constructor if we closed before opening.
        self._open.set()
        event = Pty.CloseEvent(
            code=int(code) if isinstance(code, int) else None,
            reason=reason if isinstance(reason, str) else None,
        )
        for listener in list(self._close_listeners):
            listener(event)


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


def _clamp_pty_dimension(value: int) -> int:
    try:
        n = int(value)
    except (TypeError, ValueError):
        return 1
    return max(1, min(1000, n))


def _build_pty_ws_url(base_url: str, vm_id: str, session_id: str, params: dict[str, Any]) -> str:
    """Build the ``wss://`` PTY URL for ``base_url`` (the VM's regional base)."""
    http_url = f"{_normalize_base_url(base_url)}{_vm_path(vm_id)}/sessions/{_segment(session_id)}/pty"
    parsed = urllib.parse.urlsplit(http_url)
    if parsed.scheme == "https":
        scheme = "wss"
    elif parsed.scheme == "http":
        scheme = "ws"
    else:
        raise ValueError(f"unsupported PTY WebSocket protocol: {parsed.scheme}")
    pairs: list[tuple[str, str]] = []
    for key, value in params.items():
        if value is None:
            continue
        if isinstance(value, bool):
            value = "true" if value else "false"
        pairs.append((key, str(value)))
    query = urllib.parse.urlencode(pairs)
    return urllib.parse.urlunsplit((scheme, parsed.netloc, parsed.path, query, ""))


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


@dataclasses.dataclass
class SyncDirResult:
    """Outcome of :meth:`VM.sync_dir`."""

    sent: int = 0
    """Files uploaded (new or changed)."""
    skipped: int = 0
    """Files whose remote hash already matched (nothing sent)."""
    bytes_sent: int = 0
    """Total bytes of the uploaded files."""


def _file_hash_cached(
    abs_path: str,
    size: int,
    mtime_ns: int,
    cache: dict[str, tuple[int, int, str]] | None,
) -> str:
    """Lowercase-hex sha256 of a file, reusing ``cache`` when (size, mtime) are
    unchanged. The cache is a pure accelerator: on any mismatch (or no cache) the
    file is re-hashed, so a stale cache entry can never cause a wrong upload."""
    if cache is not None:
        cached = cache.get(abs_path)
        if cached is not None and cached[0] == size and cached[1] == mtime_ns:
            return cached[2]
    hasher = hashlib.sha256()
    with open(abs_path, "rb") as fh:
        for block in iter(lambda: fh.read(1024 * 1024), b""):
            hasher.update(block)
    digest = hasher.hexdigest()
    if cache is not None:
        cache[abs_path] = (size, mtime_ns, digest)
    return digest


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
        network=payload.get("network") if isinstance(payload.get("network"), dict) else None,
        max_vcpus=_optional_int(payload.get("max_vcpus")),
        max_memory_mib=_optional_int(payload.get("max_memory_mib")),
        min_memory_mib=_optional_int(payload.get("min_memory_mib")),
        worker_id=_optional_str(payload.get("worker_id")),
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
            memory_requested_mib=_optional_int(payload.get("memory_requested_mib")),
            memory_achieved_mib=_optional_int(payload.get("memory_achieved_mib")),
            memory_partial=_optional_bool(payload.get("memory_partial")),
        )

    if isinstance(payload.get("run_id"), str):
        return BackgroundRunResult(
            run_id=str(payload["run_id"]),
            state=str(payload["state"]) if isinstance(payload.get("state"), str) else "running",
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


def _org_runs_response(payload: dict[str, Any]) -> ListOrgRunsResponse:
    return ListOrgRunsResponse(
        since=int(payload["since"]),
        until=int(payload["until"]),
        limit=int(payload["limit"]),
        offset=int(payload["offset"]),
        lite=bool(payload["lite"]),
        rows=[_org_run_list_row(item) for item in payload.get("rows", []) if isinstance(item, dict)],
    )


def _org_run_list_row(payload: dict[str, Any]) -> OrgRunListRow:
    return OrgRunListRow(
        source=str(payload["source"]),
        t_ms=int(payload["t_ms"]),
        request_id=str(payload["request_id"]),
        run_id=str(payload["run_id"]),
        vm_id=str(payload["vm_id"]),
        session_id=str(payload["session_id"]),
        region=str(payload["region"]),
        status=int(payload["status"]),
        total_ms=float(payload["total_ms"]),
        queue_ms=float(payload["queue_ms"]),
        lambda_call_ms=float(payload["lambda_call_ms"]),
        lambda_duration_ms=int(payload["lambda_duration_ms"]),
        executor_duration_ms=int(payload["executor_duration_ms"]),
        executor_kind=str(payload["executor_kind"]),
        executor_cpu_ms=int(payload["executor_cpu_ms"]),
        executor_mem_mb=int(payload["executor_mem_mb"]),
        lambda_cpu_ms=int(payload["lambda_cpu_ms"]),
        lambda_mem_mb=int(payload["lambda_mem_mb"]),
        vm_vcpus=int(payload["vm_vcpus"]),
        vm_memory_mib=int(payload["vm_memory_mib"]),
        path=str(payload["path"]),
        method=str(payload["method"]),
        command=str(payload["command"]),
        source_vm_id=str(payload["source_vm_id"]),
        exit_code=_optional_int(payload.get("exit_code")),
        endpoint=str(payload["endpoint"]),
        api_key_prefix=str(payload["api_key_prefix"]),
        body_bytes_in=int(payload["body_bytes_in"]),
        body_bytes_out=int(payload["body_bytes_out"]),
        body_in=str(payload["body_in"]),
        body_out=str(payload["body_out"]),
    )


def _optional_str(value: Any) -> str | None:
    return value if isinstance(value, str) else None


def _optional_int(value: Any) -> int | None:
    return int(value) if isinstance(value, int) else None


def _optional_bool(value: Any) -> bool:
    return value if isinstance(value, bool) else False

# Backwards-compat: previously RunStatusResponse.
RunStatusResponse = Run
