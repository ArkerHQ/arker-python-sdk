"""Unit tests for the Arker Python SDK.

Patches `urllib.request.urlopen` to fake server responses — no real
network. Covers the four behaviour categories that matter for SDK
correctness:

  1. Chunk-vs-presigned write strategy by byte count
  2. Error envelope unwrap → ArkerError(code, message, status)
  3. Read-response decoding (utf8 vs base64 vs presigned-URL)
  4. Background-run polling completes correctly

Run with: ``pytest sdk/custom/python/test_computer.py -v``
"""

from __future__ import annotations

import base64
import io
import json
import sys
import urllib.error
from pathlib import Path
from typing import Any
from unittest.mock import patch

# Import the SDK directly from this directory.
import arker.computer as sdk  # local-import; install with pip install -e .


# ── Fake transport ────────────────────────────────────────────────


class _FakeResp:
    """Mimics the small bits of urllib's HTTPResponse the SDK uses."""

    def __init__(self, status: int, body: bytes) -> None:
        self.status = status
        self._body = body

    def read(self) -> bytes:
        return self._body

    def __enter__(self) -> "_FakeResp":
        return self

    def __exit__(self, *_: Any) -> None:
        return None


class FakeTransport:
    """Records each urlopen call and returns scripted responses.

    Scripts are a list of `(predicate, status, body)` triples. Each
    request searches the script for the first predicate that matches
    the (method, url) pair and consumes that entry — subsequent
    matches advance to the next scripted entry. This is intentional
    so background-poll tests can step through a sequence of
    incomplete-then-complete responses without rewriting predicates."""

    def __init__(self) -> None:
        self.calls: list[dict[str, Any]] = []
        self.script: list[tuple[Any, int, bytes]] = []

    def add_json(self, predicate, status: int, body: dict[str, Any]) -> None:
        self.script.append((predicate, status, json.dumps(body).encode()))

    def add_raw(self, predicate, status: int, body: bytes) -> None:
        self.script.append((predicate, status, body))

    def __call__(self, req, timeout=None):  # type: ignore[no-untyped-def]
        url = req.full_url if hasattr(req, "full_url") else req
        method = req.get_method() if hasattr(req, "get_method") else "GET"
        self.calls.append({
            "method": method,
            "url": url,
            "body": req.data if hasattr(req, "data") else None,
            "headers": dict(req.headers) if hasattr(req, "headers") else {},
        })
        for i, (pred, status, body) in enumerate(self.script):
            if pred(method, url):
                self.script.pop(i)
                if 200 <= status < 400:
                    return _FakeResp(status, body)
                raise urllib.error.HTTPError(url, status, "fake", {}, io.BytesIO(body))
        raise AssertionError(f"no scripted response for {method} {url}")


def _client(_t: FakeTransport) -> sdk.Arker:
    return sdk.Arker(api_key="ark_live_test", base_url="https://test.invalid")


# ── ULID ──────────────────────────────────────────────────────────


def test_ulid_is_26_char_crockford() -> None:
    u = sdk._ulid()
    assert len(u) == 26
    assert all(c in sdk.ULID_ALPHABET for c in u)
    assert sdk._ulid() != sdk._ulid()


# ── Error-envelope unwrap ─────────────────────────────────────────


def test_error_envelope_becomes_arker_error() -> None:
    t = FakeTransport()
    t.add_json(
        lambda m, u: True,
        404,
        {"ok": False, "error": {"code": "not_found", "message": "vm not found"}},
    )
    with patch("urllib.request.urlopen", t):
        c = sdk.Computer(_client(t), "01BOGUS")
        try:
            c.delete()
        except sdk.ArkerError as e:
            assert e.code == "not_found"
            assert e.status == 404
            assert "vm not found" in e.message
        else:
            raise AssertionError("expected ArkerError")


def test_4xx_without_envelope_still_raises() -> None:
    t = FakeTransport()
    t.add_raw(lambda m, u: True, 500, b"<html>upstream broke</html>")
    with patch("urllib.request.urlopen", t):
        try:
            sdk.Computer(_client(t), "01X").delete()
        except sdk.ArkerError as e:
            assert e.status == 500
        else:
            raise AssertionError("expected ArkerError")


# ── Read-response decoding ────────────────────────────────────────


def test_read_inline_utf8() -> None:
    t = FakeTransport()
    t.add_json(
        lambda m, u: u.endswith("/sync") and m == "POST",
        200,
        {"ok": True, "op": "read", "path": "/home/user/foo", "size": 5,
         "content": "hello", "encoding": "utf-8"},
    )
    with patch("urllib.request.urlopen", t):
        bytes_back = sdk.Computer(_client(t), "01X").sync.read_file("/home/user/foo")
        assert bytes_back == b"hello"


def test_read_inline_base64() -> None:
    payload = bytes(range(256))
    t = FakeTransport()
    t.add_json(
        lambda m, u: u.endswith("/sync") and m == "POST",
        200,
        {"ok": True, "op": "read", "path": "/home/user/bin", "size": len(payload),
         "content": base64.b64encode(payload).decode(), "encoding": "base64"},
    )
    with patch("urllib.request.urlopen", t):
        assert sdk.Computer(_client(t), "01X").sync.read_file("/home/user/bin") == payload


def test_read_presigned_follows_url() -> None:
    payload = b"X" * 7_000_000
    t = FakeTransport()
    t.add_json(
        lambda m, u: u.endswith("/sync") and m == "POST",
        200,
        {"ok": True, "op": "read", "path": "/home/user/big", "size": len(payload),
         "presigned_url": "https://s3.test/abc", "expires_in": 900, "method": "GET"},
    )
    t.add_raw(lambda m, u: u == "https://s3.test/abc", 200, payload)
    with patch("urllib.request.urlopen", t):
        assert sdk.Computer(_client(t), "01X").sync.read_file("/home/user/big") == payload


# ── Write strategy: chunk vs presigned ────────────────────────────


def test_small_write_uses_single_chunk_fast_path() -> None:
    t = FakeTransport()
    t.add_json(
        lambda m, u: u.endswith("/sync") and m == "POST",
        200,
        {"ok": True, "op": "write", "results": [
            {"path": "/home/user/x", "size": 11, "complete": True, "written": True,
             "received_bytes": 11, "ranges": [{"start": 0, "end": 11}]},
        ]},
    )
    with patch("urllib.request.urlopen", t):
        sdk.Computer(_client(t), "01X").sync.write_file("/home/user/x", b"hello world")
    assert len(t.calls) == 1, "small write must be one round-trip"
    body = json.loads(t.calls[0]["body"])
    assert body["op"] == "write"
    assert len(body["writes"]) == 1
    entry = body["writes"][0]
    assert entry["start"] == 0 and entry["end"] == 11
    assert entry["upload_id"] and len(entry["upload_id"]) == 26
    assert base64.b64decode(entry["content"]) == b"hello world"


def test_above_threshold_write_uses_presigned_bypass() -> None:
    """Anything > PRESIGNED_THRESHOLD takes the Shape-2/Shape-3 path,
    not multi-chunk-through-Lambda. Presigned-bypass is unambiguously
    cheaper above ~5 MB (zero bytes through Lambda) and the SDK never
    takes the multi-chunk path — clients that want resumable / parallel
    chunked uploads call the wire API directly."""
    payload = b"A" * (12 * 1024 * 1024)  # 12 MB, well above CHUNK_SIZE
    t = FakeTransport()
    pred_post = lambda m, u: u.endswith("/sync") and m == "POST"
    t.add_json(pred_post, 200, {"ok": True, "op": "write", "results": [{
        "path": "/home/user/y", "size": len(payload),
        "presigned_url": "https://s3.test/up", "upload_id": "01" + "B" * 24,
        "expires_in": 900, "method": "PUT",
        "complete": False, "written": False,
    }]})
    t.add_raw(lambda m, u: m == "PUT" and u == "https://s3.test/up", 200, b"")
    t.add_json(pred_post, 200, {"ok": True, "op": "write", "results": [{
        "path": "/home/user/y", "size": len(payload),
        "complete": True, "written": True,
    }]})
    with patch("urllib.request.urlopen", t):
        sdk.Computer(_client(t), "01X").sync.write_file("/home/user/y", payload)
    assert [c["method"] for c in t.calls] == ["POST", "PUT", "POST"]
    # First call MUST be a presigned-request (no chunked-write fields).
    first = json.loads(t.calls[0]["body"])
    assert first["writes"][0].get("presigned") is True
    assert "content" not in first["writes"][0]
    assert "start" not in first["writes"][0]


def test_large_write_uses_presigned_bypass() -> None:
    payload = b"Z" * (60 * 1024 * 1024)  # 60 MB > PRESIGNED_THRESHOLD
    t = FakeTransport()
    t.add_json(
        lambda m, u: u.endswith("/sync") and m == "POST",
        200,
        {"ok": True, "op": "write", "results": [{
            "path": "/home/user/big", "size": len(payload),
            "presigned_url": "https://s3.test/up", "upload_id": "01" + "A" * 24,
            "expires_in": 900, "method": "PUT",
            "complete": False, "written": False,
        }]},
    )
    t.add_raw(lambda m, u: m == "PUT" and u == "https://s3.test/up", 200, b"")
    t.add_json(
        lambda m, u: u.endswith("/sync") and m == "POST",
        200,
        {"ok": True, "op": "write", "results": [{
            "path": "/home/user/big", "size": len(payload),
            "complete": True, "written": True,
        }]},
    )
    with patch("urllib.request.urlopen", t):
        sdk.Computer(_client(t), "01X").sync.write_file("/home/user/big", payload)
    assert [c["method"] for c in t.calls] == ["POST", "PUT", "POST"]


def test_per_entry_error_in_write_response_raises() -> None:
    t = FakeTransport()
    t.add_json(
        lambda m, u: u.endswith("/sync") and m == "POST",
        200,
        {"ok": True, "op": "write", "results": [
            {"path": "/home/user/x", "size": 5, "complete": False, "written": False,
             "error": {"code": "conflict", "message": "range overlaps prior chunk"}},
        ]},
    )
    with patch("urllib.request.urlopen", t):
        try:
            sdk.Computer(_client(t), "01X").sync.write_file("/home/user/x", b"hello")
        except sdk.ArkerError as e:
            assert e.code == "conflict"
        else:
            raise AssertionError("expected ArkerError")


# ── Run + background poll ─────────────────────────────────────────


def test_run_returns_run_result() -> None:
    t = FakeTransport()
    t.add_json(
        lambda m, u: "/run" in u and m == "POST",
        200,
        {"stdout": "hi\n", "stdout_encoding": "utf-8",
         "stderr": "", "stderr_encoding": "utf-8",
         "exit_code": 0, "completed": True, "duration_ms": 12.5,
         "session_id": "sess_1", "cwd": "/home/user"},
    )
    with patch("urllib.request.urlopen", t):
        r = sdk.Computer(_client(t), "01X").run("echo hi", session_id="sess_1")
    assert isinstance(r, sdk.RunResult)
    assert r.stdout == b"hi\n"
    assert r.exit_code == 0
    assert r.session_id == "sess_1"


def test_run_base64_stdout_decoded() -> None:
    payload = bytes(range(64))
    t = FakeTransport()
    t.add_json(
        lambda m, u: "/run" in u and m == "POST",
        200,
        {"stdout": base64.b64encode(payload).decode(), "stdout_encoding": "base64",
         "stderr": "", "stderr_encoding": "utf-8",
         "exit_code": 0, "completed": True, "duration_ms": 1.0,
         "session_id": "s", "cwd": "/"},
    )
    with patch("urllib.request.urlopen", t):
        r = sdk.Computer(_client(t), "01X").run("printf $(seq 0 63)")
    assert isinstance(r, sdk.RunResult)
    assert r.stdout == payload


# ── Transient-retry transport ────────────────────────────────────


def test_transport_retries_on_503_then_succeeds(monkeypatch) -> None:
    """503 SlowDown → backoff → retry → 200. The SDK should hide the
    transient and return the success result. Backoff is patched to
    no-op so the test stays fast."""
    monkeypatch.setattr(sdk.time, "sleep", lambda *_: None)
    t = FakeTransport()
    # First two attempts: 503. Third: success.
    pred = lambda m, u: u.endswith("/sync") and m == "POST"
    t.add_raw(pred, 503, b"<Error><Code>SlowDown</Code></Error>")
    t.add_raw(pred, 503, b"<Error><Code>SlowDown</Code></Error>")
    t.add_json(pred, 200, {"ok": True, "op": "read", "path": "/home/user/x", "size": 2,
                            "content": "ok", "encoding": "utf-8"})
    with patch("urllib.request.urlopen", t):
        bytes_back = sdk.Computer(_client(t), "01X").sync.read_file("/home/user/x")
    assert bytes_back == b"ok"
    # Three urlopen calls — two retries plus the success.
    assert len(t.calls) == 3


def test_transport_gives_up_after_max_attempts(monkeypatch) -> None:
    """Persistent 503 should eventually surface as ArkerError after the
    SDK exhausts its retry budget — not silently masquerade as success."""
    monkeypatch.setattr(sdk.time, "sleep", lambda *_: None)
    t = FakeTransport()
    pred = lambda m, u: True
    for _ in range(sdk.MAX_ATTEMPTS):
        t.add_raw(pred, 503, b'{"ok":false,"error":{"code":"internal","message":"S3 SlowDown"}}')
    with patch("urllib.request.urlopen", t):
        try:
            sdk.Computer(_client(t), "01X").delete()
        except sdk.ArkerError as e:
            assert e.status == 503
            assert e.code == "internal"
        else:
            raise AssertionError("expected ArkerError after retry exhaustion")
    assert len(t.calls) == sdk.MAX_ATTEMPTS


def test_per_entry_internal_503_retries(monkeypatch) -> None:
    """Lambda translates an upstream S3 SlowDown into a per-entry
    `error.code:"internal"` inside a 200 response. The SDK's
    `_send_with_entry_retry` should retry the chunk before surfacing
    the error to the caller."""
    monkeypatch.setattr(sdk.time, "sleep", lambda *_: None)
    t = FakeTransport()
    pred = lambda m, u: u.endswith("/sync") and m == "POST"
    transient = {"path": "/home/user/x", "size": 11,
                 "complete": False, "written": False,
                 "error": {"code": "internal",
                           "message": "chunk put: S3 Express PUT error: 503 Service Unavailable SlowDown"}}
    t.add_json(pred, 200, {"ok": True, "op": "write", "results": [transient]})
    t.add_json(pred, 200, {"ok": True, "op": "write", "results": [transient]})
    t.add_json(pred, 200, {"ok": True, "op": "write", "results": [
        {"path": "/home/user/x", "size": 11, "complete": True, "written": True,
         "received_bytes": 11, "ranges": [{"start": 0, "end": 11}]},
    ]})
    with patch("urllib.request.urlopen", t):
        sdk.Computer(_client(t), "01X").sync.write_file("/home/user/x", b"hello world")
    assert len(t.calls) == 3, "expected 2 retries + 1 success"


def test_per_entry_non_transient_error_does_not_retry(monkeypatch) -> None:
    """A `conflict` per-entry error means the server made a deliberate
    decision (range overlap, path mismatch). Don't retry — bubble up."""
    monkeypatch.setattr(sdk.time, "sleep", lambda *_: None)
    t = FakeTransport()
    t.add_json(lambda m, u: True, 200, {"ok": True, "op": "write", "results": [
        {"path": "/home/user/x", "size": 5, "complete": False, "written": False,
         "error": {"code": "conflict", "message": "range overlap"}},
    ]})
    with patch("urllib.request.urlopen", t):
        try:
            sdk.Computer(_client(t), "01X").sync.write_file("/home/user/x", b"hello")
        except sdk.ArkerError as e:
            assert e.code == "conflict"
        else:
            raise AssertionError("expected ArkerError")
    assert len(t.calls) == 1, "non-transient must not retry"


def test_transport_does_not_retry_4xx(monkeypatch) -> None:
    """A 404 / 409 / 400 is the server's deliberate answer — the SDK
    must NOT retry those. Only `_RETRYABLE_STATUSES` (429, 502, 503,
    504) trigger backoff."""
    monkeypatch.setattr(sdk.time, "sleep", lambda *_: None)
    t = FakeTransport()
    t.add_json(lambda m, u: True, 404,
               {"ok": False, "error": {"code": "not_found", "message": "no"}})
    with patch("urllib.request.urlopen", t):
        try:
            sdk.Computer(_client(t), "01X").delete()
        except sdk.ArkerError as e:
            assert e.code == "not_found"
        else:
            raise AssertionError("expected ArkerError")
    assert len(t.calls) == 1, "404 must not trigger retries"


# ── Fork ──────────────────────────────────────────────────────────


def test_fork_from_vm_returns_new_computer() -> None:
    """A ULID-shaped `self.id` makes `.fork()` use the by-id endpoint
    `/api/v1/vms/{id}/fork`. Names like "arkuntu" route to by-ref."""
    parent = "01ABCDEFGHJKMNPQRSTVWXYZ23_uswe"
    t = FakeTransport()
    t.add_json(
        lambda m, u: u.endswith(f"/{parent}/fork") and m == "POST",
        200,
        {"vm_id": "01CHILD0000000000000000000_uswe", "org_id": "org_1",
         "region": "us-west-2", "base_image": "arkuntu", "name": "child",
         "is_public": False, "parent_vm_id": parent,
         "created_at": 1000000, "state": "running"},
    )
    with patch("urllib.request.urlopen", t):
        child = _client(t).vm(parent).fork(name="child")
    assert isinstance(child, sdk.Computer)
    assert child.id == "01CHILD0000000000000000000_uswe"


def test_fork_from_template_name_uses_by_ref_endpoint() -> None:
    """`arker.vm("arkuntu").fork()` should hit /api/v1/vms/fork (by-ref)
    so the server resolves the template name. The dispatch lives in
    `Computer.fork`: ULID-shape `self.id` → by-id, otherwise by-ref."""
    t = FakeTransport()
    t.add_json(
        lambda m, u: u.endswith("/api/v1/vms/fork") and m == "POST",
        200,
        {"vm_id": "01NEW", "org_id": "org_1", "region": "us-west-2",
         "base_image": "arkuntu", "is_public": False,
         "parent_vm_id": "01ARKUNTU", "created_at": 1000000, "state": "running"},
    )
    with patch("urllib.request.urlopen", t):
        vm = _client(t).vm("arkuntu").fork(name="hello")
    assert isinstance(vm, sdk.Computer)
    assert vm.id == "01NEW"
    body = json.loads(t.calls[0]["body"])
    assert body["from"] == "arkuntu"
    assert body["name"] == "hello"


def test_arker_vm_takes_possession_of_existing_id() -> None:
    """`arker.vm(id)` is the ONLY way to get a Computer handle. No
    network call — just wraps the ID. Subsequent calls hit the wire."""
    t = FakeTransport()
    a = _client(t)
    vm = a.vm("01ABCDEFGHJKMNPQRSTVWXYZ23_uswe")
    assert isinstance(vm, sdk.Computer)
    assert vm.id == "01ABCDEFGHJKMNPQRSTVWXYZ23_uswe"
    # No HTTP traffic from .vm() itself.
    assert len(t.calls) == 0
