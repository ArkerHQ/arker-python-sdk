"""Arker SDK — single-file Python client.

Quickstart:

    from arker import Arker
    arker = Arker(api_key="ark_live_...")
    vm    = arker.vm("arkuntu").fork(name="hello")     # fresh VM from base image
    result = vm.run("echo hi")                          # result.stdout: bytes, result.exit_code: int

    vm.sync.write_file("/home/user/data.bin", b"...")
    blob = vm.sync.read_file("/home/user/data.bin")    # → bytes

    child = vm.fork(name="branch")                     # branch off this VM
    child.delete(); vm.delete()

    # List your VMs (paginated):
    page = arker.list(limit=10)
    for summary in page.items:
        print(summary.vm_id, summary.name, summary.created_at)

    # Re-open an existing VM by ID (no network call):
    same_vm = arker.vm("01ABC...XYZ_d8c0")

Errors raise `ArkerError(code, message, status)`.
"""
from __future__ import annotations
import base64, dataclasses, json, os, secrets, time, urllib.error, urllib.parse, urllib.request
from typing import Any

DEFAULT_BASE_URL = "https://aws-us-west-2.burst.arker.ai"
LIST_BASE_URL    = "https://arker.ai"   # `list` is served from a different host than the rest;
                                        # used regardless of the client's base_url.
SOURCE_ALIASES   = {"arkuntu": "01KQBYKEV5WJ7YB010603T1DCT_d8c0"}  # public base images
CHUNK_SIZE       = 4 * 1024 * 1024     # files above this go through a direct upload
PRESIGN_EXPIRES  = 900                  # signed-URL lifetime (s)
RETRYABLE_HTTP   = {429, 502, 503, 504}
# Substring matches in `error.message` that mark a transient failure
# the server expects clients to retry. Matched verbatim against the
# message returned in the error envelope.
_TRANSIENT_HINTS = ("503", "Service Unavailable", "throttle", "SlowDown", "ThrottlingException")
MAX_ATTEMPTS     = 4
BACKOFF_S        = 0.2
ULID_ALPHABET    = "0123456789ABCDEFGHJKMNPQRSTVWXYZ"


class ArkerError(Exception):
    def __init__(self, code: str, message: str, status: int) -> None:
        super().__init__(f"{code}: {message}")
        self.code, self.message, self.status = code, message, status


@dataclasses.dataclass
class RunResult:
    stdout: bytes; stderr: bytes; exit_code: int
    duration_ms: float; session_id: str; cwd: str


@dataclasses.dataclass
class VmSummary:
    """One row from `Arker.list()`. `created_at` is ISO 8601 UTC."""
    vm_id: str
    name: str | None
    base_image: str
    region: str
    created_at: str


@dataclasses.dataclass
class VmList:
    items: list[VmSummary]
    total: int                          # total matching the query, ignoring limit/offset
    def __iter__(self): return iter(self.items)
    def __len__(self): return len(self.items)


def _ulid() -> str:
    """26-char Crockford-base32 ULID; not strictly monotonic, but unique
    enough — the server's `If-None-Match: *` catches any duplicates."""
    raw = ((int(time.time() * 1000) & ((1 << 48) - 1)) << 80) | secrets.randbits(80)
    out = []
    for _ in range(26):
        out.append(ULID_ALPHABET[raw & 31]); raw >>= 5
    return "".join(reversed(out))


def _looks_like_vm_id(s: str) -> bool:
    """ULID-shape check: 26 Crockford chars, optionally `_<region>` suffix
    of 1+ alphanumeric chars (e.g. `_uswe`, `_d8c0`). Used by `fork()`
    to dispatch by-id vs by-ref."""
    if "_" in s:
        head, _, tail = s.partition("_")
        if not tail or not all(c.isalnum() for c in tail):
            return False
    else:
        head = s
    if len(head) != 26:
        return False
    return all(c in ULID_ALPHABET for c in head.upper())


def _decode_stream(text: Any, encoding: Any) -> bytes:
    s = text or ""
    if encoding == "base64":
        try: return base64.b64decode(s)
        except Exception: pass
    return (s if isinstance(s, str) else "").encode("utf-8", "replace")


def _is_transient(err: dict | None) -> bool:
    if not err or err.get("code") != "internal":
        return False
    return any(h in (err.get("message") or "") for h in _TRANSIENT_HINTS)


def _http(method: str, url: str, headers: dict, body: bytes | None) -> tuple[int, bytes]:
    """Single-shot urllib request. Retry policy lives in `Arker._request`."""
    req = urllib.request.Request(url, method=method, headers=headers, data=body)
    try:
        resp = urllib.request.urlopen(req, timeout=120)
        return resp.status, resp.read()
    except urllib.error.HTTPError as e:
        return e.code, e.read()


class Arker:
    """Top-level client. Default `base_url` points at the production
    regional endpoint; override per-client or via the `ARKER_BASE_URL`
    env var to use a different region or a self-hosted deployment."""
    def __init__(self, api_key: str, base_url: str | None = None) -> None:
        if not api_key: raise ValueError("api_key is required")
        self._api_key = api_key
        self._base_url = (base_url or os.environ.get("ARKER_BASE_URL") or DEFAULT_BASE_URL).rstrip("/")

    def _request(self, method: str, path: str, body: dict | None = None,
                 *, base_url: str | None = None) -> dict:
        """One retry budget covering both transient HTTP statuses and
        envelope-level transient errors. `base_url=` overrides the client
        default for routes that live on a different host (e.g. `list`)."""
        headers = {"authorization": f"Bearer {self._api_key}", "content-type": "application/json"}
        data = json.dumps(body).encode() if body is not None else None
        url = (base_url.rstrip("/") if base_url else self._base_url) + path
        last_status, last_err, last_payload = 0, None, None
        for attempt in range(MAX_ATTEMPTS):
            status, raw = _http(method, url, headers, data)
            try: payload = json.loads(raw) if raw else {}
            except json.JSONDecodeError: payload = None
            last_status, last_payload = status, payload
            envelope_err = (payload.get("error") if isinstance(payload, dict) and payload.get("ok") is False else None)
            last_err = envelope_err
            if status in RETRYABLE_HTTP or _is_transient(envelope_err):
                if attempt == MAX_ATTEMPTS - 1: break
                time.sleep(BACKOFF_S * (2 ** attempt) + secrets.randbelow(50) / 1000.0)
                continue
            if envelope_err is not None:
                raise ArkerError(envelope_err.get("code", "internal"), envelope_err.get("message", ""), status)
            if status >= 400:
                raise ArkerError("internal", str(payload)[:200], status)
            return payload  # type: ignore[return-value]
        if last_err is not None:
            raise ArkerError(last_err.get("code", "internal"), last_err.get("message", ""), last_status)
        raise ArkerError("internal", str(last_payload)[:200], last_status)

    def vm(self, vm_id: str) -> "Computer":
        """Open a handle to a VM by ULID *or* by template name (e.g.
        `"arkuntu"`). Names resolve on `.fork()` only — you can't
        `.run()` against a name handle. No network call here."""
        return Computer(self, vm_id)

    def list(self, *, limit: int = 25, offset: int = 0,
             q: str | None = None, sort: str | None = None) -> VmList:
        """List VMs in the caller's organization. Always hits
        `https://arker.ai` regardless of the client's `base_url` — list
        data is served from a global host rather than the regional one.

        Args:
            limit:  1–100, default 25.
            offset: ≥0, default 0.
            q:      substring filter on VM name.
            sort:   `created_at` | `-created_at` | `region` | `-region`.
                    Default `-created_at` (newest first).
        """
        params: dict[str, str] = {}
        if limit  != 25:    params["limit"]  = str(limit)
        if offset != 0:     params["offset"] = str(offset)
        if q is not None:   params["q"]      = q
        if sort is not None: params["sort"]  = sort
        path = "/api/v1/vms/list"
        if params:
            path += "?" + urllib.parse.urlencode(params)
        r = self._request("GET", path, base_url=LIST_BASE_URL)
        items = [VmSummary(
            vm_id      = i["vm_id"],
            name       = i.get("name"),
            base_image = i["base_image"],
            region     = i["region"],
            created_at = i["created_at"],
        ) for i in r.get("items", [])]
        return VmList(items=items, total=int(r.get("total", 0)))


class Computer:
    """A handle on one VM. Methods: `.delete()`, `.fork(...)`, `.run(...)`,
    `.sync.read_file(path)`, `.sync.write_file(path, data)`."""
    def __init__(self, client: Arker, vm_id: str) -> None:
        self._client, self.id = client, vm_id
        self._default_session: str | None = None
        self.sync = Sync(self)

    def delete(self) -> None:
        self._client._request("DELETE", f"/api/v1/vms/{self.id}")

    def fork(self, *, name: str | None = None, is_public: bool = False,
             region: str | None = None) -> "Computer":
        """Branch off this VM. Aliases like `"arkuntu"` resolve to a
        ULID client-side via `SOURCE_ALIASES`; the request then uses
        the by-id endpoint so it works on the default `base_url`."""
        body: dict[str, Any] = {"is_public": is_public}
        if name is not None:   body["name"] = name
        if region is not None: body["region"] = region
        resolved = SOURCE_ALIASES.get(self.id, self.id)
        if _looks_like_vm_id(resolved):
            r = self._client._request("POST", f"/api/v1/vms/{resolved}/fork", body)
        else:
            # Unknown name; let the global host resolve it.
            body["from"] = self.id
            r = self._client._request("POST", "/api/v1/vms/fork", body, base_url=LIST_BASE_URL)
        if not r.get("vm_id"):
            raise ArkerError("internal", "fork response missing vm_id", 200)
        return Computer(self._client, r["vm_id"])

    def run(self, command: str, *, session_id: str | int | None = None,
            timeout: int | None = None) -> RunResult:
        body: dict[str, Any] = {"command": command,
                                "session_id": session_id if session_id is not None else (self._default_session or 0)}
        if timeout is not None: body["timeout"] = timeout
        r = self._client._request("POST", f"/api/v1/vms/{self.id}/run", body)
        return RunResult(
            stdout=_decode_stream(r.get("stdout"), r.get("stdout_encoding")),
            stderr=_decode_stream(r.get("stderr"), r.get("stderr_encoding")),
            exit_code=int(r.get("exit_code", 0)),
            duration_ms=float(r.get("duration_ms", 0.0)),
            session_id=str(r.get("session_id", "")),
            cwd=str(r.get("cwd", "")),
        )


class Sync:
    """File I/O for one VM. Routes through `/api/v1/vms/{id}/sync`. Hides
    chunk-vs-presigned write strategy and inline-vs-presigned reads."""
    def __init__(self, vm: Computer) -> None:
        self._vm, self._client = vm, vm._client

    def _path(self) -> str: return f"/api/v1/vms/{self._vm.id}/sync"

    def read_file(self, path: str) -> bytes:
        r = self._client._request("POST", self._path(), {"op": "read", "path": path})
        if "content" in r:
            c = r["content"]
            return base64.b64decode(c) if r.get("encoding") == "base64" else c.encode("utf-8")
        url = r.get("presigned_url")
        if not url: raise ArkerError("internal", "read response missing content/presigned_url", 200)
        with urllib.request.urlopen(url, timeout=300) as resp:
            return resp.read()

    def write_file(self, path: str, data: bytes | str) -> None:
        if isinstance(data, str): data = data.encode("utf-8")
        if not data: raise ArkerError("bad_request", "write_file: empty data", 400)
        if len(data) <= CHUNK_SIZE:
            self._fast_path(path, data)
        else:
            self._presigned(path, data)

    def _fast_path(self, path: str, data: bytes) -> None:
        """Single-chunk write for payloads ≤ CHUNK_SIZE: one round-trip,
        bytes carried inline."""
        size = len(data)
        entry = {"path": path, "size": size, "upload_id": _ulid(),
                 "start": 0, "end": size,
                 "content": base64.b64encode(data).decode("ascii")}
        result = self._send_one(entry)
        if not (result.get("complete") and result.get("written")):
            raise ArkerError("internal", "fast-path write returned without complete+written", 200)

    def _presigned(self, path: str, data: bytes) -> None:
        """> CHUNK_SIZE: request a signed upload URL, PUT bytes directly,
        then commit. Bytes never pass through the API layer."""
        size = len(data)
        # Step 1 — request the signed URL.
        e1 = self._send_one({"path": path, "size": size, "presigned": True})
        url, upload_id = e1["presigned_url"], e1["upload_id"]
        # Step 2 — direct PUT to the upload URL, retrying transient HTTP statuses.
        for attempt in range(MAX_ATTEMPTS):
            try:
                req = urllib.request.Request(url, method="PUT", data=data)
                with urllib.request.urlopen(req, timeout=600) as resp:
                    if resp.status >= 400:
                        raise urllib.error.HTTPError(url, resp.status, "fail", {}, None)
                break
            except urllib.error.HTTPError as e:
                if e.code not in RETRYABLE_HTTP or attempt == MAX_ATTEMPTS - 1:
                    raise ArkerError("internal", f"upload PUT failed: {e.code}", e.code)
                time.sleep(BACKOFF_S * (2 ** attempt))
        # Step 3 — commit.
        self._send_one({"path": path, "size": size, "upload_id": upload_id})

    def _send_one(self, entry: dict) -> dict:
        """POST a single-entry write request, retrying transient
        envelope-level errors (HTTP 200 with `error.code:"internal"` and
        a throttling-style hint in the message)."""
        last_err = None
        for attempt in range(MAX_ATTEMPTS):
            r = self._client._request("POST", self._path(), {"op": "write", "writes": [entry]})
            result = (r.get("results") or [{}])[0]
            err = result.get("error")
            if not err: return result
            last_err = err
            if not _is_transient(err) or attempt == MAX_ATTEMPTS - 1: break
            time.sleep(BACKOFF_S * (2 ** attempt) + secrets.randbelow(50) / 1000.0)
        raise ArkerError(last_err.get("code", "internal"), last_err.get("message", ""), 200)
