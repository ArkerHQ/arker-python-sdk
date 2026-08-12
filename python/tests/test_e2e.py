"""Live Python SDK smoke test.

Run directly with live credentials:

    ARKER_API_KEY=ark_live_... \\
    ARKER_PROVIDER=aws \\
    ARKER_REGION=us-west-2 \\
    ARKER_SOURCE_VM=ubuntu \\
    python tests/test_e2e.py
"""

from __future__ import annotations

import os
import sys

try:
    import pytest
except ImportError:  # pragma: no cover
    pytest = None

from arker import Arker, CompletedRunResult

API_KEY = os.environ.get("ARKER_API_KEY") or os.environ.get("AUTH_KEY")
BASE_URL = os.environ.get("ARKER_BASE_URL")
REGION = os.environ.get("ARKER_REGION")
PROVIDER = os.environ.get("ARKER_PROVIDER")
SOURCE_VM = os.environ.get("ARKER_SOURCE_VM")

if pytest and (not API_KEY or not (BASE_URL or (PROVIDER and REGION)) or not SOURCE_VM):
    pytest.skip("live Arker credentials are not configured", allow_module_level=True)

if not API_KEY or not (BASE_URL or (PROVIDER and REGION)) or not SOURCE_VM:
    print("ARKER_API_KEY, ARKER_PROVIDER + ARKER_REGION or ARKER_BASE_URL, and ARKER_SOURCE_VM are required", file=sys.stderr)
    sys.exit(2)


def main() -> int:
    arker = Arker(api_key=API_KEY, base_url=BASE_URL, provider=PROVIDER, region=REGION)
    vm = arker.vm(SOURCE_VM).fork(name="python-sdk-e2e")

    try:
        run = vm.run("printf 'hello-from-python-sdk\\n'")
        assert isinstance(run, CompletedRunResult)
        assert run.exit_code == 0
        assert run.stdout == b"hello-from-python-sdk\n"

        vm.sync("/home/user/python-sdk-e2e.txt", b"hello-from-python-sdk\n")
        assert vm.sync("/home/user/python-sdk-e2e.txt") == b"hello-from-python-sdk\n"

        child = vm.fork(name="python-sdk-e2e-child")
        try:
            child_run = child.run("cat /home/user/python-sdk-e2e.txt")
            assert isinstance(child_run, CompletedRunResult)
            assert child_run.stdout == b"hello-from-python-sdk\n"
        finally:
            child.delete()

        print("PASS")
        return 0
    finally:
        vm.delete()


if __name__ == "__main__":
    sys.exit(main())


def test_live_e2e() -> None:
    assert main() == 0
