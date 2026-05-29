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
import time
import urllib.error
import urllib.parse
import urllib.request
from typing import Any

CHUNK_SIZE = 4 * 1024 * 1024

# Placeholder org id for the "Arker" org — the org that owns the public
# golden VMs (`arkuntu`, `ubuntu`, …). When `fork(image=...)` is called
# the SDK auto-fills `source_org_id` with this constant.
ARKER_ORG_ID = "org_arker"

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
BURST_SOURCE_REFS = {"arkuntu"}
BURST_VM_ID = re.compile(r"^[0-9A-HJKMNP-TV-Z]{26}_[A-Za-z0-9]+$")


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
    network: dict[str, Any] | None = None


@dataclasses.dataclass(frozen=True)
class ListVmsResponse:
    vms: list[Vm]
    next_cursor: str | None = None

    @property
    def items(self) -> list[Vm]:
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
    type: str = "completed"


@dataclasses.dataclass(frozen=True)
class BackgroundRunResult:
    run_id: str
    tunnels: list[Tunnel] = dataclasses.field(default_factory=list)
    network: dict[str, Any] | None = None
    type: str = "background"


RunResult = CompletedRunResult | BackgroundRunResult


@dataclasses.dataclass(frozen=True)
class Run:
    run_id: str
    state: str  # "running" | "completed" | "cancelled"
    started_at: str
    stdout: bytes
    stdout_encoding: str
    stderr: bytes
    stderr_encoding: str
    tunnels: list[Tunnel]
    exit_code: int | None = None
    session_id: str | None = None
    command: str | None = None
    completed_at: str | None = None
    network: dict[str, Any] | None = None
    retry_count: int = 0


@dataclasses.dataclass(frozen=True)
class RunSummary:
    """Strict field-subset of `Run` — every field is present on `Run`."""
    run_id: str
    state: str
    started_at: str
    exit_code: int | None = None
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
class SyncObject:
    sync_id: str
    vm_id: str
    filesystem_id: str
    path: str
    created_at: str


@dataclasses.dataclass(frozen=True)
class ListSyncsResponse:
    syncs: list[SyncObject]
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
        region: str | None = None,
        retry: RetryOptions | dict[str, Any] | bool | None = None,
    ) -> None:
        resolved_api_key = api_key or _env("ARKER_API_KEY") or _env("AUTH_KEY")
        explicit_base_url = base_url or _env("ARKER_BASE_URL")
        resolved_region = region or (None if explicit_base_url else _env(DEFAULT_REGION_ENV))
        resolved_base_url = explicit_base_url or (_region_base_url(resolved_region, False) if resolved_region else None)
        resolved_burst_base_url = (
            burst_base_url
            or _env("ARKER_BURST_BASE_URL")
            or (_region_base_url(resolved_region, True) if resolved_region else None)
        )

        if not resolved_api_key:
            raise ValueError("api_key is required; pass api_key or set ARKER_API_KEY")
        if not resolved_base_url:
            raise ValueError("region or base_url is required; pass region, base_url, ARKER_REGION, or ARKER_BASE_URL")

        self._api_key = resolved_api_key
        self._base_url = _normalize_base_url(resolved_base_url)
        self._burst_base_url = _normalize_base_url(resolved_burst_base_url) if resolved_burst_base_url else None
        self._region = _normalize_region(resolved_region) if resolved_region else None
        self._retry = _normalize_retry(retry)
        self.filesystems = Filesystems(self)

    @property
    def base_url(self) -> str:
        return self._base_url

    @property
    def burst_base_url(self) -> str | None:
        return self._burst_base_url

    @property
    def region(self) -> str | None:
        return self._region

    def vm(self, vm_id: str) -> "Computer":
        return Computer(self, vm_id, self._base_url_for(vm_id))

    def fork(
        self,
        *,
        source_vm_id: str | None = None,
        source_vm_name: str | None = None,
        source_org_id: str | None = None,
        name: str | None = None,
        public: bool | None = None,
        network: bool | str | dict[str, Any] | None = None,
        tunnels: dict[str, Any] | None = None,
        disk: bool | None = None,
        vcpu_count: int | None = None,
        memory_mib: int | None = None,
        max_memory_mib: int | None = None,
        disk_mib: int | None = None,
        durable: bool | None = None,
    ) -> "Computer":
        """Create a new VM by forking.

        Exactly one of ``source_vm_id`` or ``source_vm_name`` must be set.

        - ``fork(source_vm_id="vm_abc...")`` — fork by global id.
        - ``fork(source_vm_name="base")`` — fork a VM by name in the
          caller's org.
        - ``fork(source_vm_name="arkuntu", source_org_id=ARKER_ORG_ID)``
          — fork the public arkuntu golden.

        ``name`` (optional) is the *new* VM's name in the caller's org.
        Forking a VM in another org requires that VM to be ``public``.
        """
        if not source_vm_id and not source_vm_name:
            raise ArkerError("bad_request", "fork requires source_vm_id or source_vm_name", 400)
        if source_vm_id and source_vm_name:
            raise ArkerError("bad_request", "fork: pass only one of source_vm_id or source_vm_name", 400)
        body = {
            "source_vm_id": source_vm_id,
            "source_vm_name": source_vm_name,
            "source_org_id": source_org_id,
            "name": name,
            "public": public,
            "network": network,
            "tunnels": tunnels,
            "disk": disk,
            "vcpu_count": vcpu_count,
            "memory_mib": memory_mib,
            "max_memory_mib": max_memory_mib,
            "disk_mib": disk_mib,
            "durable": durable,
        }
        base_url = self._burst_base_url if (image is not None and _is_burst_ref(image) and self._burst_base_url) else self._base_url
        payload = self._request("POST", "/v1/fork", body, base_url=base_url)
        vm = _vm_info(payload)
        return Computer(self, vm.vm_id, self._base_url_for(vm.vm_id))

    def list(
        self,
        *,
        cursor: str | None = None,
        limit: int | None = None,
        region: str | None = None,
        provider: str | None = None,
        state: str | None = None,
        started_after: str | None = None,
        started_before: str | None = None,
    ) -> ListVmsResponse:
        path = _build_query("/v1/vms", {
            "cursor": cursor,
            "limit": limit,
            "region": region,
            "provider": provider,
            "state": state,
            "started_after": started_after,
            "started_before": started_before,
        })
        payload = self._request("GET", path)
        return ListVmsResponse(
            vms=[_vm_info(item) for item in payload.get("vms", [])],
            next_cursor=_optional_str(payload.get("next_cursor")),
        )

    def get(self, vm_id: str) -> Vm:
        return _vm_info(self._request("GET", _vm_path(vm_id), base_url=self._base_url_for(vm_id)))

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


class Filesystems:
    def __init__(self, client: Arker) -> None:
        self._client = client

    def list(
        self,
        *,
        cursor: str | None = None,
        limit: int | None = None,
        name_prefix: str | None = None,
    ) -> ListFilesystemsResponse:
        path = _build_query("/v1/filesystems", {
            "cursor": cursor,
            "limit": limit,
            "name_prefix": name_prefix,
        })
        payload = self._client._request("GET", path)
        return ListFilesystemsResponse(
            filesystems=[_filesystem(item) for item in payload.get("filesystems", [])],
            next_cursor=_optional_str(payload.get("next_cursor")),
        )

    def get(self, filesystem_id: str) -> Filesystem:
        payload = self._client._request("GET", f"/v1/filesystems/{_segment(filesystem_id)}")
        return _filesystem(payload)

    def delete(self, filesystem_id: str) -> DeleteFilesystemResponse:
        payload = self._client._request("DELETE", f"/v1/filesystems/{_segment(filesystem_id)}")
        return DeleteFilesystemResponse(deleted=bool(payload.get("deleted")))


class Computer:
    def __init__(self, client: Arker, vm_id: str, base_url: str | None = None) -> None:
        self._client = client
        self.id = vm_id
        self.base_url = base_url or client._base_url_for(vm_id)
        self.syncs = Syncs(self)
        self.tunnels = Tunnels(self)
        self.runs = Runs(self)
        self.sessions = Sessions(self)

    def get(self) -> Vm:
        return _vm_info(self._client._request("GET", _vm_path(self.id), base_url=self.base_url))

    def fork(self, **kwargs: Any) -> "Computer":
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


class Runs:
    def __init__(self, vm: Computer) -> None:
        self._vm = vm

    def list(
        self,
        *,
        cursor: str | None = None,
        limit: int | None = None,
        state: str | None = None,
        started_after: str | None = None,
        started_before: str | None = None,
        completed_after: str | None = None,
    ) -> ListRunsResponse:
        path = _build_query(f"{_vm_path(self._vm.id)}/runs", {
            "cursor": cursor,
            "limit": limit,
            "state": state,
            "started_after": started_after,
            "started_before": started_before,
            "completed_after": completed_after,
        })
        payload = self._vm._client._request("GET", path, base_url=self._vm.base_url)
        return ListRunsResponse(
            runs=[_run_summary(item) for item in payload.get("runs", [])],
            next_cursor=_optional_str(payload.get("next_cursor")),
        )

    def get(self, run_id: str) -> Run:
        return _run_status_response(self._vm._client._request(
            "GET",
            f"{_vm_path(self._vm.id)}/runs/{_segment(run_id)}",
            base_url=self._vm.base_url,
        ))

    def cancel(self, run_id: str) -> CancelRunResponse:
        payload = self._vm._client._request(
            "DELETE",
            f"{_vm_path(self._vm.id)}/runs/{_segment(run_id)}",
            base_url=self._vm.base_url,
        )
        return CancelRunResponse(cancelled=bool(payload.get("cancelled")))


class Sessions:
    def __init__(self, vm: Computer) -> None:
        self._vm = vm

    def list(
        self,
        *,
        cursor: str | None = None,
        limit: int | None = None,
        state: str | None = None,
    ) -> ListSessionsResponse:
        path = _build_query(f"{_vm_path(self._vm.id)}/sessions", {
            "cursor": cursor, "limit": limit, "state": state,
        })
        payload = self._vm._client._request("GET", path, base_url=self._vm.base_url)
        return ListSessionsResponse(
            sessions=[_session_info(item) for item in payload.get("sessions", [])],
            next_cursor=_optional_str(payload.get("next_cursor")),
        )

    def get(self, session_id: str) -> Session:
        payload = self._vm._client._request(
            "GET",
            f"{_vm_path(self._vm.id)}/sessions/{_segment(session_id)}",
            base_url=self._vm.base_url,
        )
        return _session_info(payload)

    def create(
        self,
        *,
        env: dict[str, str] | None = None,
        cwd: str | None = None,
    ) -> Session:
        payload = self._vm._client._request(
            "POST",
            f"{_vm_path(self._vm.id)}/sessions",
            {"env": env, "cwd": cwd},
            base_url=self._vm.base_url,
        )
        return _session_info(payload)

    def delete(self, session_id: str) -> DeleteSessionResponse:
        payload = self._vm._client._request(
            "DELETE",
            f"{_vm_path(self._vm.id)}/sessions/{_segment(session_id)}",
            base_url=self._vm.base_url,
        )
        return DeleteSessionResponse(deleted=bool(payload.get("deleted")))


class Tunnels:
    def __init__(self, vm: Computer) -> None:
        self._vm = vm

    def list(
        self,
        *,
        cursor: str | None = None,
        limit: int | None = None,
        state: str | None = None,
    ) -> ListTunnelsResponse:
        path = _build_query(f"{_vm_path(self._vm.id)}/tunnels", {
            "cursor": cursor, "limit": limit, "state": state,
        })
        payload = self._vm._client._request("GET", path, base_url=self._vm.base_url)
        return ListTunnelsResponse(
            tunnels=[_tunnel(item) for item in payload.get("tunnels", [])],
            next_cursor=_optional_str(payload.get("next_cursor")),
        )

    def get(self, port: int) -> Tunnel:
        payload = self._vm._client._request(
            "GET",
            f"{_vm_path(self._vm.id)}/tunnels/{port}",
            base_url=self._vm.base_url,
        )
        return _tunnel(payload)

    def delete(self, port: int) -> DeleteTunnelResponse:
        payload = self._vm._client._request(
            "DELETE",
            f"{_vm_path(self._vm.id)}/tunnels/{port}",
            base_url=self._vm.base_url,
        )
        return DeleteTunnelResponse(deleted=bool(payload.get("deleted")))


class Syncs:
    def __init__(self, vm: Computer) -> None:
        self._vm = vm
        self._client = vm._client

    def list(
        self,
        *,
        cursor: str | None = None,
        limit: int | None = None,
        filesystem_id: str | None = None,
    ) -> ListSyncsResponse:
        path = _build_query(f"{_vm_path(self._vm.id)}/syncs", {
            "cursor": cursor, "limit": limit, "filesystem_id": filesystem_id,
        })
        payload = self._client._request("GET", path, base_url=self._vm.base_url)
        return ListSyncsResponse(
            syncs=[_sync(item) for item in payload.get("syncs", [])],
            next_cursor=_optional_str(payload.get("next_cursor")),
        )

    def get(self, sync_id: str) -> SyncObject:
        payload = self._client._request(
            "GET",
            f"{_vm_path(self._vm.id)}/syncs/{_segment(sync_id)}",
            base_url=self._vm.base_url,
        )
        return _sync(payload)

    def create(
        self,
        *,
        path: str,
        filesystem_id: str | None = None,
        filesystem_name: str | None = None,
        create_if_missing: bool = False,
    ) -> SyncObject:
        """Ensure a Filesystem exists and bind-mount it into this VM at ``path``.

        Bidirectional by virtue of being a mount — there is no separate
        sync-direction parameter.
        """
        payload = self._client._request(
            "POST",
            f"{_vm_path(self._vm.id)}/syncs",
            {
                "path": path,
                "filesystem_id": filesystem_id,
                "filesystem_name": filesystem_name,
                "create_if_missing": create_if_missing,
            },
            base_url=self._vm.base_url,
        )
        return _sync(payload)

    def delete(self, sync_id: str) -> DeleteSyncResponse:
        payload = self._client._request(
            "DELETE",
            f"{_vm_path(self._vm.id)}/syncs/{_segment(sync_id)}",
            base_url=self._vm.base_url,
        )
        return DeleteSyncResponse(deleted=bool(payload.get("deleted")))

    def read_file(self, path: str) -> bytes:
        payload = self._client._request(
            "POST",
            f"{_vm_path(self._vm.id)}/syncs/read",
            {"path": path},
            base_url=self._vm.base_url,
        )
        if "content" in payload:
            return _decode_bytes(str(payload.get("content", "")), str(payload.get("encoding", "utf-8")))

        url = payload.get("presigned_url")
        if not isinstance(url, str) or not url:
            raise ArkerError("internal", "read response missing content/presigned_url", 200)

        with urllib.request.urlopen(url, timeout=300) as response:
            return response.read()

    def write_file(self, path: str, data: bytes | str) -> None:
        payload = data.encode("utf-8") if isinstance(data, str) else data
        if len(payload) <= CHUNK_SIZE:
            self._write_inline(path, payload)
        else:
            self._write_presigned(path, payload)

    def _write_inline(self, path: str, data: bytes) -> None:
        result = self._send_one_write({
            "path": path,
            "size": len(data),
            "upload_id": _ulid(),
            "content": base64.b64encode(data).decode("ascii"),
            "start": 0,
            "end": len(data),
        })
        _assert_write_complete(result, "inline write")

    def _write_presigned(self, path: str, data: bytes) -> None:
        request = self._send_one_write({
            "path": path,
            "size": len(data),
            "presigned": True,
        })
        url = request.get("presigned_url")
        upload_id = request.get("upload_id")
        if not isinstance(url, str) or not url or not isinstance(upload_id, str) or not upload_id:
            raise ArkerError("internal", "write response missing presigned upload fields", 200)

        self._put_presigned(url, data)
        result = self._send_one_write({
            "path": path,
            "size": len(data),
            "upload_id": upload_id,
        })
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
                "POST",
                f"{_vm_path(self._vm.id)}/syncs/write",
                {"writes": [entry]},
                base_url=self._vm.base_url,
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

            last_error = {
                "code": str(error.get("code", "internal")),
                "message": str(error.get("message", "")),
            }
            if not _is_retryable(200, last_error) or attempt == self._client._retry.attempts - 1:
                break
            time.sleep(self._client._retry_delay(attempt))

        raise ArkerError(
            last_error["code"] if last_error else "internal",
            last_error["message"] if last_error else "write failed",
            200,
        )


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


def _region_base_url(region: str, burst: bool) -> str:
    normalized = _normalize_region(region)
    if not burst:
        return f"https://{normalized}.arker.ai/api"
    return f"https://{_burst_region_host(normalized)}.arker.ai/api"


def _burst_region_host(region: str) -> str:
    if region.startswith("aws-"):
        return f"aws-burst-{region[len('aws-'):]}"
    return f"{region}-burst"


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


def _sync(payload: dict[str, Any]) -> SyncObject:
    return SyncObject(
        sync_id=str(payload["sync_id"]),
        vm_id=str(payload["vm_id"]),
        filesystem_id=str(payload["filesystem_id"]),
        path=str(payload["path"]),
        created_at=str(payload["created_at"]),
    )


def _vm_info(payload: dict[str, Any]) -> Vm:
    return Vm(
        vm_id=str(payload["vm_id"]),
        owner_org_id=str(payload["owner_org_id"]),
        created_at=str(payload["created_at"]),
        public=bool(payload.get("public", False)),
        state=str(payload["state"]),
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
        network=payload.get("network") if isinstance(payload.get("network"), dict) else None,
    )


def _run_response(payload: dict[str, Any]) -> RunResult:
    if isinstance(payload.get("stdout"), str):
        return CompletedRunResult(
            stdout=_decode_bytes(str(payload["stdout"]), str(payload["stdout_encoding"])),
            stdout_encoding=str(payload["stdout_encoding"]),
            stderr=_decode_bytes(str(payload["stderr"]), str(payload["stderr_encoding"])),
            stderr_encoding=str(payload["stderr_encoding"]),
            exit_code=int(payload["exit_code"]),
        )

    if isinstance(payload.get("run_id"), str):
        return BackgroundRunResult(
            run_id=str(payload["run_id"]),
            tunnels=[_tunnel(t) for t in payload.get("tunnels", []) if isinstance(t, dict)],
            network=payload.get("network") if isinstance(payload.get("network"), dict) else None,
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
        session_id=_optional_str(payload.get("session_id")),
        command=_optional_str(payload.get("command")),
        completed_at=_optional_str(payload.get("completed_at")),
        network=payload.get("network") if isinstance(payload.get("network"), dict) else None,
        retry_count=int(retry_count) if isinstance(retry_count, int) else 0,
    )


def _run_summary(payload: dict[str, Any]) -> RunSummary:
    return RunSummary(
        run_id=str(payload["run_id"]),
        state=str(payload["state"]),
        started_at=str(payload["started_at"]),
        exit_code=_optional_int(payload.get("exit_code")),
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
