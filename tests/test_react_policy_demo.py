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
REACT_STYLES = DEMO_DIR / "app" / "src" / "styles.css"


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
    capsys: pytest.CaptureFixture[str],
) -> None:
    requested_urls = run_demo(monkeypatch)

    arker = FakeArker.instances[0]
    vm = arker.vm

    assert arker.options == {"region": "us-west-2", "provider": "aws"}
    assert arker.forks == [
        (
            "ubuntu-full",
            {
                "name": "react-policy-demo",
                "policies": BUILD_POLICY,
            },
        )
    ]

    assert len(vm.syncs) == 1
    local_dir, remote_dir = vm.syncs[0]
    assert Path(local_dir) == DEMO_DIR / "app"
    assert remote_dir == "/workspace/react-policy"

    build_command, build_options = vm.runs[0]
    assert "npm ci --include=dev --no-audit --no-fund" in build_command
    assert "npm run build" in build_command
    assert build_options == {}

    assert vm.session_cwds == ["/workspace/react-policy"]
    server_command, server_options = vm.runs[1]
    assert server_command == "exec node server.mjs"
    assert server_options == {
        "session_id": "session_test",
        "background": True,
        "timeout": 0,
        "policies": PUBLIC_POLICY,
    }

    health_command, health_options = vm.runs[2]
    assert "http://127.0.0.1:8080/healthz" in health_command
    assert health_options == {}

    public_url = "https://vm_test-8080.aws-us-west-2.arker.app"
    assert requested_urls == [f"{public_url}/healthz", f"{public_url}/"]
    assert not vm.deleted

    output = capsys.readouterr().out
    assert "Build policy: allow registry.npmjs.org:443" in output
    assert "Syncing ./app to /workspace/react-policy" in output
    assert "skipped" not in output.lower()
    assert "Building the React project on the VM" in output
    assert "$ npm ci --include=dev --no-audit --no-fund" in output
    assert "$ npm run build" in output
    assert "Exposing the app on port 8080" in output
    assert "Runtime policy: allow public inbound traffic on :8080" in output
    assert "$ node server.mjs" in output
    assert "Your React web app is now running on an Arker VM!" in output
    assert "React is running on Arker." not in output
    assert f"App URL: {public_url}" in output
    assert "Delete:  arker rm vm_test" in output


def test_python_demo_is_a_one_command_uv_script() -> None:
    script = PYTHON_DEMO.read_text()

    assert script.startswith("#!/usr/bin/env -S uv run --script\n")
    assert '# requires-python = ">=3.10"' in script
    assert '# dependencies = ["arker==0.8.6"]' in script
    assert PYTHON_DEMO.stat().st_mode & 0o111


def test_python_demo_deletes_the_vm_when_setup_fails(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    with pytest.raises(RuntimeError, match="build failed"):
        run_demo(monkeypatch, build_exit_code=1)

    assert FakeArker.instances[0].vm.deleted


def test_bash_runner_and_separate_policy_files_are_removed() -> None:
    assert not (DEMO_DIR / "quick-start-react-policy.sh").exists()
    assert not (DEMO_DIR / "policies").exists()


def test_react_app_is_a_basic_policy_page() -> None:
    app = REACT_APP.read_text()
    styles = REACT_STYLES.read_text()

    assert "Hello from an Arker VM" in app
    assert "Arker policy demo" not in app
    assert "Run it from the CLI" in app
    assert "const cliCommands = String.raw`" in app
    assert "# 1. Configure Arker" in app
    assert "# 2. Fork an Ubuntu VM" in app
    assert "# 3. Allow npm during the build" in app
    assert "# 4. Sync the React project into the VM" in app
    assert "# 5. Build the React project inside the VM" in app
    assert "# 6. Expose port 8080 and start the server" in app
    assert "export ARKER_API_KEY=ark_live_..." in app
    assert "VM=$(arker fork ubuntu-full | jq -r .vm_id)" in app
    assert 'arker policies set "$VM"' in app
    assert "curl " not in app
    assert 'BASE="https://' not in app
    assert "registry.npmjs.org" in app
    assert '"type": "outbound"' in app
    assert '"auth": "open"' in app
    assert (
        "tar --exclude=node_modules --exclude=dist "
        "-C ./examples/react-policy/app -czf - ."
    ) in app
    assert 'arker sync "$VM" /tmp/react-policy.tgz' in app
    assert (
        'arker run "$VM" "cd /workspace/react-policy '
        "&& npm ci --include=dev --no-audit --no-fund"
    ) in app
    assert 'arker run "$VM" "cd /workspace/react-policy && npm run build"' in app
    assert 'arker sessions create "$VM" --cwd /workspace/react-policy' in app
    assert 'arker run --session-id "$SESSION" --background --timeout 0' in app
    assert 'exec node server.mjs"' in app
    assert 'className="command-panel"' in app
    assert "youtube.com" not in app
    assert "<iframe" not in app
    assert "radial-gradient" not in styles
    assert ".video-" not in styles


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
