from __future__ import annotations

import base64
import io
import json
import urllib.error
from typing import Any
from unittest.mock import patch

import pytest

import arker.computer as sdk


class FakeResp:
    def __init__(self, status: int, body: bytes) -> None:
        self.status = status
        self._body = body

    def read(self) -> bytes:
        return self._body

    def __enter__(self) -> "FakeResp":
        return self

    def __exit__(self, *_: Any) -> None:
        return None


class FakeTransport:
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
        body = req.data if hasattr(req, "data") else None
        self.calls.append({"method": method, "url": url, "body": body, "timeout": timeout})

        for index, (predicate, status, payload) in enumerate(self.script):
            if predicate(method, url):
                self.script.pop(index)
                if 200 <= status < 400:
                    return FakeResp(status, payload)
                raise urllib.error.HTTPError(url, status, "fake", {}, io.BytesIO(payload))

        raise AssertionError(f"no scripted response for {method} {url}")


def client() -> sdk.Arker:
    return sdk.Arker(api_key="ark_live_test", base_url="https://test.invalid/api", retry=False)


def region_client() -> sdk.Arker:
    return sdk.Arker(api_key="ark_live_test", region="aws-us-west-2", retry=False)


def session(session_id: str = "s0") -> dict[str, str]:
    return {"session_id": session_id, "state": "ready", "cwd": "/home/user"}


def test_constructor_requires_base_url(monkeypatch) -> None:
    monkeypatch.delenv("ARKER_BASE_URL", raising=False)
    monkeypatch.delenv("ARKER_REGION", raising=False)
    monkeypatch.delenv("ARKER_API_KEY", raising=False)
    with pytest.raises(ValueError, match="region or base_url is required"):
        sdk.Arker(api_key="ark_live_test")


def test_constructor_reads_env(monkeypatch) -> None:
    monkeypatch.setenv("ARKER_API_KEY", "ark_live_env")
    monkeypatch.setenv("ARKER_BASE_URL", "https://env.invalid/api/")
    assert sdk.Arker().base_url == "https://env.invalid/api"


def test_fork_posts_directly_to_source_vm() -> None:
    t = FakeTransport()
    t.add_json(
        lambda method, url: method == "POST" and url == "https://test.invalid/api/v1/vms/ubuntu/fork",
        200,
        {"vm_id": "vm_child", "owner_id": "owner", "created_at": "now", "sessions": [session()]},
    )

    with patch("urllib.request.urlopen", t):
        vm = client().vm("ubuntu").fork(name="demo")

    assert vm.id == "vm_child"
    body = json.loads(t.calls[0]["body"])
    assert body == {"name": "demo"}


def test_fork_accepts_legacy_id_response() -> None:
    t = FakeTransport()
    t.add_json(
        lambda method, url: method == "POST" and url == "https://test.invalid/api/v1/vms/ubuntu/fork",
        200,
        {"id": "vm_child"},
    )

    with patch("urllib.request.urlopen", t):
        vm = client().vm("ubuntu").fork()

    assert vm.id == "vm_child"


def test_region_routes_goldens_to_main_endpoint() -> None:
    t = FakeTransport()
    t.add_json(
        lambda method, url: method == "POST" and url == "https://aws-us-west-2.arker.ai/v1/vms/ubuntu/fork",
        200,
        {"vm_id": "vmh-child", "owner_id": "owner", "created_at": "now", "sessions": []},
    )

    with patch("urllib.request.urlopen", t):
        arker = region_client()
        vm = arker.vm("ubuntu").fork()

    assert arker.base_url == "https://aws-us-west-2.arker.ai"
    assert arker.burst_base_url == "https://aws-burst-us-west-2.arker.ai/api"
    assert vm.base_url == "https://aws-us-west-2.arker.ai"


def test_region_routes_arkuntu_alias_to_burst_endpoint() -> None:
    t = FakeTransport()
    t.add_json(
        lambda method, url: method == "POST" and url == "https://aws-burst-us-west-2.arker.ai/api/v1/vms/arkuntu/fork",
        200,
        {"id": "legacy_child_without_suffix"},
    )

    with patch("urllib.request.urlopen", t):
        vm = region_client().vm("arkuntu").fork()

    assert vm.id == "legacy_child_without_suffix"
    assert vm.base_url == "https://aws-burst-us-west-2.arker.ai/api"


def test_region_routes_burst_vm_ids_to_burst_endpoint() -> None:
    t = FakeTransport()
    t.add_json(
        lambda method, url: method == "POST" and url == "https://aws-burst-us-west-2.arker.ai/api/v1/vms/01KR4AN62T47VXQ0A3AVSSWFTZ_uswe/run",
        200,
        {
            "stdout": "hi\n",
            "stdout_encoding": "utf-8",
            "stderr": "",
            "stderr_encoding": "utf-8",
            "exit_code": 0,
            "completed": True,
        },
    )

    with patch("urllib.request.urlopen", t):
        region_client().vm("01KR4AN62T47VXQ0A3AVSSWFTZ_uswe").run("printf hi")

    assert t.calls[0]["url"] == "https://aws-burst-us-west-2.arker.ai/api/v1/vms/01KR4AN62T47VXQ0A3AVSSWFTZ_uswe/run"


def test_list_uses_configured_base_url() -> None:
    t = FakeTransport()
    t.add_json(
        lambda method, url: method == "GET" and url == "https://test.invalid/api/v1/vms",
        200,
        {"vms": [{
            "vm_id": "vm_1",
            "owner_id": "owner",
            "created_at": "now",
            "state": "running",
            "sessions": [session()],
            "name": "demo",
        }]},
    )

    with patch("urllib.request.urlopen", t):
        result = client().list()

    assert isinstance(result, sdk.ListVmsResponse)
    assert len(result) == 1
    assert result.vms[0].vm_id == "vm_1"


def test_run_sends_command_without_default_session_id() -> None:
    t = FakeTransport()
    t.add_json(
        lambda method, url: method == "POST" and url.endswith("/v1/vms/vm_1/run"),
        200,
        {
            "stdout": "hi\n",
            "stdout_encoding": "utf-8",
            "stderr": "",
            "stderr_encoding": "utf-8",
            "exit_code": 0,
            "completed": True,
        },
    )

    with patch("urllib.request.urlopen", t):
        result = client().vm("vm_1").run("printf hi")

    assert isinstance(result, sdk.CompletedRunResult)
    assert result.stdout == b"hi\n"
    assert result.stderr == b""
    assert result.exit_code == 0
    assert json.loads(t.calls[0]["body"]) == {"command": "printf hi"}


def test_background_run_response() -> None:
    t = FakeTransport()
    t.add_json(
        lambda method, url: method == "POST" and url.endswith("/run"),
        200,
        {"run_id": "run_1", "completed": False, "tunnels": []},
    )

    with patch("urllib.request.urlopen", t):
        result = client().vm("vm_1").run("sleep 10", background=True)

    assert isinstance(result, sdk.BackgroundRunResult)
    assert result.run_id == "run_1"
    assert json.loads(t.calls[0]["body"]) == {"command": "sleep 10", "background": True}


def test_flat_error_response_becomes_arker_error() -> None:
    t = FakeTransport()
    t.add_json(lambda _method, _url: True, 404, {"code": "not_found", "message": "missing"})

    with patch("urllib.request.urlopen", t), pytest.raises(sdk.ArkerError) as caught:
        client().vm("missing").delete()

    assert caught.value.code == "not_found"
    assert caught.value.status == 404


def test_legacy_nested_error_response_still_parses() -> None:
    t = FakeTransport()
    t.add_json(lambda _method, _url: True, 404, {"ok": False, "error": {"code": "not_found", "message": "missing"}})

    with patch("urllib.request.urlopen", t), pytest.raises(sdk.ArkerError) as caught:
        client().vm("missing").delete()

    assert caught.value.code == "not_found"
    assert caught.value.status == 404


def test_nested_error_response_without_ok_still_parses() -> None:
    t = FakeTransport()
    t.add_json(lambda _method, _url: True, 503, {"error": {"code": "unavailable", "message": "try later"}})

    with patch("urllib.request.urlopen", t), pytest.raises(sdk.ArkerError) as caught:
        client().vm("missing").delete()

    assert caught.value.code == "unavailable"
    assert caught.value.status == 503


def test_retry_on_503_then_success(monkeypatch) -> None:
    monkeypatch.setattr(sdk.time, "sleep", lambda *_: None)
    t = FakeTransport()
    predicate = lambda method, url: method == "POST" and url.endswith("/sync")
    t.add_raw(predicate, 503, b"service unavailable")
    t.add_json(predicate, 200, {"ok": True, "op": "read", "path": "/home/user/x", "size": 2, "content": "ok", "encoding": "utf-8"})

    with patch("urllib.request.urlopen", t):
        assert sdk.Arker(api_key="k", base_url="https://test.invalid/api", retry={"attempts": 2}).vm("vm").sync.read_file("/home/user/x") == b"ok"

    assert len(t.calls) == 2


def test_read_inline_base64() -> None:
    payload = bytes(range(64))
    t = FakeTransport()
    t.add_json(
        lambda method, url: method == "POST" and url.endswith("/sync"),
        200,
        {
            "ok": True,
            "op": "read",
            "path": "/home/user/bin",
            "size": len(payload),
            "content": base64.b64encode(payload).decode(),
            "encoding": "base64",
        },
    )

    with patch("urllib.request.urlopen", t):
        assert client().vm("vm_1").sync.read_file("/home/user/bin") == payload


def test_read_presigned_follows_url() -> None:
    t = FakeTransport()
    t.add_json(
        lambda method, url: method == "POST" and url.endswith("/sync"),
        200,
        {"ok": True, "op": "read", "path": "/home/user/big", "size": 5, "presigned_url": "https://s3.invalid/file", "expires_in": 900, "method": "GET"},
    )
    t.add_raw(lambda method, url: method == "GET" and url == "https://s3.invalid/file", 200, b"hello")

    with patch("urllib.request.urlopen", t):
        assert client().vm("vm_1").sync.read_file("/home/user/big") == b"hello"


def test_small_write_uses_inline_chunk() -> None:
    t = FakeTransport()
    t.add_json(
        lambda method, url: method == "POST" and url.endswith("/sync"),
        200,
        {"ok": True, "op": "write", "results": [{
            "path": "/home/user/x",
            "size": 11,
            "received_bytes": 11,
            "ranges": [{"start": 0, "end": 11}],
            "complete": True,
            "written": True,
        }]},
    )

    with patch("urllib.request.urlopen", t):
        client().vm("vm_1").sync.write_file("/home/user/x", b"hello world")

    body = json.loads(t.calls[0]["body"])
    entry = body["writes"][0]
    assert body["op"] == "write"
    assert base64.b64decode(entry["content"]) == b"hello world"
    assert entry["start"] == 0
    assert entry["end"] == 11
    assert len(entry["upload_id"]) == 26


def test_large_write_uses_presigned_bypass() -> None:
    payload = b"A" * (sdk.CHUNK_SIZE + 1)
    t = FakeTransport()
    predicate = lambda method, url: method == "POST" and url.endswith("/sync")
    t.add_json(predicate, 200, {"ok": True, "op": "write", "results": [{
        "path": "/home/user/big",
        "size": len(payload),
        "presigned_url": "https://s3.invalid/upload",
        "upload_id": "upload_1",
        "expires_in": 900,
        "method": "PUT",
        "complete": False,
        "written": False,
    }]})
    t.add_raw(lambda method, url: method == "PUT" and url == "https://s3.invalid/upload", 200, b"")
    t.add_json(predicate, 200, {"ok": True, "op": "write", "results": [{
        "path": "/home/user/big",
        "size": len(payload),
        "complete": True,
        "written": True,
    }]})

    with patch("urllib.request.urlopen", t):
        client().vm("vm_1").sync.write_file("/home/user/big", payload)

    assert [call["method"] for call in t.calls] == ["POST", "PUT", "POST"]
    first_entry = json.loads(t.calls[0]["body"])["writes"][0]
    assert first_entry == {"path": "/home/user/big", "size": len(payload), "presigned": True}


def test_per_entry_internal_error_retries(monkeypatch) -> None:
    monkeypatch.setattr(sdk.time, "sleep", lambda *_: None)
    t = FakeTransport()
    transient = {
        "path": "/home/user/x",
        "size": 5,
        "complete": False,
        "written": False,
        "error": {"code": "internal", "message": "503 Service Unavailable SlowDown"},
    }
    predicate = lambda method, url: method == "POST" and url.endswith("/sync")
    t.add_json(predicate, 200, {"ok": True, "op": "write", "results": [transient]})
    t.add_json(predicate, 200, {"ok": True, "op": "write", "results": [{
        "path": "/home/user/x",
        "size": 5,
        "received_bytes": 5,
        "ranges": [{"start": 0, "end": 5}],
        "complete": True,
        "written": True,
    }]})

    with patch("urllib.request.urlopen", t):
        sdk.Arker(api_key="k", base_url="https://test.invalid/api", retry={"attempts": 2}).vm("vm").sync.write_file("/home/user/x", b"hello")

    assert len(t.calls) == 2
