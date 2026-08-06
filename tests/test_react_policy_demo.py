import io
import re
import runpy
import subprocess
import sys
from pathlib import Path
from types import ModuleType, SimpleNamespace
from typing import Any, ClassVar

import pytest

REPO_ROOT = Path(__file__).resolve().parents[1]
DEMO_DIR = REPO_ROOT / "examples" / "react-policy"
PYTHON_DEMO = DEMO_DIR / "quick_start.py"
REACT_APP = DEMO_DIR / "app" / "src" / "App.jsx"

BUILD_POLICY = {
    "policies": [
        {
            "type": "outbound",
            "match": {
                "hosts": ["registry.npmjs.org"],
                "ports": [443],
            },
            "action": "allow",
        }
    ]
}

PUBLIC_POLICY = {
    "policies": [
        {
            "type": "inbound",
            "match": {"ports": [8080]},
            "action": "allow",
            "auth": "open",
        }
    ]
}


class FakeResponse(io.BytesIO):
    def __enter__(self):
        return self

    def __exit__(self, *_: object) -> None:
        self.close()


class FakeVM:
    id = "vm_test"

    def __init__(self, build_exit_code: int) -> None:
        self.build_exit_code = build_exit_code
        self.deleted = False
        self.runs: list[tuple[str, dict[str, Any]]] = []
        self.session_cwds: list[str] = []
        self.syncs: list[tuple[str, str]] = []

    def sync_dir(self, local_dir: str, remote_dir: str) -> SimpleNamespace:
        self.syncs.append((local_dir, remote_dir))
        return SimpleNamespace(sent=7, skipped=0)

    def run(self, command: str, **kwargs: Any) -> SimpleNamespace:
        self.runs.append((command, kwargs))
        if "npm ci" in command:
            return SimpleNamespace(
                exit_code=self.build_exit_code,
                stdout=b"build output\n",
                stderr=b"build failed\n" if self.build_exit_code else b"",
            )
        if kwargs.get("background"):
            return SimpleNamespace(run_id="run_test")
        if "--connect-timeout" in command:
            return SimpleNamespace(exit_code=28, stdout=b"", stderr=b"")
        return SimpleNamespace(exit_code=0, stdout=b"ok\n", stderr=b"")

    def create_session(self, *, cwd: str) -> SimpleNamespace:
        self.session_cwds.append(cwd)
        return SimpleNamespace(session_id="session_test")

    def delete(self) -> None:
        self.deleted = True


class FakeArker:
    instances: ClassVar[list["FakeArker"]] = []
    build_exit_code = 0

    def __init__(self, **kwargs: Any) -> None:
        self.options = kwargs
        self.forks: list[tuple[str, dict[str, Any]]] = []
        self.vm = FakeVM(self.build_exit_code)
        self.instances.append(self)

    def fork(self, source: str, **kwargs: Any) -> FakeVM:
        self.forks.append((source, kwargs))
        return self.vm


def run_demo(monkeypatch: pytest.MonkeyPatch, build_exit_code: int = 0) -> list[str]:
    FakeArker.instances.clear()
    FakeArker.build_exit_code = build_exit_code

    arker_module = ModuleType("arker")
    arker_module.Arker = FakeArker  # type: ignore[attr-defined]
    monkeypatch.setitem(sys.modules, "arker", arker_module)

    requested_urls: list[str] = []

    def fake_urlopen(url: str, *, timeout: int) -> FakeResponse:
        requested_urls.append(url)
        if url.endswith("/healthz"):
            return FakeResponse(b"ok\n")
        return FakeResponse(b"<title>Arker React policy demo</title>")

    monkeypatch.setattr("urllib.request.urlopen", fake_urlopen)
    runpy.run_path(str(PYTHON_DEMO), run_name="__main__")
    return requested_urls


def test_python_demo_runs_the_documented_sdk_flow(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    requested_urls = run_demo(monkeypatch)

    arker = FakeArker.instances[0]
    vm = arker.vm

    assert arker.forks == [
        ("ubuntu-dev", {"name": "react-policy-demo", "policies": BUILD_POLICY})
    ]
    assert vm.syncs == [(str(DEMO_DIR / "app"), "/workspace/react-policy")]

    build_command, _ = vm.runs[0]
    assert "npm ci" in build_command
    assert "npm run build" in build_command

    assert vm.session_cwds == ["/workspace/react-policy"]
    server_command, server_options = vm.runs[1]
    assert server_command == "exec node server.mjs"
    assert server_options == {
        "session_id": "session_test",
        "background": True,
        "timeout": 0,
        "policies": PUBLIC_POLICY,
    }

    public_url = "https://vm_test-8080.aws-us-west-2.arker.app"
    assert requested_urls == [f"{public_url}/healthz", f"{public_url}/"]
    assert not vm.deleted


def test_python_demo_deletes_the_vm_when_setup_fails(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    with pytest.raises(RuntimeError, match="build failed"):
        run_demo(monkeypatch, build_exit_code=1)

    assert FakeArker.instances[0].vm.deleted


def test_cli_equivalent_is_valid_shell() -> None:
    app = REACT_APP.read_text()
    match = re.search(
        r"const cliCommands = String\.raw`(?P<commands>.*?)`;",
        app,
        re.DOTALL,
    )

    assert match is not None
    subprocess.run(
        ["bash", "-n"],
        input=match.group("commands"),
        text=True,
        check=True,
    )
