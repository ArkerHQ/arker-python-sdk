from __future__ import annotations

import io
import json
import sys
import types
import urllib.error
from typing import Any
from unittest.mock import patch

import pytest

from arker.daytona import Daytona
from arker.e2b import Sandbox as E2BSandbox
from arker.modal import Sandbox as ModalSandbox


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


def vm_payload(vm_id: str) -> dict[str, Any]:
    return {
        "vm_id": vm_id,
        "owner_org_id": "owner",
        "created_at": "now",
        "public": False,
        "state": "idle",
        "sessions": [],
        "tunnels": [],
    }


def completed(stdout: str, stderr: str = "", exit_code: int = 0) -> dict[str, Any]:
    return {
        "stdout": stdout,
        "stdout_encoding": "utf-8",
        "stderr": stderr,
        "stderr_encoding": "utf-8",
        "exit_code": exit_code,
    }


def add_create_run_delete(t: FakeTransport, vm_id: str, stdout: str) -> None:
    t.add_json(lambda method, url: method == "POST" and url == "https://test.invalid/api/v1/fork", 200, vm_payload(vm_id))
    t.add_json(lambda method, url: method == "POST" and url == f"https://test.invalid/api/v1/vms/{vm_id}/runs", 200, completed(stdout))
    t.add_json(lambda method, url: method == "DELETE" and url == f"https://test.invalid/api/v1/vms/{vm_id}", 200, {"deleted": True})


def add_arker_not_found(t: FakeTransport, vm_id: str) -> None:
    t.add_json(
        lambda method, url: method == "GET" and url == f"https://test.invalid/api/v1/vms/{vm_id}",
        404,
        {"code": "not_found", "message": "not found"},
    )


def test_daytona_official_surface(monkeypatch) -> None:
    monkeypatch.setenv("ARKER_API_KEY", "ark_live_test")
    monkeypatch.setenv("ARKER_BASE_URL", "https://test.invalid/api")
    t = FakeTransport()
    add_create_run_delete(t, "vm_daytona", "Hello, World!\n")
    t.add_json(lambda method, url: method == "POST" and url == "https://test.invalid/api/v1/vms/vm_daytona/runs", 200, completed("Hello, World!\n"))

    with patch("urllib.request.urlopen", t):
        daytona = Daytona()
        sandbox = daytona.create()
        response = sandbox.process.exec("echo 'Hello, World!'")
        alias = sandbox.process.execute_command("echo 'Hello, World!'")
        assert response.result == "Hello, World!\n"
        assert alias.result == "Hello, World!\n"
        sandbox.delete()

    assert json.loads(t.calls[0]["body"])["source_vm_name"] == "ubuntu-full"


def test_arker_shim_config_customizes_source_without_forwarding_to_client(monkeypatch) -> None:
    monkeypatch.setenv("ARKER_API_KEY", "ark_live_test")
    monkeypatch.setenv("ARKER_BASE_URL", "https://test.invalid/api")
    t = FakeTransport()
    t.add_json(lambda method, url: method == "POST" and url == "https://test.invalid/api/v1/fork", 200, vm_payload("vm_custom"))

    with patch("urllib.request.urlopen", t):
        sandbox = Daytona(arker={"source": "custom-source", "name": "custom-name"}).create()

    body = json.loads(t.calls[0]["body"])
    assert sandbox.id == "vm_custom"
    assert body["source_vm_name"] == "custom-source"
    assert body["name"] == "custom-name"


def test_e2b_official_surface(monkeypatch) -> None:
    monkeypatch.setenv("ARKER_API_KEY", "ark_live_test")
    monkeypatch.setenv("ARKER_BASE_URL", "https://test.invalid/api")
    t = FakeTransport()
    add_create_run_delete(t, "vm_e2b", "Hello from E2B Sandbox!\n")

    with patch("urllib.request.urlopen", t):
        sandbox = E2BSandbox.create()
        result = sandbox.commands.run('echo "Hello from E2B Sandbox!"')
        assert result.stdout == "Hello from E2B Sandbox!\n"
        assert result.exit_code == 0
        sandbox.kill()


def test_modal_official_surface(monkeypatch) -> None:
    monkeypatch.setenv("ARKER_API_KEY", "ark_live_test")
    monkeypatch.setenv("ARKER_BASE_URL", "https://test.invalid/api")
    t = FakeTransport()
    add_create_run_delete(t, "vm_modal", "hello\n")

    with patch("urllib.request.urlopen", t):
        sandbox = ModalSandbox.create()
        process = sandbox.exec("echo", "hello")
        assert process.stdout.read() == "hello\n"
        assert process.wait() == 0
        sandbox.terminate()


def test_unsupported_calls_fail_fast(monkeypatch) -> None:
    monkeypatch.setenv("ARKER_API_KEY", "ark_live_test")
    monkeypatch.setenv("ARKER_BASE_URL", "https://test.invalid/api")
    t = FakeTransport()
    t.add_json(lambda method, url: method == "POST" and url == "https://test.invalid/api/v1/fork", 200, vm_payload("vm_unsupported"))

    with patch("urllib.request.urlopen", t):
        sandbox = E2BSandbox.create()
        with pytest.raises(AttributeError, match="not supported by the Arker compatibility layer for e2b"):
            sandbox.files.rename  # noqa: B018
        with pytest.raises(TypeError, match="only supports create"):
            ModalSandbox.create(image="alpine")


def test_daytona_get_falls_back_to_native_sdk(monkeypatch) -> None:
    monkeypatch.setenv("ARKER_API_KEY", "ark_live_test")
    monkeypatch.setenv("ARKER_BASE_URL", "https://test.invalid/api")

    class NativeProcess:
        def exec(self, command: str) -> Any:
            return types.SimpleNamespace(result=f"native:{command}")

    class NativeSandbox:
        id = "native_daytona"
        process = NativeProcess()

        def delete(self) -> None:
            self.deleted = True

    class NativeDaytona:
        def __init__(self, **kwargs: Any) -> None:
            self.kwargs = kwargs

        def get(self, sandbox_id: str) -> NativeSandbox:
            assert sandbox_id == "native_daytona"
            return NativeSandbox()

    monkeypatch.setitem(sys.modules, "daytona", types.SimpleNamespace(Daytona=NativeDaytona))
    t = FakeTransport()
    add_arker_not_found(t, "native_daytona")

    with patch("urllib.request.urlopen", t):
        sandbox = Daytona(api_key="native_key").get("native_daytona")
        assert sandbox.id == "native_daytona"
        assert sandbox.process.exec("echo native").result == "native:echo native"


def test_daytona_delete_by_id_falls_back_to_native_sdk(monkeypatch) -> None:
    monkeypatch.setenv("ARKER_API_KEY", "ark_live_test")
    monkeypatch.setenv("ARKER_BASE_URL", "https://test.invalid/api")
    deleted: list[str] = []

    class NativeDaytona:
        def delete(self, sandbox_id: str) -> None:
            deleted.append(sandbox_id)

    monkeypatch.setitem(sys.modules, "daytona", types.SimpleNamespace(Daytona=NativeDaytona))
    t = FakeTransport()
    add_arker_not_found(t, "native_daytona")

    with patch("urllib.request.urlopen", t):
        Daytona().delete("native_daytona")

    assert deleted == ["native_daytona"]


def test_e2b_connect_falls_back_to_native_sdk(monkeypatch) -> None:
    monkeypatch.setenv("ARKER_API_KEY", "ark_live_test")
    monkeypatch.setenv("ARKER_BASE_URL", "https://test.invalid/api")

    class NativeCommands:
        def run(self, command: str) -> Any:
            return types.SimpleNamespace(stdout=f"native:{command}")

    class NativeSandbox:
        sandbox_id = "native_e2b"
        commands = NativeCommands()

        @classmethod
        def connect(cls, sandbox_id: str) -> "NativeSandbox":
            assert sandbox_id == "native_e2b"
            return cls()

    monkeypatch.setitem(sys.modules, "e2b", types.SimpleNamespace(Sandbox=NativeSandbox))
    t = FakeTransport()
    add_arker_not_found(t, "native_e2b")

    with patch("urllib.request.urlopen", t):
        sandbox = E2BSandbox.connect("native_e2b")
        assert sandbox.sandbox_id == "native_e2b"
        assert sandbox.commands.run("echo native").stdout == "native:echo native"


def test_modal_from_id_falls_back_to_native_sdk(monkeypatch) -> None:
    monkeypatch.setenv("ARKER_API_KEY", "ark_live_test")
    monkeypatch.setenv("ARKER_BASE_URL", "https://test.invalid/api")

    class NativeProcess:
        stdout = types.SimpleNamespace(read=lambda: "native stdout")
        stderr = types.SimpleNamespace(read=lambda: "")

        def wait(self) -> int:
            return 0

    class NativeSandbox:
        sandbox_id = "native_modal"

        @classmethod
        def from_id(cls, sandbox_id: str) -> "NativeSandbox":
            assert sandbox_id == "native_modal"
            return cls()

        def exec(self, *command: Any) -> NativeProcess:
            assert command == ("echo", "native")
            return NativeProcess()

    monkeypatch.setitem(sys.modules, "modal", types.SimpleNamespace(Sandbox=NativeSandbox))
    t = FakeTransport()
    add_arker_not_found(t, "native_modal")

    with patch("urllib.request.urlopen", t):
        sandbox = ModalSandbox.from_id("native_modal")
        process = sandbox.exec("echo", "native")
        assert sandbox.sandbox_id == "native_modal"
        assert process.stdout.read() == "native stdout"
        assert process.wait() == 0
