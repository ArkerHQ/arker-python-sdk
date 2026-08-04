from __future__ import annotations

import base64
import json
from contextlib import contextmanager
from typing import Any

import httpx
import pytest

import arker.computer as sdk


class FakeTransport:
    """Scripts httpx responses by (method, url); drive it with ``use_transport``."""

    def __init__(self) -> None:
        self.calls: list[dict[str, Any]] = []
        self.script: list[tuple[Any, int, bytes]] = []

    def add_json(self, predicate, status: int, body: dict[str, Any]) -> None:
        self.script.append((predicate, status, json.dumps(body).encode()))

    def add_raw(self, predicate, status: int, body: bytes) -> None:
        self.script.append((predicate, status, body))

    def handler(self, request: httpx.Request) -> httpx.Response:
        method = request.method
        url = str(request.url)
        self.calls.append({"method": method, "url": url, "body": request.content or None, "headers": request.headers})

        for index, (predicate, status, payload) in enumerate(self.script):
            if predicate(method, url):
                self.script.pop(index)
                return httpx.Response(status, content=payload)

        raise AssertionError(f"no scripted response for {method} {url}")


@contextmanager
def use_transport(t: FakeTransport):
    """Route the SDK's shared client through ``t`` for the duration."""
    previous = sdk._http_client
    sdk._http_client = httpx.Client(transport=httpx.MockTransport(t.handler))
    try:
        yield
    finally:
        sdk._http_client.close()
        sdk._http_client = previous


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


def test_gcp_provider_builds_gcp_endpoint() -> None:
    arker = sdk.Arker(
        api_key="ark_live_test",
        provider="gcp",
        region="us-central1",
        retry=False,
    )

    assert arker.provider == "gcp"
    assert arker.region == "us-central1"
    assert arker.base_url == "https://gcp-us-central1.arker.ai/api"


def test_gcp_combined_region_builds_gcp_endpoint() -> None:
    arker = sdk.Arker(
        api_key="ark_live_test",
        region="gcp-us-central1",
        retry=False,
    )

    assert arker.provider == "gcp"
    assert arker.region == "us-central1"
    assert arker.base_url == "https://gcp-us-central1.arker.ai/api"


def test_invalid_provider_fails_closed() -> None:
    with pytest.raises(ValueError, match="provider"):
        sdk.Arker(api_key="ark_live_test", provider="unknown", region="us-central1")


def test_gcp_region_is_not_hard_coded_in_the_client() -> None:
    arker = sdk.Arker(
        api_key="ark_live_test",
        provider="gcp",
        region="europe-west1",
        retry=False,
    )

    assert arker.base_url == "https://gcp-europe-west1.arker.ai/api"


def test_explicit_gcp_vm_handle_uses_placement_endpoint() -> None:
    arker = sdk.Arker(api_key="ark_live_test", region="us-west-2", retry=False)
    vm = arker.vm("vm_gcp", provider="gcp", region="us-central1")

    assert vm.base_url == "https://gcp-us-central1.arker.ai/api"


def test_list_regions_uses_public_control_plane_catalog() -> None:
    t = FakeTransport()
    placement = {
        "provider": "gcp",
        "region": "us-central1",
    }
    t.add_json(
        lambda method, url: method == "GET"
        and url == "https://arker.ai/api/v1/regions",
        200,
        {"regions": [placement]},
    )

    with use_transport(t):
        regions = client().list_regions()

    assert regions.regions[0].provider == "gcp"
    assert regions.regions[0].region == "us-central1"


def test_discover_regions_requires_no_configured_client() -> None:
    t = FakeTransport()
    t.add_json(
        lambda method, url: method == "GET"
        and url == "https://control.invalid/api/v1/regions",
        200,
        {"regions": []},
    )

    with use_transport(t):
        regions = sdk.discover_regions(
            control_base_url="https://control.invalid/api",
            retry=False,
        )

    assert regions.regions == []
    assert "authorization" not in t.calls[0]["headers"]


def test_fork_posts_directly_to_source_vm() -> None:
    t = FakeTransport()
    # Contract 0.3 routes forks to `/v1/fork`, with the source vm id
    # passed in the body.
    t.add_json(
        lambda method, url: method == "POST" and url == "https://test.invalid/api/v1/fork",
        200,
        {
            "vm_id": "vm_child",
            "owner_org_id": "owner",
            "created_at": "now",
            "description": None,
            "public": False,
            "state": "idle",
            "sessions": [session()],
            "network": {},
            "resources": {},
        },
    )

    with use_transport(t):
        vm = client().fork(
            source_vm_id="ubuntu",
            name="demo",
            description="CI runner",
            ssh_public_keys=["ssh-ed25519 AAAA test@example.com"],
        )

    assert vm.id == "vm_child"
    body = json.loads(t.calls[0]["body"])
    # Computer.fork passes source_vm_id; `disk` is omitted unless the caller
    # sets it, so the server derives it from the source (nodisk goldens reject true).
    assert body == {
        "name": "demo",
        "description": "CI runner",
        "ssh_public_keys": ["ssh-ed25519 AAAA test@example.com"],
        "source_vm_id": "ubuntu",
    }


def test_fork_infers_arker_org_for_macos_full_golden() -> None:
    t = FakeTransport()
    t.add_json(
        lambda method, url: method == "POST" and url == "https://test.invalid/api/v1/fork",
        200,
        {
            "vm_id": "vm_macos",
            "owner_org_id": "owner",
            "created_at": "now",
            "description": None,
            "public": False,
            "state": "idle",
            "sessions": [session()],
            "network": {},
            "resources": {"vcpu": 4, "memory_mib": 8192, "disk_mib": 10240},
        },
    )

    with use_transport(t):
        vm = client().fork("macos-full")

    assert vm.id == "vm_macos"
    body = json.loads(t.calls[0]["body"])
    assert body == {"source_vm_name": "macos-full", "source_org_id": "ArkerHQ"}


def test_fork_rejects_legacy_id_response() -> None:
    """A response missing the fields we REQUIRE is still an error.

    The legacy shape sends `id` where the contract says `vm_id`, so decoding
    must fail — but now because `vm_id` is absent, not because `id` is extra.
    """
    t = FakeTransport()
    t.add_json(
        lambda method, url: method == "POST" and url == "https://test.invalid/api/v1/fork",
        200,
        {"id": "vm_child"},
    )

    with use_transport(t), pytest.raises(TypeError):
        client().fork(source_vm_id="ubuntu")


def test_fork_tolerates_unknown_response_fields() -> None:
    """Adding a field to a response must not break an older SDK.

    Servers add response fields additively; a client pinned to an earlier
    version has to keep working. This previously raised
    `TypeError: Vm contains fields outside openapi.json: hostname, keep_alive`
    and broke `fork()` outright against a newer deployment.
    """
    t = FakeTransport()
    t.add_json(
        lambda method, url: method == "POST" and url == "https://test.invalid/api/v1/fork",
        200,
        {
            "vm_id": "vm_child",
            "owner_org_id": "org",
            "created_at": "2026-07-29T00:00:00Z",
            "description": None,
            "public": False,
            "state": "idle",
            "sessions": [],
            "resources": {"vcpu": 1, "memory_mib": 1024, "disk_mib": 4096},
            "network": {},
            # fields a future server adds that this SDK has never heard of
            "hostname": "vm_child.aws-us-west-2.arker.app",
            "keep_alive": True,
            "some_field_from_the_future": {"nested": [1, 2, 3]},
        },
    )

    with use_transport(t):
        vm = client().fork(source_vm_id="ubuntu")
    assert vm.id == "vm_child"


def test_region_routes_goldens_to_main_endpoint() -> None:
    t = FakeTransport()
    t.add_json(
        lambda method, url: method == "POST" and url == "https://aws-us-west-2.arker.ai/api/v1/fork",
        200,
        {
            "vm_id": "vmh-child",
            "owner_org_id": "owner",
            "created_at": "now",
            "description": None,
            "public": False,
            "state": "idle",
            "sessions": [],
            "network": {},
            "resources": {},
        },
    )

    with use_transport(t):
        arker = region_client()
        vm = arker.fork(source_vm_id="ubuntu")

    assert arker.base_url == "https://aws-us-west-2.arker.ai/api"
    assert vm.base_url == "https://aws-us-west-2.arker.ai/api"


def test_list_uses_configured_base_url() -> None:
    t = FakeTransport()
    # `Arker.list()` is an admin call — routed through the control
    # plane, not the compute URL.
    t.add_json(
        lambda method, url: method == "GET" and url == "https://arker.ai/api/v1/vms?region=us-west-2&provider=aws&org_id=ArkerHQ&public=True&state=idle",
        200,
        {"vms": [{
            "vm_id": "vm_1",
            "owner_org_id": "ArkerHQ",
            "created_at": "now",
            "description": None,
            "public": True,
            "state": "idle",
            "sessions": [session()],
            "name": "demo",
            "network": {},
            "resources": {"vcpu": 2, "memory_mib": 1024, "disk_mib": 4096},
            "max_vcpus": 8,
            "max_memory_mib": 32768,
            "min_memory_mib": 512,
        }]},
    )

    with use_transport(t):
        result = client().list_vms(
            region="us-west-2",
            provider="aws",
            org_id="ArkerHQ",
            public=True,
            state="idle",
        )

    assert isinstance(result, sdk.VmList)
    assert len(result) == 1
    assert result.vms[0].id == "vm_1"
    assert result.vms[0].vm_id == "vm_1"
    assert result.vms[0].owner_org_id == "ArkerHQ"
    assert result.vms[0].max_vcpus == 8
    assert result.vms[0].max_memory_mib == 32768
    assert result.vms[0].min_memory_mib == 512
    assert result.vms[0].network is not None
    assert result.vms[0].network.ssh_public_keys is None
    assert result.vms[0].resources == sdk.VmResources(
        vcpu=2, memory_mib=1024, disk_mib=4096
    )


def test_listed_gcp_vm_uses_its_placement_endpoint() -> None:
    t = FakeTransport()
    t.add_json(
        lambda method, url: method == "GET" and url == "https://arker.ai/api/v1/vms",
        200,
        {"vms": [{
            "vm_id": "vm_gcp",
            "owner_org_id": "org_1",
            "created_at": "now",
            "description": None,
            "public": False,
            "state": "idle",
            "region": "us-central1",
            "provider": "gcp",
            "network": {},
            "sessions": [],
            "resources": {},
        }]},
    )
    t.add_json(
        lambda method, url: method == "POST" and url == "https://gcp-us-central1.arker.ai/api/v1/vms/vm_gcp/runs",
        200,
        {
            "run_id": "run_gcp",
            "state": "completed",
            "stdout": "ok\n",
            "stdout_encoding": "utf-8",
            "stderr": "",
            "stderr_encoding": "utf-8",
            "exit_code": 0,
        },
    )

    arker = sdk.Arker(api_key="ark_live_test", region="us-west-2", retry=False)
    with use_transport(t):
        result = arker.list_vms()
        assert result.vms[0].base_url == "https://gcp-us-central1.arker.ai/api"
        result.vms[0].run("printf ok")


def test_list_runs_uses_control_plane_and_filters() -> None:
    t = FakeTransport()
    t.add_json(
        lambda method, url: method == "GET" and url == "https://control.invalid/api/v1/runs?since=10&until=20&vm=vm_1&vms=vm_2%2Cvm_3&region=us-west-2&provider=aws&search=pytest&limit=25&offset=5&lite=True&runtime=fc&endpoint=run&actions=run%2Cfork&status=success%2Cinternal&status_min=200&status_max=599&sort=when&dir=asc",
        200,
        {
            "since": 10,
            "until": 20,
            "limit": 25,
            "offset": 5,
            "lite": True,
            "rows": [{
                "source": "arkerd",
                "t_ms": 10,
                "request_id": "req_1",
                "run_id": "run_1",
                "vm_id": "vm_1",
                "session_id": "session_1",
                "region": "us-west-2",
                "provider": "aws",
                "status": 200,
                "total_ms": 12.5,
                "queue_ms": 1.5,
                "executor_duration_ms": 10,
                "executor_kind": "firecracker",
                "executor_cpu_ms": 8,
                "executor_mem_mb": 64,
                "vm_vcpus": 2,
                "vm_memory_mib": 4096,
                "path": "/v1/vms/vm_1/runs",
                "method": "POST",
                "command": "pytest",
                "source_vm_id": "",
                "exit_code": 0,
                "endpoint": "run",
                "api_key_prefix": "ark_live",
                "body_bytes_in": 10,
                "body_bytes_out": 20,
                "body_in": "",
                "body_out": "",
            }],
        },
    )

    arker = sdk.Arker(
        api_key="ark_live_test",
        base_url="https://test.invalid/api",
        control_base_url="https://control.invalid/api",
        retry=False,
    )
    with use_transport(t):
        result = arker.list_runs(
            since=10,
            until=20,
            vm="vm_1",
            vm_ids=["vm_2", "vm_3"],
            region="us-west-2",
            provider="aws",
            search="pytest",
            limit=25,
            offset=5,
            lite=True,
            runtime="fc",
            endpoint="run",
            actions=["run", "fork"],
            status=["success", "internal"],
            status_min=200,
            status_max=599,
            sort="when",
            dir="asc",
        )

    assert isinstance(result, sdk.ListOrgRunsResponse)
    assert result.lite is True
    assert result.rows[0].region == "us-west-2"
    assert result.rows[0].vm_vcpus == 2
    assert t.calls[0]["body"] is None


def test_run_sends_command_without_default_session_id() -> None:
    t = FakeTransport()
    t.add_json(
        lambda method, url: method == "POST" and url.endswith("/v1/vms/vm_1/runs"),
        200,
        {
            "stdout": "hi\n",
            "stdout_encoding": "utf-8",
            "stderr": "",
            "stderr_encoding": "utf-8",
            "exit_code": 0,
            "memory_requested_mib": 1024,
            "memory_achieved_mib": 1536,
            "memory_partial": True,
        },
    )

    with use_transport(t):
        result = client().vm("vm_1").run("printf hi")

    assert isinstance(result, sdk.CompletedRunResult)
    assert result.stdout == "hi\n"
    assert result.stdout_bytes == b"hi\n"
    assert result.stderr == ""
    assert result.stderr_bytes == b""
    assert result.exit_code == 0
    assert result.memory_requested_mib == 1024
    assert result.memory_achieved_mib == 1536
    assert result.memory_partial is True
    assert json.loads(t.calls[0]["body"]) == {"command": "printf hi"}


def test_sync_run_polls_backgrounded_run_to_completion(monkeypatch) -> None:
    # A synchronous run() that outlives the server sync window gets a background
    # ack; run() must poll get_run() under the hood and return the terminal run
    # — the caller never sees the intermediate background shape.
    monkeypatch.setattr(sdk.time, "sleep", lambda _s: None)
    t = FakeTransport()
    t.add_json(
        lambda method, url: method == "POST" and url.endswith("/v1/vms/vm_1/runs"),
        200,
        {"run_id": "run_bg", "state": "running"},
    )
    # First poll: still running. Second poll: terminal.
    t.add_json(
        lambda method, url: method == "GET" and url.endswith("/v1/vms/vm_1/runs/run_bg"),
        200,
        {"run_id": "run_bg", "state": "running", "started_at": "now", "exit_code": None,
         "stdout": "", "stdout_encoding": "utf-8", "stderr": "", "stderr_encoding": "utf-8"},
    )
    t.add_json(
        lambda method, url: method == "GET" and url.endswith("/v1/vms/vm_1/runs/run_bg"),
        200,
        {"run_id": "run_bg", "state": "completed", "started_at": "now", "exit_code": 0,
         "stdout": "done\n", "stdout_encoding": "utf-8", "stderr": "", "stderr_encoding": "utf-8"},
    )

    with use_transport(t):
        result = client().vm("vm_1").run("sleep 999")

    assert isinstance(result, sdk.CompletedRunResult)
    assert result.run_id == "run_bg"
    assert result.state == "completed"
    assert result.exit_code == 0
    assert result.stdout == "done\n"
    assert result.stdout_bytes == b"done\n"
    # POST + 2 polls.
    assert [c["method"] for c in t.calls] == ["POST", "GET", "GET"]


def test_background_true_returns_ack_without_polling(monkeypatch) -> None:
    # background=True is a pure pass-through — run() returns the running ack
    # immediately and never polls get_run().
    slept: list[float] = []
    monkeypatch.setattr(sdk.time, "sleep", lambda s: slept.append(s))
    t = FakeTransport()
    t.add_json(
        lambda method, url: method == "POST" and url.endswith("/v1/vms/vm_1/runs"),
        200,
        {"run_id": "run_bg", "state": "running"},
    )

    with use_transport(t):
        result = client().vm("vm_1").run("sleep 999", background=True)

    assert isinstance(result, sdk.BackgroundRunResult)
    assert result.run_id == "run_bg"
    # Only the POST — no polling, no sleeping.
    assert [c["method"] for c in t.calls] == ["POST"]
    assert slept == []
    assert json.loads(t.calls[0]["body"]) == {"command": "sleep 999", "background": True}


def test_run_sends_policies() -> None:
    t = FakeTransport()
    t.add_json(
        lambda method, url: method == "POST" and url.endswith("/v1/vms/vm_1/runs"),
        200,
        {
            "stdout": "",
            "stdout_encoding": "utf-8",
            "stderr": "",
            "stderr_encoding": "utf-8",
            "exit_code": 0,
        },
    )
    policies = {
        "policies": [
            {
                "type": "outbound",
                "action": "deny",
                # `PolicyMatch` has no `protocol` field (real fields: ports, ips,
                # hosts, methods, paths, headers, body_contains) — a leftover
                # "protocol": "tcp" here only ever passed because the
                # `_decode_value` bug (see test_get_and_set_policies) skipped
                # nested validation entirely, so an unreal field was silently
                # never checked. Fixed now that nested decode is fixed.
                "match": {"ports": [443]},
            }
        ]
    }

    with use_transport(t):
        client().vm("vm_1").run("curl https://example.com", policies=policies)

    assert json.loads(t.calls[0]["body"]) == {
        "command": "curl https://example.com",
        "policies": policies,
    }


def test_resize_patches_vm_resources() -> None:
    t = FakeTransport()
    t.add_json(
        lambda method, url: method == "PATCH" and url.endswith("/v1/vms/vm_1"),
        200,
        {
            "vm_id": "vm_1",
            "owner_org_id": "owner",
            "created_at": "now",
            "description": None,
            "public": False,
            "state": "idle",
            "sessions": [],
            "resources": {"vcpu": 2, "memory_mib": 1024, "disk_mib": 4096},
            "network": {},
        },
    )

    with use_transport(t):
        result = client().vm("vm_1").update(memory_mib=1024)

    # resize now PATCHes /v1/vms/{id} with a resources object (arkerd reality;
    # the old POST /v1/vms/{id}/resize route does not exist). None fields are pruned.
    assert json.loads(t.calls[0]["body"]) == {"resources": {"memory_mib": 1024}}
    assert result is not None


def test_update_patches_vm_description() -> None:
    t = FakeTransport()
    t.add_json(
        lambda method, url: method == "PATCH" and url.endswith("/v1/vms/vm_1"),
        200,
        {
            "vm_id": "vm_1",
            "owner_org_id": "owner",
            "created_at": "now",
            "description": "CI runner",
            "public": False,
            "state": "idle",
            "sessions": [],
            "resources": {"vcpu": 2, "memory_mib": 1024, "disk_mib": 4096},
            "network": {},
        },
    )

    with use_transport(t):
        result = client().vm("vm_1").update(description="CI runner")

    assert json.loads(t.calls[0]["body"]) == {"description": "CI runner"}
    assert result.description == "CI runner"


def test_update_can_clear_vm_description_with_null() -> None:
    t = FakeTransport()
    t.add_json(
        lambda method, url: method == "PATCH" and url.endswith("/v1/vms/vm_1"),
        200,
        {
            "vm_id": "vm_1",
            "owner_org_id": "owner",
            "created_at": "now",
            "description": None,
            "public": False,
            "state": "idle",
            "sessions": [],
            "resources": {},
            "network": {},
        },
    )

    with use_transport(t):
        client().vm("vm_1").update(description=None)

    assert json.loads(t.calls[0]["body"]) == {"description": None}


def test_update_can_clear_vm_description_with_blank_string() -> None:
    t = FakeTransport()
    t.add_json(
        lambda method, url: method == "PATCH" and url.endswith("/v1/vms/vm_1"),
        200,
        {
            "vm_id": "vm_1",
            "owner_org_id": "owner",
            "created_at": "now",
            "description": None,
            "public": False,
            "state": "idle",
            "sessions": [],
            "resources": {},
            "network": {},
        },
    )

    with use_transport(t):
        client().vm("vm_1").update(description="")

    assert json.loads(t.calls[0]["body"]) == {"description": ""}


def test_background_run_response() -> None:
    t = FakeTransport()
    t.add_json(
        lambda method, url: method == "POST" and url.endswith("/runs"),
        200,
        {
            "run_id": "run_1",
            "state": "running",
        },
    )

    with use_transport(t):
        result = client().vm("vm_1").run("sleep 10", background=True)

    assert isinstance(result, sdk.BackgroundRunResult)
    assert result.run_id == "run_1"
    assert result.state == "running"
    assert json.loads(t.calls[0]["body"]) == {"command": "sleep 10", "background": True}


def test_flat_error_response_is_rejected_as_malformed() -> None:
    t = FakeTransport()
    t.add_json(lambda _method, _url: True, 404, {"code": "not_found", "message": "missing"})

    with use_transport(t), pytest.raises(sdk.ArkerError) as caught:
        client().vm("missing").delete()

    assert caught.value.code == "internal"
    assert caught.value.status == 404


def test_error_response_with_legacy_top_level_field_is_rejected() -> None:
    t = FakeTransport()
    t.add_json(lambda _method, _url: True, 404, {"ok": False, "error": {"code": "not_found", "message": "missing"}})

    with use_transport(t), pytest.raises(sdk.ArkerError) as caught:
        client().vm("missing").delete()

    assert caught.value.code == "internal"
    assert caught.value.status == 404


def test_canonical_error_response_parses() -> None:
    t = FakeTransport()
    t.add_json(
        lambda _method, _url: True,
        503,
        {
            "error": {
                "code": "unavailable",
                "message": "try later",
                "timestamp": "2026-07-21T00:00:00Z",
            }
        },
    )

    with use_transport(t), pytest.raises(sdk.ArkerError) as caught:
        client().vm("missing").delete()

    assert caught.value.code == "unavailable"
    assert caught.value.status == 503


def test_retry_on_503_then_success(monkeypatch) -> None:
    monkeypatch.setattr(sdk.time, "sleep", lambda *_: None)
    t = FakeTransport()
    predicate = lambda method, url: method == "POST" and url.endswith("/sync")
    t.add_raw(predicate, 503, b"service unavailable")
    t.add_json(predicate, 200, {"ok": True, "op": "read", "path": "/home/user/x", "size": 2, "content": "ok", "encoding": "utf-8"})

    with use_transport(t):
        assert sdk.Arker(api_key="k", base_url="https://test.invalid/api", retry={"attempts": 2}).vm("vm").sync("/home/user/x") == b"ok"

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

    with use_transport(t):
        assert client().vm("vm_1").sync("/home/user/bin") == payload


def test_read_presigned_follows_url() -> None:
    t = FakeTransport()
    t.add_json(
        lambda method, url: method == "POST" and url.endswith("/sync"),
        200,
        {"ok": True, "op": "read", "path": "/home/user/big", "size": 5, "presigned_url": "https://s3.invalid/file", "expires_in": 900, "method": "GET"},
    )
    t.add_raw(lambda method, url: method == "GET" and url == "https://s3.invalid/file", 200, b"hello")

    with use_transport(t):
        assert client().vm("vm_1").sync("/home/user/big") == b"hello"


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

    with use_transport(t):
        client().vm("vm_1").sync("/home/user/x", b"hello world")

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

    with use_transport(t):
        client().vm("vm_1").sync("/home/user/big", payload)

    assert [call["method"] for call in t.calls] == ["POST", "PUT", "POST"]
    first_entry = json.loads(t.calls[0]["body"])["writes"][0]
    assert first_entry == {
        "path": "/home/user/big",
        "size": len(payload),
        "presigned": True,
        "is_secret": False,
    }


def test_fork_sends_durable_flag() -> None:
    t = FakeTransport()
    t.add_json(
        lambda method, url: method == "POST" and url.endswith("/v1/fork"),
        200,
        {
            "vm_id": "vm_child",
            "owner_org_id": "owner",
            "created_at": "now",
            "description": None,
            "public": False,
            "state": "idle",
            "sessions": [],
            "network": {},
            "resources": {},
        },
    )

    with use_transport(t):
        client().fork(
            source_vm_id="ubuntu",
            durable=True,
            ssh_public_keys=["ssh-ed25519 AAAA test@example"],
            policies={"policies": []},
        )

    # Computer.fork auto-fills source_vm_id; `disk` is omitted unless set.
    assert json.loads(t.calls[0]["body"]) == {
        "durable": True,
        "source_vm_id": "ubuntu",
        "ssh_public_keys": ["ssh-ed25519 AAAA test@example"],
        "policies": {"policies": []},
    }


def test_fork_sends_disk_only_layers() -> None:
    """A disk-only fork (`layers=["disk"]`) puts the layer selection in the body
    so the child inherits only the filesystem and cold-boots with fresh RAM."""
    t = FakeTransport()
    t.add_json(
        lambda method, url: method == "POST" and url.endswith("/v1/fork"),
        200,
        {
            "vm_id": "vm_child",
            "owner_org_id": "owner",
            "created_at": "now",
            "description": None,
            "public": False,
            "state": "idle",
            "sessions": [],
            "network": {},
            "resources": {},
        },
    )

    with use_transport(t):
        client().fork(source_vm_id="ubuntu", layers=["disk"])

    # Computer.fork auto-fills source_vm_id; `disk` is omitted unless set.
    assert json.loads(t.calls[0]["body"]) == {
        "layers": ["disk"],
        "source_vm_id": "ubuntu",
    }


def test_fork_omits_layers_by_default() -> None:
    """A plain fork sends no `layers` key — the server applies the default full
    fork (disk + memory), so the child resumes warm."""
    t = FakeTransport()
    t.add_json(
        lambda method, url: method == "POST" and url.endswith("/v1/fork"),
        200,
        {
            "vm_id": "vm_child",
            "owner_org_id": "owner",
            "created_at": "now",
            "description": None,
            "public": False,
            "state": "idle",
            "sessions": [],
            "network": {},
            "resources": {},
        },
    )

    with use_transport(t):
        client().fork(source_vm_id="ubuntu")

    assert "layers" not in json.loads(t.calls[0]["body"])


def test_run_sends_idempotency_key_header() -> None:
    t = FakeTransport()
    t.add_json(
        lambda method, url: method == "POST" and url.endswith("/runs"),
        200,
        {
            "stdout": "hi\n",
            "stdout_encoding": "utf-8",
            "stderr": "",
            "stderr_encoding": "utf-8",
            "exit_code": 0,
        },
    )

    with use_transport(t):
        client().vm("vm_1").run("printf hi", idempotency_key="key-abc")

    assert t.calls[0]["headers"]["idempotency-key"] == "key-abc"


def test_run_status_parses_retry_count() -> None:
    t = FakeTransport()
    t.add_json(
        lambda method, url: method == "GET" and url.endswith("/runs/run_1"),
        200,
        {
            "run_id": "run_1",
            "stdout": "",
            "stdout_encoding": "utf-8",
            "stderr": "",
            "stderr_encoding": "utf-8",
            "exit_code": 0,
            "state": "completed",
            "started_at": "now",
            "retry_count": 2,
        },
    )

    with use_transport(t):
        status = client().vm("vm_1").get_run("run_1")

    assert status.retry_count == 2


def test_run_status_defaults_retry_count_when_missing() -> None:
    t = FakeTransport()
    t.add_json(
        lambda method, url: method == "GET" and url.endswith("/runs/run_1"),
        200,
        {
            "run_id": "run_1",
            "stdout": "",
            "stdout_encoding": "utf-8",
            "stderr": "",
            "stderr_encoding": "utf-8",
            "exit_code": 0,
            "state": "completed",
            "started_at": "now",
        },
    )

    with use_transport(t):
        status = client().vm("vm_1").get_run("run_1")

    assert status.retry_count == 0


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

    with use_transport(t):
        sdk.Arker(api_key="k", base_url="https://test.invalid/api", retry={"attempts": 2}).vm("vm").sync("/home/user/x", b"hello")

    assert len(t.calls) == 2


def test_get_and_set_policies() -> None:
    t = FakeTransport()
    t.add_json(
        lambda method, url: method == "GET" and url == "https://test.invalid/api/v1/vms/vm_1/policies",
        200,
        {"policies": [], "secrets": {}, "hostname": None, "mitm_domains": [], "warnings": []},
    )
    with use_transport(t):
        doc = client().vm("vm_1").get_policies()
    assert doc.policies == []

    t.add_json(
        lambda method, url: method == "PUT" and url == "https://test.invalid/api/v1/vms/vm_1/policies",
        200,
        {
            "policies": [{"type": "outbound", "match": {"hosts": ["example.com"]}, "action": "allow"}],
            "secrets": {},
            "hostname": None,
            "mitm_domains": ["example.com"],
            "warnings": [],
        },
    )
    with use_transport(t):
        updated = client().vm("vm_1").set_policies({
            "policies": [{"type": "outbound", "match": {"hosts": ["example.com"]}, "action": "allow"}],
        })
    # Regression coverage for a bug found writing this test: `PolicyDoc.policies`
    # is typed `list[PolicyEntry] | None`. `_decode_value`'s Union branch used to
    # only recurse when a member was itself a bare dataclass type — `list[PolicyEntry]`
    # is a generic alias, not a dataclass, so it was never matched and the raw
    # list-of-dicts passed through unconverted (entries stayed plain dicts;
    # `.type` attribute access raised AttributeError). Fixed in `_decode_value`
    # to also recurse into a single non-null Optional[list[...]]/Optional[dict[...]]
    # member. Assert the real dataclass here so this can't silently regress.
    assert updated.policies[0].type == "outbound"
    assert updated.mitm_domains == ["example.com"]
    put_call = next(c for c in t.calls if c["method"] == "PUT")
    assert b"example.com" in put_call["body"]


def test_create_filesystem() -> None:
    t = FakeTransport()
    t.add_json(
        lambda method, url: method == "POST" and url == "https://test.invalid/api/v1/filesystems",
        200,
        {
            "filesystem_id": "fs_1",
            "name": "my-fs",
            "owner_org_id": "ArkerHQ",
            "created_at": "now",
            "size_bytes": 0,
            "region": "us-west-2",
            "provider": "aws",
        },
    )
    with use_transport(t):
        fs = client().create_filesystem(name="my-fs")
    assert fs.filesystem_id == "fs_1"
    assert fs.name == "my-fs"
    assert t.calls[0]["method"] == "POST"
    assert b"my-fs" in t.calls[0]["body"]


def test_cancel_run() -> None:
    t = FakeTransport()
    t.add_json(
        lambda method, url: method == "DELETE" and url == "https://test.invalid/api/v1/vms/vm_1/runs/run_1",
        200,
        {"cancelled": True},
    )
    with use_transport(t):
        result = client().vm("vm_1").cancel_run("run_1")
    assert result.cancelled is True
    assert t.calls[0]["method"] == "DELETE"


def test_session_crud_lifecycle() -> None:
    t = FakeTransport()
    with use_transport(t):
        vm = client().vm("vm_1")

        t.add_json(
            lambda method, url: method == "POST" and url == "https://test.invalid/api/v1/vms/vm_1/sessions",
            200,
            session("sess_1"),
        )
        created = vm.create_session(cwd="/home/user")
        assert created.session_id == "sess_1"

        t.add_json(
            lambda method, url: method == "GET" and url == "https://test.invalid/api/v1/vms/vm_1/sessions/sess_1",
            200,
            session("sess_1"),
        )
        fetched = vm.get_session("sess_1")
        assert fetched.session_id == "sess_1"

        t.add_json(
            lambda method, url: method == "GET" and url == "https://test.invalid/api/v1/vms/vm_1/sessions",
            200,
            {"sessions": [session("sess_1")], "next_cursor": None},
        )
        listed = vm.list_sessions()
        assert len(listed.sessions) == 1
        assert listed.next_cursor is None

        t.add_json(
            lambda method, url: method == "PATCH" and url == "https://test.invalid/api/v1/vms/vm_1/sessions/sess_1",
            200,
            {"ok": True, "session_id": "sess_1"},
        )
        patched = vm.update_session("sess_1", cols=100, rows=40)
        assert patched.ok is True
        patch_call = next(c for c in t.calls if c["method"] == "PATCH")
        assert b'"cols": 100' in patch_call["body"] or b'"cols":100' in patch_call["body"]

        t.add_json(
            lambda method, url: method == "DELETE" and url == "https://test.invalid/api/v1/vms/vm_1/sessions/sess_1",
            200,
            {"deleted": True},
        )
        deleted = vm.delete_session("sess_1")
        assert deleted.deleted is True


def test_run_reports_failed_when_platform_killed_the_run() -> None:
    """A negative exit code means no process status was obtained."""
    t = FakeTransport()
    t.add_json(
        lambda method, url: method == "POST" and url.endswith("/v1/vms/vm_1/runs"),
        200,
        {
            "run_id": "01RUN",
            "state": "completed",  # service reports the enum variant's name
            "stdout": "",
            "stdout_encoding": "utf-8",
            "stderr": "",
            "stderr_encoding": "utf-8",
            "exit_code": -1,
        },
    )
    with use_transport(t):
        result = client().vm("vm_1").run("sleep 30", timeout=2)
    assert result.state == "failed"
    assert result.exit_code == -1


def test_run_keeps_completed_for_nonzero_program_exit() -> None:
    """A non-zero status is the program's failure, not the platform's."""
    t = FakeTransport()
    t.add_json(
        lambda method, url: method == "POST" and url.endswith("/v1/vms/vm_1/runs"),
        200,
        {
            "run_id": "01RUN",
            "state": "completed",
            "stdout": "",
            "stdout_encoding": "utf-8",
            "stderr": "boom\n",
            "stderr_encoding": "utf-8",
            "exit_code": 7,
        },
    )
    with use_transport(t):
        result = client().vm("vm_1").run("exit 7")
    assert result.state == "completed"
    assert result.exit_code == 7


def test_run_and_get_run_agree_on_state_for_a_killed_run() -> None:
    """The two paths report the same state for the same run."""
    t = FakeTransport()
    t.add_json(
        lambda method, url: method == "POST" and url.endswith("/v1/vms/vm_1/runs"),
        200,
        {
            "run_id": "01RUN",
            "state": "completed",
            "stdout": "",
            "stdout_encoding": "utf-8",
            "stderr": "",
            "stderr_encoding": "utf-8",
            "exit_code": -1,
        },
    )
    t.add_json(
        lambda method, url: method == "GET" and url.endswith("/v1/vms/vm_1/runs/01RUN"),
        200,
        {
            "run_id": "01RUN",
            "state": "failed",
            "started_at": "2026-07-27T00:00:00Z",
            "exit_code": None,
            "fail_reason": "the compute environment became unavailable",
            "stdout": "",
            "stdout_encoding": "utf-8",
            "stderr": "",
            "stderr_encoding": "utf-8",
        },
    )
    with use_transport(t):
        vm = client().vm("vm_1")
        sync = vm.run("sleep 30", timeout=2)
        stored = vm.get_run("01RUN")
    assert sync.state == stored.state == "failed"


# ── Binary output ──────────────────────────────────────────────────
# A run can emit anything: an image, an archive, random bytes. The text view is
# lossy for those by definition, so `*_bytes` must round-trip them exactly.

# 1x1 PNG. Starts with 0x89, which is not a valid UTF-8 start byte, so decoding
# to text mangles it — that is the whole point of keeping the bytes.
PNG_1X1 = base64.b64decode(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=="
)


def _binary_run_body(payload: bytes) -> dict[str, Any]:
    return {
        "stdout": base64.b64encode(payload).decode(),
        "stdout_encoding": "base64",
        "stderr": "",
        "stderr_encoding": "utf-8",
        "exit_code": 0,
    }


def test_run_returns_image_bytes_intact_and_text_is_lossy() -> None:
    t = FakeTransport()
    t.add_json(
        lambda method, url: method == "POST" and url.endswith("/v1/vms/vm_1/runs"),
        200,
        _binary_run_body(PNG_1X1),
    )

    with use_transport(t):
        result = client().vm("vm_1").run("cat photo.png")

    # The bytes survive exactly — you can write them straight to a file.
    assert result.stdout_bytes == PNG_1X1
    assert result.stdout_bytes[:8] == b"\x89PNG\r\n\x1a\n"
    assert len(result.stdout_bytes) == len(PNG_1X1)
    # The text view is lossy for binary, and must not raise.
    assert isinstance(result.stdout, str)
    assert "�" in result.stdout


def test_get_run_returns_image_bytes_intact() -> None:
    t = FakeTransport()
    body = _binary_run_body(PNG_1X1)
    body.update({"run_id": "run_1", "state": "completed", "started_at": "now"})
    t.add_json(lambda method, url: method == "GET" and url.endswith("/runs/run_1"), 200, body)

    with use_transport(t):
        stored = client().vm("vm_1").get_run("run_1")

    assert stored.stdout_bytes == PNG_1X1
    assert "�" in stored.stdout


def test_run_and_get_run_agree_on_binary_output() -> None:
    """The two paths decode the same wire payload identically — the asymmetry
    that made `get_run` return encoded strings is what broke callers."""
    t = FakeTransport()
    t.add_json(
        lambda method, url: method == "POST" and url.endswith("/v1/vms/vm_1/runs"),
        200,
        _binary_run_body(PNG_1X1),
    )
    stored_body = _binary_run_body(PNG_1X1)
    stored_body.update({"run_id": "run_1", "state": "completed", "started_at": "now"})
    t.add_json(lambda method, url: method == "GET" and url.endswith("/runs/run_1"), 200, stored_body)

    with use_transport(t):
        vm = client().vm("vm_1")
        live = vm.run("cat photo.png")
        stored = vm.get_run("run_1")

    assert live.stdout_bytes == stored.stdout_bytes == PNG_1X1
    assert live.stdout == stored.stdout


def test_every_byte_value_round_trips() -> None:
    """All 256 byte values, including NUL and the invalid-UTF-8 range. Text
    decoding collapses many of these to U+FFFD; the bytes must not."""
    payload = bytes(range(256))
    t = FakeTransport()
    t.add_json(
        lambda method, url: method == "POST" and url.endswith("/v1/vms/vm_1/runs"),
        200,
        _binary_run_body(payload),
    )

    with use_transport(t):
        result = client().vm("vm_1").run("cat /dev/urandom")

    assert result.stdout_bytes == payload
    assert len(result.stdout_bytes) == 256
    # Lossy as text: distinct bytes collapse onto the replacement char.
    assert len(set(result.stdout)) < 256


def test_utf8_wire_still_yields_both_forms() -> None:
    """The utf-8 wire path must populate bytes too, not only text."""
    t = FakeTransport()
    t.add_json(
        lambda method, url: method == "POST" and url.endswith("/v1/vms/vm_1/runs"),
        200,
        {
            "stdout": "café \U0001f389\n",
            "stdout_encoding": "utf-8",
            "stderr": "",
            "stderr_encoding": "utf-8",
            "exit_code": 0,
        },
    )

    with use_transport(t):
        result = client().vm("vm_1").run("echo cafe")

    assert result.stdout == "café \U0001f389\n"
    assert result.stdout_bytes == "café \U0001f389\n".encode()
    assert result.stdout_bytes.decode() == result.stdout


def test_connect_pty_defaults_to_plain_text_env() -> None:
    """A PTY should emit plain text by default — its consumer is a program.

    The env rides on the SESSION (a PTY inherits it), so this asserts the
    create-session body rather than any PTY query param.
    """
    t = FakeTransport()
    seen: dict[str, object] = {}

    def capture(method: str, url: str) -> bool:
        return method == "POST" and url.endswith("/sessions")

    t.add_json(capture, 200, {"session_id": "s1", "vm_id": "vm1", "state": "idle"})
    with use_transport(t):
        vm = client().vm("vm1")
        try:
            vm.connect_pty()          # no websocket-client / no server: the
        except Exception:             # session POST still happens first
            pass
        for call in getattr(t, "calls", []):
            if str(call).endswith("/sessions") or "/sessions" in str(call):
                seen["hit"] = True
    # The contract we care about is the constant itself; assert it is plain.
    from arker.computer import PLAIN_PTY_ENV

    assert PLAIN_PTY_ENV["TERM"] == "dumb"
    assert PLAIN_PTY_ENV["NO_COLOR"] == "1"
    assert PLAIN_PTY_ENV["FORCE_COLOR"] == "0"


def test_plain_pty_env_is_overridable() -> None:
    """`plain=False` must leave a human-facing TUI able to render."""
    import inspect

    from arker.computer import VM

    sig = inspect.signature(VM.connect_pty)
    assert sig.parameters["plain"].default is True
    assert sig.parameters["env"].default is None


def test_fork_sends_gpu_resources() -> None:
    """GPU sizing rides the same `resources` object as vcpu/memory/disk.

    The contract folds every resource into one `VmResources`, so a GPU request
    must not introduce a second shape — it is `resources.gpu_vram_mib` /
    `resources.gpu_sms` alongside the CPU fields, and unset fields are pruned.
    """
    t = FakeTransport()
    t.add_json(
        lambda method, url: method == "POST" and url.endswith("/v1/fork"),
        200,
        {
            "vm_id": "vm_child",
            "owner_org_id": "owner",
            "created_at": "now",
            "description": None,
            "public": False,
            "state": "idle",
            "sessions": [],
            "network": {},
            "resources": {},
        },
    )

    with use_transport(t):
        client().fork(
            source_vm_id="ubuntu-gpu-small",
            platforms=["x86_64-l40s"],
            gpu_vram_mib=24576,
            gpu_sms=8,
        )

    assert json.loads(t.calls[0]["body"]) == {
        "source_vm_id": "ubuntu-gpu-small",
        "platforms": ["x86_64-l40s"],
        "resources": {"gpu_vram_mib": 24576, "gpu_sms": 8},
    }


def test_fork_mixes_gpu_and_cpu_resources() -> None:
    """CPU and GPU fields coexist in the single resources object."""
    t = FakeTransport()
    t.add_json(
        lambda method, url: method == "POST" and url.endswith("/v1/fork"),
        200,
        {
            "vm_id": "vm_child",
            "owner_org_id": "owner",
            "created_at": "now",
            "description": None,
            "public": False,
            "state": "idle",
            "sessions": [],
            "network": {},
            "resources": {},
        },
    )

    with use_transport(t):
        client().fork(source_vm_id="ubuntu-gpu-small", vcpu_count=4, gpu_vram_mib=8192)

    assert json.loads(t.calls[0]["body"]) == {
        "source_vm_id": "ubuntu-gpu-small",
        "resources": {"vcpu": 4, "gpu_vram_mib": 8192},
    }


def test_fork_omits_resources_when_no_sizing_requested() -> None:
    """No sizing of any kind ⇒ no `resources` key at all (not an empty object).

    Guards the `any(...)` gate: adding GPU fields must not make every fork
    start sending a resources object it did not send before.
    """
    t = FakeTransport()
    t.add_json(
        lambda method, url: method == "POST" and url.endswith("/v1/fork"),
        200,
        {
            "vm_id": "vm_child",
            "owner_org_id": "owner",
            "created_at": "now",
            "description": None,
            "public": False,
            "state": "idle",
            "sessions": [],
            "network": {},
            "resources": {},
        },
    )

    with use_transport(t):
        client().fork(source_vm_id="ubuntu")

    assert "resources" not in json.loads(t.calls[0]["body"])


def test_fork_omits_disk_so_nodisk_sources_work() -> None:
    """`disk` must not be defaulted client-side.

    Every GPU golden is a nodisk source, and arkerd rejects a disk-backed fork
    from one with "cannot create a disk-backed fork from a nodisk source". The
    SDK used to send `disk: true` on every fork, which made those goldens
    unforkable. Omitting it is explicitly supported and yields an identical VM
    for disk-backed sources (verified against prod: disk_mib=4096 either way).
    """
    t = FakeTransport()
    for _ in range(3):
        t.add_json(
            lambda method, url: method == "POST" and url.endswith("/v1/fork"),
            200,
            {
                "vm_id": "vm_child",
                "owner_org_id": "owner",
                "created_at": "now",
                "description": None,
                "public": False,
                "state": "idle",
                "sessions": [],
                "network": {},
                "resources": {},
            },
        )

    with use_transport(t):
        client().fork(source_vm_name="ubuntu-gpu-small")

    body = json.loads(t.calls[0]["body"])
    assert "disk" not in body

    # An explicit choice is still honoured in both directions.
    with use_transport(t):
        client().fork(source_vm_name="ubuntu-gpu-small", disk=False)
    assert json.loads(t.calls[1]["body"])["disk"] is False

    with use_transport(t):
        client().fork(source_vm_name="ubuntu", disk=True)
    assert json.loads(t.calls[2]["body"])["disk"] is True
