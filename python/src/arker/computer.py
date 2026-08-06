"""Arker Python SDK.

A small wrapper around the VM API. Configure a region for the standard Arker
endpoints, or pass base_url directly for internal/dev targets.
"""

from __future__ import annotations

import atexit
import base64
import dataclasses
import hashlib
import json
import os
import re
import secrets
import shlex
import tarfile
import tempfile
import threading
import time
import types
import urllib.parse
from typing import Any, Callable, TypeVar, get_args, get_origin, get_type_hints

import httpx

from .generated.api_models import (
    BackgroundRunResponse,
    CancelRunResponse,
    CompletedRunResponse,
    CreateSessionRequest,
    DeleteFilesystemResponse,
    DeleteSessionResponse,
    DeleteSyncResponse,
    DeleteVmResponse,
    ErrorResponse,
    Filesystem,
    FilesystemCreateRequest,
    ForkRequest1,
    ForkRequest2,
    ListFilesystemsResponse,
    ListFilesystemsParameters,
    ListOrgRunsResponse,
    ListOrgRunsParameters,
    ListRunsResponse,
    ListRunsParameters,
    ListSessionsResponse,
    ListSessionsParameters,
    ListSyncsResponse,
    ListSyncsParameters,
    ListVmsResponse,
    ListVmsParameters,
    NetworkInput,
    OrgRunListRow,
    PatchSessionRequest,
    PatchSessionResponse,
    PatchVmRequest,
    PolicyDoc,
    PtyTicketResponse,
    Run,
    RunRequest,
    RunResponse,
    RunSummary,
    Session,
    Sync,
    SyncChunkWrite,
    SyncCreateRequest,
    SyncManifestOperationRequest,
    SyncManifestResponse,
    SyncPresignedWriteCommit,
    SyncPresignedWriteRequest,
    SyncPresignedWriteRequestResult,
    SyncReadInlineResponse,
    SyncReadOperationRequest,
    SyncReadPresignedResponse,
    SyncReadResponse,
    SyncWriteEntry,
    SyncWriteOperationRequest,
    SyncWriteResponse,
    SyncWriteResult,
    Vm,
    VmNetwork,
    VmResources,
)

Model = TypeVar("Model")


class _UnsetType:
    pass


class _ExplicitNullType:
    pass


_UNSET = _UnsetType()
_EXPLICIT_NULL = _ExplicitNullType()

CHUNK_SIZE = 4 * 1024 * 1024
# Max raw bytes written inline in ONE /sync request, as multiple CHUNK_SIZE
# chunks sharing an upload_id. Server budgets: 5MB per chunk, 20MB decoded per
# request — 16MB = 4 chunks, inside both. Files above this take the presigned
# blob path, where resumable multipart genuinely earns its double transfer.
INLINE_WRITE_LIMIT = 16 * 1024 * 1024

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
# ── Synchronous run() auto-poll ────────────────────────────────────
# When a run outlives its server-side sync window (``time_to_background``),
# the API hands back a background ack carrying a run_id. For a synchronous
# caller (one that did not ask to background) run() then polls get_run()
# under the hood until the run reaches a terminal state and returns the
# completed run — so the caller transparently gets the final result.
RUN_POLL_INITIAL_S = 0.5
RUN_POLL_MAX_S = 3.0
RUN_POLL_BACKOFF = 1.5
# Slack beyond the run's kill bound before we stop polling and raise a timeout.
RUN_POLL_MARGIN_S = 30.0
# Server default kill bound (seconds) used when ``timeout`` is unset or 0 (disabled).
DEFAULT_RUN_TIMEOUT_S = 3600
# Terminal run states — RunState ("running" | "completed" | "failed" |
# "cancelled") minus the sole non-terminal "running".
TERMINAL_RUN_STATES = frozenset({"completed", "failed", "cancelled"})
PRESIGNED_PUT_TIMEOUT_S = 600
RETRYABLE_HTTP = {429, 502, 503, 504}
RETRYABLE_CODES = {
    "unavailable",
    "bad_gateway",
    "stale_route",
}
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
    "macos-full",
})


@dataclasses.dataclass(frozen=True)
class RetryOptions:
    attempts: int = DEFAULT_RETRY_ATTEMPTS
    base_delay_s: float = DEFAULT_RETRY_BASE_DELAY_S
    max_delay_s: float = DEFAULT_RETRY_MAX_DELAY_S
    jitter_s: float = DEFAULT_RETRY_JITTER_S


# ── Resources ───────────────────────────────────────────────────────


@dataclasses.dataclass(frozen=True)
class VmList:
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

# Backwards-compat aliases — pre-rename names. Drop in a future major.
VmInfo = Vm
SessionInfo = Session


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


# Result of VM.run(). A synchronous call (``background`` unset/False) always
# returns a CompletedRunResult — if the run outlives its sync window run()
# polls it to completion under the hood. Only an explicit ``background=True``
# yields a BackgroundRunResult (the running ack, returned immediately for the
# caller to poll via VM.get_run()).
RunResult = CompletedRunResult | BackgroundRunResult


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
        description: str | None = None,
        public: bool | None = None,
        ssh_public_keys: list[str] | None = None,
        network: dict[str, Any] | None = None,
        egress: dict[str, Any] | bool | str | None = None,
        disk: bool | None = None,
        vcpu_count: int | None = None,
        memory_mib: int | None = None,
        disk_mib: int | None = None,
        durable: bool | None = None,
        platforms: list[str] | None = None,
        layers: list[str] | None = None,
        policies: PolicyDoc | dict[str, Any] | None = None,
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
        (optional) is the *new* VM's name in your org. ``description`` is a
        short description owned by the new VM and is never inherited.

        ``policies`` is the child's network policy document. Omit it to inherit
        the source VM's policy, re-encrypted under the child's own key. Pass a
        document to replace it — even an empty
        ``{"policies": []}``, which clears to allow-all rather than inheriting.
        Pass ``ssh_public_keys`` to authorize keys on the new VM.

        ``layers`` selects which layers of the source the child inherits. Omit
        it for the default full fork (``["disk", "memory"]``): the child inherits
        both the filesystem and a copy of the source's live RAM, so it resumes
        warm. Pass ``["disk"]`` for a disk-only fork: the child inherits only the
        filesystem and cold-boots with fresh RAM — a much cheaper fork (no RAM
        snapshot to copy) at the cost of a cold first ``run``. Trades fork
        latency for first-run latency; pick per workload.
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
        if network is not None or egress is not None:
            raise ArkerError(
                "bad_request",
                "fork network/egress inputs were removed; use policies",
                400,
            )
        # A public golden by name defaults to the Arker org; any other name
        # defaults (server-side) to the caller's own org. Explicit wins;
        # irrelevant when forking by id.
        if source_vm_name and source_org_id is None and source_vm_name in GOLDEN_NAMES:
            source_org_id = ARKER_ORG_ID
        # The contract folds vcpu/memory/disk into a single `resources` object.
        resources: VmResources | None = None
        if vcpu_count is not None or memory_mib is not None or disk_mib is not None:
            resources = VmResources(
                vcpu=vcpu_count,
                memory_mib=memory_mib,
                disk_mib=disk_mib,
            )
        policy_doc = (
            policies
            if isinstance(policies, PolicyDoc)
            else _decode_model(PolicyDoc, policies)
            if policies is not None
            else None
        )
        request_options = dict(
            source_org_id=source_org_id,
            name=name,
            description=description,
            public=public,
            ssh_public_keys=ssh_public_keys,
            disk=disk if disk is not None else True,
            durable=durable,
            platforms=platforms,
            layers=layers,
            resources=resources,
            policies=policy_doc,
        )
        body = (
            ForkRequest1(source_vm_id=source_vm_id, **request_options)
            if source_vm_id is not None
            else ForkRequest2(source_vm_name=source_vm_name, **request_options)
        )
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
        org_id: str | None = None,
        public: bool | None = None,
        state: str | None = None,
    ) -> VmList:
        """Admin call — goes through the control plane so it can
        aggregate across providers and regions.
        """
        parameters = ListVmsParameters(
            cursor=cursor,
            limit=limit,
            region=region,
            provider=provider,
            org_id=org_id,
            public=public,
            state=state,
        )
        path = _build_query("/v1/vms", parameters)
        payload = self._request("GET", path, base_url=self._control_base_url)
        vms = []
        for item in payload.get("vms", []):
            info = _vm_info(item)
            vms.append(VM(self, info.vm_id, self._base_url_for(info.vm_id), info))
        return VmList(vms=vms, next_cursor=_optional_str(payload.get("next_cursor")))

    def list_runs(
        self,
        *,
        since: int | None = None,
        until: int | None = None,
        vm: str | None = None,
        vm_ids: list[str] | None = None,
        region: str | None = None,
        provider: str | None = None,
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
        parameters = ListOrgRunsParameters(
            since=since,
            until=until,
            vm=vm,
            vms=",".join(vm_ids) if vm_ids else None,
            region=region,
            provider=provider,
            search=search,
            limit=limit,
            offset=offset,
            lite=lite,
            runtime=runtime,
            endpoint=endpoint,
            actions=",".join(actions) if actions else None,
            status=",".join(status) if status else None,
            status_min=status_min,
            status_max=status_max,
            sort=sort,
            dir=dir,
        )
        path = _build_query("/v1/runs", parameters)
        payload = self._request("GET", path, base_url=self._control_base_url)
        return _org_runs_response(payload)

    def get_vm(self, vm_id: str) -> VM:
        info = _vm_info(self._request("GET", _vm_path(vm_id), base_url=self._base_url_for(vm_id)))
        return VM(self, vm_id, self._base_url_for(vm_id), info)

    # ── Filesystems (org-scoped, control-plane) ─────────────────────────
    def list_filesystems(self, *, cursor: str | None = None, limit: int | None = None, name_prefix: str | None = None) -> ListFilesystemsResponse:
        parameters = ListFilesystemsParameters(
            cursor=cursor, limit=limit, name_prefix=name_prefix
        )
        path = _build_query("/v1/filesystems", parameters)
        # Filesystems are region-scoped and served by arkerd directly. Route to
        # the regional endpoint (base_url) rather than the control plane: the
        # control-plane path (arker.ai → api_proxy_bash) does not route
        # /v1/filesystems, while the regional NLB → arkerd serves it.
        payload = self._request("GET", path, base_url=self._base_url)
        return _decode_model(ListFilesystemsResponse, payload)

    def create_filesystem(self, *, name: str) -> Filesystem:
        request = FilesystemCreateRequest(name=name)
        return _filesystem(self._request("POST", "/v1/filesystems", request, base_url=self._base_url))

    def get_filesystem(self, filesystem_id: str) -> Filesystem:
        return _filesystem(self._request("GET", f"/v1/filesystems/{_segment(filesystem_id)}", base_url=self._base_url))

    def delete_filesystem(self, filesystem_id: str) -> DeleteFilesystemResponse:
        payload = self._request("DELETE", f"/v1/filesystems/{_segment(filesystem_id)}", base_url=self._base_url)
        return _decode_model(DeleteFilesystemResponse, payload)

    def _request(
        self,
        method: str,
        path: str,
        body: object | None = None,
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
            except httpx.RequestError as error:
                if attempt < self._retry.attempts - 1:
                    time.sleep(self._retry_delay(attempt))
                    continue
                raise ArkerError("unavailable", str(error), 0) from error

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
    description: str | None
    state: str | None
    owner_org_id: str | None
    created_at: str | None
    public: bool | None
    region: str | None
    provider: str | None
    vcpu_count: int | None
    memory_mib: int | None
    disk_mib: int | None
    network: VmNetwork | None
    resources: VmResources | None
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
        resources = data.resources if data is not None else None
        self.vcpu_count = resources.vcpu if resources is not None else None
        self.memory_mib = resources.memory_mib if resources is not None else None
        self.disk_mib = resources.disk_mib if resources is not None else None

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
        time_to_background: int | None = None,
        end_symbol: str | None = None,
        vcpu_count: int | None = None,
        memory_mib: int | None = None,
        disk_mib: int | None = None,
        network: dict[str, Any] | None = None,
        policies: PolicyDoc | dict[str, Any] | None = None,
        acquire: str | list[str] | None = None,
        release: str | list[str] | None = None,
        signal: str | None = None,
        idempotency_key: str | None = None,
    ) -> RunResult:
        """Run ``command`` in this VM via ``POST /v1/vms/{id}/runs``.

        Synchronous by default. If the run outlives the server sync window
        (``time_to_background``) the API returns a background ack with a
        ``run_id``; run() then transparently polls :meth:`get_run` until the run
        reaches a terminal state and returns the completed
        :class:`CompletedRunResult` — so a synchronous caller always receives
        the final result. Polling is bounded by ``timeout`` (the run's kill
        bound; ``None``/``0`` ⇒ the 3600s default) plus a margin; if that budget
        is exceeded run() raises an :class:`ArkerError` with code ``"timeout"``
        (the run keeps executing server-side — poll :meth:`get_run` to retrieve
        it).

        Pass ``background=True`` to skip the wait entirely: run() returns the
        running :class:`BackgroundRunResult` immediately and you manage polling
        yourself via :meth:`get_run`.

        ``timeout`` is the execution/kill bound in seconds: the maximum wall-clock
        time the command may run before the host kills it. ``None`` (default)
        applies the server default (3600 seconds);
        ``0`` opts out of any kill (unbounded). It is NOT the HTTP wait window,
        so ``background=True`` runs should leave it unset (or set a real kill
        bound) — a small ``timeout`` would kill the run, not just background it.

        ``time_to_background`` is the HTTP sync window in seconds: how long the call
        blocks inline before backgrounding the run and returning a pollable
        ``run_id``. ``None`` (default) = 30. It does not bound command
        runtime — that is ``timeout``.
        """
        if network is not None:
            raise ArkerError(
                "bad_request",
                "run network inputs were removed; use policies",
                400,
            )
        policy_doc = (
            policies
            if isinstance(policies, PolicyDoc)
            else _decode_model(PolicyDoc, policies)
            if policies is not None
            else None
        )
        body = RunRequest(
            command=command,
            session_id=session_id,
            session_idx=session_idx,
            background=background,
            timeout=timeout,
            time_to_background=time_to_background,
            end_symbol=end_symbol,
            vcpu_count=vcpu_count,
            memory_mib=memory_mib,
            disk_mib=disk_mib,
            acquire=",".join(acquire) if isinstance(acquire, list) else acquire,
            release=",".join(release) if isinstance(release, list) else release,
            signal=signal,
            policies=policy_doc,
        )
        headers = {"Idempotency-Key": idempotency_key} if idempotency_key else None
        result = _run_response(self._client._request(
            "POST",
            f"{_vm_path(self.id)}/runs",
            body,
            base_url=self.base_url,
            extra_headers=headers,
        ))
        # The server backgrounds a run that outlived its sync window. When the
        # caller did NOT request background, poll get_run() to a terminal state
        # and hand back the completed run so the synchronous call is
        # transparent. background=True is a pure pass-through — return the ack.
        if isinstance(result, BackgroundRunResult) and background is not True:
            return self._await_run(result.run_id, timeout)
        return result

    def _await_run(self, run_id: str, timeout: int | None) -> CompletedRunResult:
        """Poll :meth:`get_run` until the run reaches a terminal state, then
        return it as a :class:`CompletedRunResult`. Backs the transparent
        synchronous :meth:`run`: invoked only when the server backgrounds a run
        that outlived its sync window. Bounded by ``timeout`` (the run's kill
        bound) plus a margin; raises an :class:`ArkerError` with code
        ``"timeout"`` if the budget is exceeded."""
        kill_bound_s = timeout if (timeout is not None and timeout > 0) else DEFAULT_RUN_TIMEOUT_S
        budget_s = kill_bound_s + RUN_POLL_MARGIN_S
        deadline = time.monotonic() + budget_s
        delay = RUN_POLL_INITIAL_S
        while True:
            time.sleep(delay)
            run = self.get_run(run_id)
            if run.state in TERMINAL_RUN_STATES:
                return _run_to_completed_result(run)
            if time.monotonic() >= deadline:
                raise ArkerError(
                    "timeout",
                    f"run {run_id} did not reach a terminal state within "
                    f'{int(budget_s)}s; it continues server-side — poll '
                    f'get_run("{run_id}") to retrieve it',
                    0,
                )
            delay = min(RUN_POLL_MAX_S, delay * RUN_POLL_BACKOFF)

    def update(
        self,
        *,
        vcpu_count: int | None = None,
        memory_mib: int | None = None,
        disk_mib: int | None = None,
        description: str | None | _UnsetType = _UNSET,
        network: NetworkInput | dict[str, Any] | None = None,
    ) -> Vm:
        """Update this VM's description, resource allocation, and/or authorized
        SSH keys (``network.ssh_public_keys``) via ``PATCH /v1/vms/{id}``.
        Pass ``None`` or an empty description to clear it. Omit
        ``description`` to leave it unchanged. Returns the updated :class:`Vm`."""
        resources: VmResources | None = None
        if vcpu_count is not None or memory_mib is not None or disk_mib is not None:
            resources = VmResources(
                vcpu=vcpu_count,
                memory_mib=memory_mib,
                disk_mib=disk_mib,
            )
        body: PatchVmRequest | dict[str, Any]
        if description is _UNSET:
            body = PatchVmRequest(resources=resources, network=network)
        else:
            body = {
                "description": _EXPLICIT_NULL if description is None else description,
                "resources": resources,
                "network": network,
            }
        payload = self._client._request("PATCH", _vm_path(self.id), body, base_url=self.base_url)
        return _vm_info(payload)

    def delete(self) -> DeleteVmResponse:
        payload = self._client._request("DELETE", _vm_path(self.id), base_url=self.base_url)
        return _decode_model(DeleteVmResponse, payload)

    def get_policies(self) -> PolicyDoc:
        """Read this VM's network policy via ``GET /v1/vms/{id}/policies``."""
        payload = self._client._request("GET", f"{_vm_path(self.id)}/policies", base_url=self.base_url)
        return _decode_model(PolicyDoc, payload)

    def set_policies(self, doc: PolicyDoc | dict[str, Any]) -> PolicyDoc:
        """Replace this VM's network policy with ``doc`` via
        ``PUT /v1/vms/{id}/policies``. An empty
        doc (``{}`` or ``{"policies": []}``) clears the policy to allow-all.

        Returns the stored policy document, including response-only hostname
        and warning fields::

            vm.set_policies({
                "policies": [
                    {"type": "outbound",
                     "match": {"hosts": ["github.com"], "ports": [443]},
                     "action": "allow"},
                    {"type": "outbound", "action": "deny"},
                ],
            })
        """
        request = doc if isinstance(doc, PolicyDoc) else _decode_model(PolicyDoc, doc)
        payload = self._client._request("PUT", f"{_vm_path(self.id)}/policies", request, base_url=self.base_url)
        return _decode_model(PolicyDoc, payload)

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
        if len(payload) <= INLINE_WRITE_LIMIT:
            self._sync_write_inline(path, payload)
        else:
            self._sync_write_presigned(path, payload)
        return None

    def _sync_read(self, path: str) -> bytes:
        request = SyncReadOperationRequest(op="read", path=path)
        payload = self._client._request(
            "POST", f"{_vm_path(self.id)}/sync",
            request, base_url=self.base_url,
        )
        response = _decode_value(SyncReadResponse, payload)
        if isinstance(response, SyncReadInlineResponse):
            return _decode_bytes(response.content, response.encoding)
        if not isinstance(response, SyncReadPresignedResponse):
            raise ArkerError("internal", "unrecognized sync read response", 200)
        signed = _http_client.get(response.presigned_url, timeout=300)
        signed.raise_for_status()
        return signed.content

    def _sync_write_inline(self, path: str, data: bytes) -> None:
        upload_id = _ulid()
        # `or [0]`: an empty file still needs its one (empty) chunk — zero
        # chunks would send `writes: []` and never create the file.
        starts = list(range(0, len(data), CHUNK_SIZE)) or [0]
        entries = [
            SyncChunkWrite(
                path=path,
                size=len(data),
                upload_id=upload_id,
                content=base64.b64encode(data[start : start + CHUNK_SIZE]).decode("ascii"),
                start=start,
                end=min(start + CHUNK_SIZE, len(data)),
            )
            for start in starts
        ]
        results = self._send_writes(entries)
        # Chunks before the last legitimately report written=False; the final
        # chunk's result carries file completion.
        _assert_write_complete(results[-1], "inline write")

    def _sync_write_presigned(self, path: str, data: bytes) -> None:
        request = self._send_one_write(
            SyncPresignedWriteRequest(path=path, size=len(data), presigned=True)
        )
        if not isinstance(request, SyncPresignedWriteRequestResult):
            raise ArkerError("internal", "write response missing presigned upload fields", 200)
        self._put_presigned(request.presigned_url, data)
        result = self._send_one_write(
            SyncPresignedWriteCommit(
                path=path,
                size=len(data),
                upload_id=request.upload_id,
            )
        )
        _assert_write_complete(result, "presigned write commit")

    def _put_presigned(self, url: str, data: bytes) -> None:
        for attempt in range(self._client._retry.attempts):
            try:
                response = _http_client.put(url, content=data, timeout=PRESIGNED_PUT_TIMEOUT_S)
            except httpx.RequestError as error:
                if attempt == self._client._retry.attempts - 1:
                    raise ArkerError("unavailable", f"upload PUT failed: {error}", 0) from error
                time.sleep(self._client._retry_delay(attempt))
                continue
            if response.status_code < 400:
                return
            status = response.status_code
            if status not in RETRYABLE_HTTP or attempt == self._client._retry.attempts - 1:
                raise ArkerError("internal", f"upload PUT failed: {status}", status)
            time.sleep(self._client._retry_delay(attempt))

    def _send_one_write(self, entry: SyncWriteEntry) -> SyncWriteResult:
        return self._send_writes([entry])[0]

    def _send_writes(self, entries: list[SyncWriteEntry]) -> list[SyncWriteResult]:
        # Chunk entries share one upload_id, so a retry resends the same byte
        # ranges idempotently — the server's chunk ledger merges them.
        last_error: tuple[str, str] | None = None
        for attempt in range(self._client._retry.attempts):
            request = SyncWriteOperationRequest(op="write", writes=entries)
            payload = self._client._request(
                "POST", f"{_vm_path(self.id)}/sync",
                request, base_url=self.base_url,
            )
            response = _decode_model(SyncWriteResponse, payload)
            if len(response.results) != len(entries):
                raise ArkerError("internal", "write response missing results", 200)
            error = next(
                (result.error for result in response.results if result.error is not None),
                None,
            )
            if error is None:
                return response.results
            last_error = (error.code, error.message)
            parsed_error = {"code": error.code, "message": error.message}
            if not _is_retryable(200, parsed_error) or attempt == self._client._retry.attempts - 1:
                break
            time.sleep(self._client._retry_delay(attempt))
        raise ArkerError(
            last_error[0] if last_error else "internal",
            last_error[1] if last_error else "write failed",
            200,
        )

    # ── Directory sync (rsync-style, manifest diff) ──────────────────
    def sync_dir(
        self,
        local_dir: str,
        remote_dir: str,
        *,
        cache: dict[str, tuple[int, int, str]] | None = None,
    ) -> SyncDirResult:
        """Recursively sync a local directory INTO this VM at ``remote_dir``,
        rsync-style: fetch the VM's file *manifest* (per-file sha256) in ONE
        request via the host-first ``op="manifest"`` (no FC boot; works on a
        never-run VM), diff it against the local tree, and upload ONLY the files
        that are new or changed — packed into a single tarball the guest extracts
        with ``tar -x`` (so the guest does the writes, always consistent with its
        own filesystem).

        The remote manifest is authoritative. ``cache`` (an optional dict you own
        and reuse across calls) is a pure accelerator: it skips re-hashing local
        files whose (size, mtime) are unchanged. It never decides remote state,
        so it can never cause a stale or missing upload — worst case it hashes a
        file it didn't need to.

        Returns a :class:`SyncDirResult` (sent / skipped / bytes).
        """
        local_root = os.path.abspath(local_dir)
        remote_root = "/" + remote_dir.strip("/")

        # 1. Authoritative remote manifest: rel_path -> sha256. A directory that
        #    doesn't exist yet (or an empty VM) yields {} -> everything is sent.
        remote = self._remote_manifest(remote_root)

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

        # 3. Diff local vs the REMOTE manifest → the set of new/changed files.
        result = SyncDirResult()
        changed: list[tuple[str, str]] = []  # (rel, abs_path)
        for rel, (abs_path, size, mtime_ns) in sorted(local_files.items()):
            local_hash = _file_hash_cached(abs_path, size, mtime_ns, cache)
            if remote.get(rel) == local_hash:
                result.skipped += 1
                continue
            changed.append((rel, abs_path))
            result.sent += 1
            result.bytes_sent += size

        # 4. Ship the changed files as ONE tarball and extract it in the guest.
        #    The GUEST does the file writes (via `tar -x`), so they are always
        #    consistent with its own filesystem — and one stream + one extract is
        #    far faster than one write per file. The extract's exit code is
        #    checked, so a failure surfaces (never a silent partial); the manifest
        #    also fails safe: any omitted file is re-sent next call.
        if changed:
            self._upload_and_extract_tarball(changed, remote_root)
        return result

    def _remote_manifest(self, path: str) -> dict[str, str]:
        """Fetch the VM's file manifest under ``path`` → {rel_path: sha256}, via
        the host-first ``op="manifest"`` op (no FC boot; works on a never-run
        VM). A path that doesn't exist yet yields an empty manifest."""
        request = SyncManifestOperationRequest(op="manifest", path=path)
        payload = self._client._request(
            "POST", f"{_vm_path(self.id)}/sync",
            request, base_url=self.base_url,
        )
        response = _decode_model(SyncManifestResponse, payload)
        return {entry.path: entry.hash for entry in response.entries}

    def _upload_and_extract_tarball(
        self, changed: list[tuple[str, str]], remote_root: str
    ) -> None:
        """Pack the changed files (arcname = path relative to ``remote_root``)
        into ONE tar, upload it in a single write, and extract it in the guest
        with `tar -x` (which preserves mode/exec bits and creates missing parent
        dirs). The extract's exit is checked so any failure surfaces."""
        with tempfile.NamedTemporaryFile(suffix=".tar", delete=False) as tf:
            tar_local = tf.name
        try:
            with tarfile.open(tar_local, "w") as tar:
                for rel, abs_path in changed:
                    tar.add(abs_path, arcname=rel, recursive=False)
            with open(tar_local, "rb") as fh:
                data = fh.read()

            remote_tar = f"/tmp/.arker-sync-{_ulid()}.tar"
            self.sync(remote_tar, data)  # inline for small tarballs, presigned for large

            q = shlex.quote
            # `set -e` + explicit rm: any extract failure exits non-zero; the
            # tarball is removed on success. Missing parent dirs are created by
            # mkdir/tar.
            cmd = (
                f"set -e; mkdir -p {q(remote_root)}; "
                f"tar -xf {q(remote_tar)} -C {q(remote_root)}; rm -f {q(remote_tar)}"
            )
            res = self.run(cmd)
            code = getattr(res, "exit_code", None)
            state = getattr(res, "state", None)
            if (code not in (0, None)) or state == "failed":
                stderr = getattr(res, "stderr", b"")
                if isinstance(stderr, (bytes, bytearray)):
                    stderr = stderr.decode("utf-8", "replace")
                raise ArkerError(
                    "internal",
                    f"sync_dir tar extract failed (exit={code}, state={state}): {stderr[:300]}",
                    200,
                )
        finally:
            try:
                os.unlink(tar_local)
            except OSError:
                pass

    # ── Syncs: bindings of a filesystem into this VM at a path ────────
    def list_syncs(self, *, cursor: str | None = None, limit: int | None = None, filesystem_id: str | None = None) -> ListSyncsResponse:
        parameters = ListSyncsParameters(
            id=self.id,
            cursor=cursor,
            limit=limit,
            filesystem_id=filesystem_id,
        )
        path = _build_query(
            f"{_vm_path(self.id)}/syncs", parameters, path_fields={"id"}
        )
        payload = self._client._request("GET", path, base_url=self.base_url)
        return _decode_model(ListSyncsResponse, payload)

    def create_sync(self, *, filesystem_id: str, path: str | None = None) -> Sync:
        """Bind a filesystem into this VM at ``path``."""
        request = SyncCreateRequest(filesystem_id=filesystem_id, path=path)
        payload = self._client._request(
            "POST", f"{_vm_path(self.id)}/syncs", request, base_url=self.base_url
        )
        return _sync(payload)

    def delete_sync(self, sync_id: str) -> DeleteSyncResponse:
        payload = self._client._request("DELETE", f"{_vm_path(self.id)}/syncs/{_segment(sync_id)}", base_url=self.base_url)
        return _decode_model(DeleteSyncResponse, payload)

    # ── Runs ──────────────────────────────────────────────────────────
    def list_runs(self, *, cursor: str | None = None, limit: int | None = None, state: str | None = None,
                  started_after: str | None = None, started_before: str | None = None, completed_after: str | None = None) -> ListRunsResponse:
        parameters = ListRunsParameters(
            id=self.id,
            cursor=cursor,
            limit=limit,
            state=state,
            started_after=started_after,
            started_before=started_before,
            completed_after=completed_after,
        )
        path = _build_query(
            f"{_vm_path(self.id)}/runs", parameters, path_fields={"id"}
        )
        payload = self._client._request("GET", path, base_url=self.base_url)
        return _decode_model(ListRunsResponse, payload)

    def get_run(self, run_id: str) -> Run:
        return _run_status_response(self._client._request("GET", f"{_vm_path(self.id)}/runs/{_segment(run_id)}", base_url=self.base_url))

    def cancel_run(self, run_id: str) -> CancelRunResponse:
        payload = self._client._request("DELETE", f"{_vm_path(self.id)}/runs/{_segment(run_id)}", base_url=self.base_url)
        return _decode_model(CancelRunResponse, payload)

    # ── Sessions ──────────────────────────────────────────────────────
    def list_sessions(self, *, cursor: str | None = None, limit: int | None = None, state: str | None = None) -> ListSessionsResponse:
        parameters = ListSessionsParameters(
            id=self.id, cursor=cursor, limit=limit, state=state
        )
        path = _build_query(
            f"{_vm_path(self.id)}/sessions", parameters, path_fields={"id"}
        )
        payload = self._client._request("GET", path, base_url=self.base_url)
        return _decode_model(ListSessionsResponse, payload)

    def create_session(self, *, env: dict[str, str] | None = None, cwd: str | None = None) -> Session:
        request = CreateSessionRequest(env=env, cwd=cwd)
        payload = self._client._request(
            "POST", f"{_vm_path(self.id)}/sessions", request, base_url=self.base_url
        )
        return _session_info(payload)

    def get_session(self, session_id: str) -> Session:
        payload = self._client._request("GET", f"{_vm_path(self.id)}/sessions/{_segment(session_id)}", base_url=self.base_url)
        return _session_info(payload)

    def delete_session(self, session_id: str) -> DeleteSessionResponse:
        payload = self._client._request("DELETE", f"{_vm_path(self.id)}/sessions/{_segment(session_id)}", base_url=self.base_url)
        return _decode_model(DeleteSessionResponse, payload)

    def update_session(
        self,
        session_id: str,
        *,
        cols: int | None = None,
        rows: int | None = None,
        timeout_secs: int | None = None,
    ) -> PatchSessionResponse:
        """Update a session via ``PATCH /v1/vms/{id}/sessions/{sid}``: resize its
        PTY (``cols``/``rows``) and/or set the idle ``timeout_secs``. Works whether
        or not a PTY is currently attached — the REST equivalent of
        :meth:`Pty.resize` (which sends an in-band control frame on the live
        WebSocket).
        """
        request = PatchSessionRequest(
            cols=cols, rows=rows, timeout_secs=timeout_secs
        )
        payload = self._client._request(
            "PATCH",
            f"{_vm_path(self.id)}/sessions/{_segment(session_id)}",
            request,
            base_url=self.base_url,
        )
        return _decode_model(PatchSessionResponse, payload)

    # ── Interactive PTY ────────────────────────────────────────────────
    def connect_pty(
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
            payload = self._client._request(
                "POST",
                f"{_vm_path(self.id)}/sessions/{_segment(sid)}/pty-ticket",
                {},
                base_url=self.base_url,
            )
            response = _decode_model(PtyTicketResponse, payload)
            ticket = response.ticket
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

    Obtain one via :meth:`VM.connect_pty`. Requires the ``websocket-client``
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
            raise ArkerError("unavailable", "PTY WebSocket failed to open (timeout)", 0)
        if self._open_error is not None:
            raise ArkerError("unavailable", f"PTY WebSocket failed to open: {self._open_error}", 0)

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


# Shared HTTP/2 client. One connection pool for the process, so concurrent requests
# multiplex over a single connection per host. HTTP/2 is negotiated via ALPN; hosts
# that don't offer it (e.g. presigned storage transfers) fall back to HTTP/1.1.
_http_client = httpx.Client(http2=True)
atexit.register(_http_client.close)


def _http(method: str, url: str, headers: dict[str, str], data: bytes | None) -> tuple[int, bytes]:
    response = _http_client.request(method, url, headers=headers, content=data, timeout=120)
    return response.status_code, response.content


def _build_query(
    path: str,
    parameters: object,
    *,
    path_fields: set[str] | frozenset[str] = frozenset(),
) -> str:
    values = _drop_none(parameters)
    if not isinstance(values, dict):
        raise TypeError("operation parameters must serialize to an object")
    pairs = [
        (key, str(value))
        for key, value in values.items()
        if key not in path_fields
    ]
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
    if value is _EXPLICIT_NULL:
        return None
    if dataclasses.is_dataclass(value) and not isinstance(value, type):
        value = {
            field.name: getattr(value, field.name) for field in dataclasses.fields(value)
        }
    if isinstance(value, list):
        return [_drop_none(item) for item in value]
    if isinstance(value, dict):
        return {key: _drop_none(item) for key, item in value.items() if item is not None}
    return value


def _decode_model(model: type[Model], payload: dict[str, Any]) -> Model:
    fields = dataclasses.fields(model)
    field_names = {field.name for field in fields}
    unknown = sorted(set(payload) - field_names)
    if unknown:
        raise TypeError(
            f"{model.__name__} contains fields outside openapi.json: {', '.join(unknown)}"
        )
    hints = get_type_hints(model)
    values = {
        field.name: _decode_value(hints[field.name], payload[field.name])
        for field in fields
        if field.name in payload
    }
    return model(**values)


def _decode_value(annotation: Any, value: Any) -> Any:
    if value is None:
        return None
    origin = get_origin(annotation)
    if origin is list:
        (item_type,) = get_args(annotation)
        return [_decode_value(item_type, item) for item in value]
    if origin is dict:
        _, value_type = get_args(annotation)
        return {key: _decode_value(value_type, item) for key, item in value.items()}
    if origin is types.UnionType:
        args = get_args(annotation)
        model_types = [
            member
            for member in args
            if isinstance(member, type) and dataclasses.is_dataclass(member)
        ]
        if isinstance(value, dict):
            candidates: list[tuple[tuple[int, int], type[Any]]] = []
            for model_type in model_types:
                fields = dataclasses.fields(model_type)
                field_names = {field.name for field in fields}
                required = {
                    field.name
                    for field in fields
                    if field.default is dataclasses.MISSING
                    and field.default_factory is dataclasses.MISSING
                }
                if required.issubset(value):
                    candidates.append(
                        ((len(required), len(field_names.intersection(value))), model_type)
                    )
            if candidates:
                _, model_type = max(candidates, key=lambda candidate: candidate[0])
                return _decode_model(model_type, value)
        # Optional[list[Dataclass]] / Optional[dict[str, Dataclass]]: the
        # single non-null member is itself a parameterized container, not a
        # bare dataclass type (that case is handled above), so it never
        # matched `model_types` and fell through to a raw passthrough —
        # e.g. PolicyDoc.policies: list[PolicyEntry] | None decoded as
        # plain dicts instead of PolicyEntry instances. Recurse into the
        # single non-null member so its own list/dict branch above can
        # decode each item.
        non_none = [member for member in args if member is not type(None)]
        if len(non_none) == 1 and get_origin(non_none[0]) in (list, dict):
            return _decode_value(non_none[0], value)
        return value
    if isinstance(annotation, type) and dataclasses.is_dataclass(annotation):
        return _decode_model(annotation, value)
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
    try:
        response = _decode_model(ErrorResponse, payload)
    except (KeyError, TypeError):
        return None
    return {"code": response.error.code, "message": response.error.message}


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


def _assert_write_complete(result: SyncWriteResult, context: str) -> None:
    if result.complete and result.written:
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
    return _decode_model(Session, payload)


def _filesystem(payload: dict[str, Any]) -> Filesystem:
    return _decode_model(Filesystem, payload)


def _sync(payload: dict[str, Any]) -> Sync:
    return _decode_model(Sync, payload)


def _vm_info(payload: dict[str, Any]) -> Vm:
    return _decode_model(Vm, payload)


def _run_response(payload: dict[str, Any]) -> RunResult:
    response = _decode_value(RunResponse, payload)
    if isinstance(response, CompletedRunResponse):
        return CompletedRunResult(
            stdout=_decode_bytes(response.stdout, response.stdout_encoding),
            stdout_encoding=response.stdout_encoding,
            stderr=_decode_bytes(response.stderr, response.stderr_encoding),
            stderr_encoding=response.stderr_encoding,
            exit_code=response.exit_code,
            run_id=response.run_id,
            state=response.state or "completed",
            fail_reason=_optional_str(payload.get("fail_reason")),
            memory_requested_mib=response.memory_requested_mib,
            memory_achieved_mib=response.memory_achieved_mib,
            memory_partial=bool(response.memory_partial),
        )

    if isinstance(response, BackgroundRunResponse):
        return BackgroundRunResult(
            run_id=response.run_id,
            state=response.state or "running",
        )

    raise ArkerError("internal", "unrecognized run response shape", 200)


def _run_to_completed_result(run: Run) -> CompletedRunResult:
    """Project a terminal run-status (:class:`Run`) into the
    :class:`CompletedRunResult` a synchronous :meth:`VM.run` resolves to. The
    stored run carries no memory-override fields, so those stay ``None``."""
    exit_code = run.exit_code
    if exit_code is None:
        exit_code = 0 if run.state == "completed" else 1
    return CompletedRunResult(
        stdout=_decode_bytes(run.stdout, run.stdout_encoding),
        stdout_encoding=run.stdout_encoding,
        stderr=_decode_bytes(run.stderr, run.stderr_encoding),
        stderr_encoding=run.stderr_encoding,
        exit_code=exit_code,
        run_id=run.run_id,
        state=run.state,
        fail_reason=run.fail_reason,
    )


def _run_status_response(payload: dict[str, Any]) -> Run:
    return _decode_model(Run, payload)


def _org_runs_response(payload: dict[str, Any]) -> ListOrgRunsResponse:
    return _decode_model(ListOrgRunsResponse, payload)


def _optional_str(value: Any) -> str | None:
    return value if isinstance(value, str) else None


def _optional_int(value: Any) -> int | None:
    return int(value) if isinstance(value, int) else None


# Backwards-compat: previously RunStatusResponse.
RunStatusResponse = Run
