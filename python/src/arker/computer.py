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


@dataclasses.dataclass(frozen=True)
class SessionInfo:
    session_id: str
    state: str
    cwd: str


@dataclasses.dataclass(frozen=True)
class GoldenInfo:
    vm_id: str
    name: str
    source_golden: str
    memory_mib: int | None = None
    vcpu_count: int | None = None
    disk_mib: int | None = None


@dataclasses.dataclass(frozen=True)
class ListGoldensResponse:
    goldens: list[GoldenInfo]


@dataclasses.dataclass(frozen=True)
class VmInfo:
    vm_id: str
    owner_id: str
    created_at: str
    state: str
    sessions: list[SessionInfo]
    name: str | None = None
    source_golden: str | None = None
    last_activity: str | None = None
    vcpu_count: int | None = None
    memory_mib: int | None = None
    disk_mib: int | None = None


@dataclasses.dataclass(frozen=True)
class ListVmsResponse:
    vms: list[VmInfo]

    @property
    def items(self) -> list[VmInfo]:
        return self.vms

    @property
    def total(self) -> int:
        return len(self.vms)

    def __iter__(self):
        return iter(self.vms)

    def __len__(self) -> int:
        return len(self.vms)


VmSummary = VmInfo
VmList = ListVmsResponse


@dataclasses.dataclass(frozen=True)
class ForkVmResponse:
    vm_id: str
    owner_id: str
    created_at: str
    sessions: list[SessionInfo]
    ssh_private_key: str | None = None
    tunnels: list[dict[str, Any]] = dataclasses.field(default_factory=list)
    network: dict[str, Any] | None = None


@dataclasses.dataclass(frozen=True)
class DeleteVmResponse:
    deleted: bool


@dataclasses.dataclass(frozen=True)
class CompletedRunResult:
    stdout: bytes
    stdout_encoding: str
    stderr: bytes
    stderr_encoding: str
    exit_code: int
    completed: bool = True
    type: str = "completed"


@dataclasses.dataclass(frozen=True)
class BackgroundRunResult:
    run_id: str
    completed: bool
    tunnels: list[dict[str, Any]] = dataclasses.field(default_factory=list)
    network: dict[str, Any] | None = None
    type: str = "background"


@dataclasses.dataclass(frozen=True)
class PtyRunResult:
    session_id: str
    ws_url: str
    pty: bool = True
    type: str = "pty"


RunResult = CompletedRunResult | BackgroundRunResult | PtyRunResult


@dataclasses.dataclass(frozen=True)
class RunStatusResponse:
    run_id: str
    stdout: bytes
    stdout_encoding: str
    stderr: bytes
    stderr_encoding: str
    exit_code: int | None
    completed: bool
    tunnels: list[dict[str, Any]]
    network: dict[str, Any] | None = None


@dataclasses.dataclass(frozen=True)
class CancelRunResponse:
    cancelled: bool


@dataclasses.dataclass(frozen=True)
class ArkerError(Exception):
    code: str
    message: str
    status: int

    def __post_init__(self) -> None:
        Exception.__init__(self, f"{self.code}: {self.message}")


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

    def goldens(self) -> ListGoldensResponse:
        payload = self._request("GET", "/v1/goldens")
        return ListGoldensResponse([_golden_info(item) for item in payload.get("goldens", [])])

    def list(self) -> ListVmsResponse:
        payload = self._request("GET", "/v1/vms")
        return ListVmsResponse([_vm_info(item) for item in payload.get("vms", [])])

    def get(self, vm_id: str) -> VmInfo:
        return _vm_info(self._request("GET", _vm_path(vm_id), base_url=self._base_url_for(vm_id)))

    def _request(
        self,
        method: str,
        path: str,
        body: dict[str, Any] | None = None,
        *,
        base_url: str | None = None,
    ) -> dict[str, Any]:
        url = (base_url or self._base_url) + path
        headers = {"authorization": f"Bearer {self._api_key}"}
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


class Computer:
    def __init__(self, client: Arker, vm_id: str, base_url: str | None = None) -> None:
        self._client = client
        self.id = vm_id
        self.base_url = base_url or client._base_url_for(vm_id)
        self.sync = Sync(self)

    def fork(
        self,
        *,
        name: str | None = None,
        image: str | None = None,
        network: bool | str | dict[str, Any] | None = None,
        disk: bool | None = None,
        vcpu_count: int | None = None,
        memory_mib: int | None = None,
        max_memory_mib: int | None = None,
        disk_mib: int | None = None,
    ) -> "Computer":
        body = {
            "name": name,
            "image": image,
            "network": network,
            "disk": disk,
            "vcpu_count": vcpu_count,
            "memory_mib": memory_mib,
            "max_memory_mib": max_memory_mib,
            "disk_mib": disk_mib,
        }
        response = self._client._request("POST", f"{_vm_path(self.id)}/fork", body, base_url=self.base_url)
        return Computer(self._client, _fork_vm_id(response), self.base_url)

    def run(
        self,
        command: str,
        *,
        session_id: str | None = None,
        background: bool | None = None,
        timeout: int | None = None,
        end_symbol: str | None = None,
        mounts: list[dict[str, Any]] | None = None,
        vcpu_count: int | None = None,
        memory_mib: int | None = None,
        disk_mib: int | None = None,
        network: dict[str, Any] | None = None,
        release: str | None = None,
        signal: str | None = None,
        runtime: str | None = None,
        runtime_override: str | None = None,
    ) -> RunResult:
        body = {
            "command": command,
            "session_id": session_id,
            "background": background,
            "timeout": timeout,
            "end_symbol": end_symbol,
            "mounts": mounts,
            "vcpu_count": vcpu_count,
            "memory_mib": memory_mib,
            "disk_mib": disk_mib,
            "network": network,
            "release": release,
            "signal": signal,
            "runtime": runtime,
            "runtime_override": runtime_override,
        }
        return _run_response(self._client._request("POST", f"{_vm_path(self.id)}/run", body, base_url=self.base_url))

    def run_status(self, run_id: str) -> RunStatusResponse:
        return _run_status_response(self._client._request("GET", f"{_vm_path(self.id)}/runs/{_segment(run_id)}", base_url=self.base_url))

    def cancel_run(self, run_id: str) -> CancelRunResponse:
        payload = self._client._request("DELETE", f"{_vm_path(self.id)}/runs/{_segment(run_id)}", base_url=self.base_url)
        return CancelRunResponse(cancelled=bool(payload.get("cancelled")))

    def delete(self) -> DeleteVmResponse:
        payload = self._client._request("DELETE", _vm_path(self.id), base_url=self.base_url)
        return DeleteVmResponse(deleted=bool(payload.get("deleted")))


class Sync:
    def __init__(self, vm: Computer) -> None:
        self._vm = vm
        self._client = vm._client

    def read_file(self, path: str) -> bytes:
        payload = self._client._request("POST", self._path(), {"op": "read", "path": path}, base_url=self._vm.base_url)
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

    def _path(self) -> str:
        return f"{_vm_path(self._vm.id)}/sync"

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
            payload = self._client._request("POST", self._path(), {"op": "write", "writes": [entry]}, base_url=self._vm.base_url)
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


def _http(method: str, url: str, headers: dict[str, str], data: bytes | None) -> tuple[int, bytes]:
    req = urllib.request.Request(url, method=method, headers=headers, data=data)
    try:
        with urllib.request.urlopen(req, timeout=120) as response:
            return response.status, response.read()
    except urllib.error.HTTPError as error:
        return error.code, error.read()


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


def _session_info(payload: dict[str, Any]) -> SessionInfo:
    return SessionInfo(
        session_id=str(payload["session_id"]),
        state=str(payload["state"]),
        cwd=str(payload["cwd"]),
    )


def _golden_info(payload: dict[str, Any]) -> GoldenInfo:
    return GoldenInfo(
        vm_id=str(payload["vm_id"]),
        name=str(payload["name"]),
        source_golden=str(payload["source_golden"]),
        memory_mib=_optional_int(payload.get("memory_mib")),
        vcpu_count=_optional_int(payload.get("vcpu_count")),
        disk_mib=_optional_int(payload.get("disk_mib")),
    )


def _vm_info(payload: dict[str, Any]) -> VmInfo:
    return VmInfo(
        vm_id=str(payload["vm_id"]),
        owner_id=str(payload["owner_id"]),
        created_at=str(payload["created_at"]),
        state=str(payload["state"]),
        sessions=[_session_info(item) for item in payload.get("sessions", [])],
        name=_optional_str(payload.get("name")),
        source_golden=_optional_str(payload.get("source_golden")),
        last_activity=_optional_str(payload.get("last_activity")),
        vcpu_count=_optional_int(payload.get("vcpu_count")),
        memory_mib=_optional_int(payload.get("memory_mib")),
        disk_mib=_optional_int(payload.get("disk_mib")),
    )


def _fork_response(payload: dict[str, Any]) -> ForkVmResponse:
    return ForkVmResponse(
        vm_id=str(payload["vm_id"]),
        owner_id=str(payload["owner_id"]),
        created_at=str(payload["created_at"]),
        sessions=[_session_info(item) for item in payload.get("sessions", [])],
        ssh_private_key=_optional_str(payload.get("ssh_private_key")),
        tunnels=payload.get("tunnels", []) if isinstance(payload.get("tunnels", []), list) else [],
        network=payload.get("network") if isinstance(payload.get("network"), dict) else None,
    )


def _fork_vm_id(payload: dict[str, Any]) -> str:
    value = payload.get("vm_id") or payload.get("id")
    if not isinstance(value, str) or not value:
        raise ArkerError("internal", "fork response.vm_id must be a non-empty string", 200)
    return value


def _run_response(payload: dict[str, Any]) -> RunResult:
    if isinstance(payload.get("stdout"), str):
        if payload.get("completed") is not True:
            raise ArkerError("internal", "completed run response must have completed=true", 200)
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
            completed=bool(payload.get("completed")),
            tunnels=payload.get("tunnels", []) if isinstance(payload.get("tunnels", []), list) else [],
            network=payload.get("network") if isinstance(payload.get("network"), dict) else None,
        )

    if payload.get("pty") is True:
        return PtyRunResult(
            session_id=str(payload["session_id"]),
            ws_url=str(payload["ws_url"]),
        )

    raise ArkerError("internal", "unrecognized run response shape", 200)


def _run_status_response(payload: dict[str, Any]) -> RunStatusResponse:
    return RunStatusResponse(
        run_id=str(payload["run_id"]),
        stdout=_decode_bytes(str(payload["stdout"]), str(payload["stdout_encoding"])),
        stdout_encoding=str(payload["stdout_encoding"]),
        stderr=_decode_bytes(str(payload["stderr"]), str(payload["stderr_encoding"])),
        stderr_encoding=str(payload["stderr_encoding"]),
        exit_code=_optional_int(payload.get("exit_code")),
        completed=bool(payload.get("completed")),
        tunnels=payload.get("tunnels", []) if isinstance(payload.get("tunnels", []), list) else [],
        network=payload.get("network") if isinstance(payload.get("network"), dict) else None,
    )


def _optional_str(value: Any) -> str | None:
    return value if isinstance(value, str) else None


def _optional_int(value: Any) -> int | None:
    return int(value) if isinstance(value, int) else None
