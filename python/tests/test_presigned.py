"""Live presigned-write probe.

Run directly with live credentials:

    ARKER_API_KEY=ark_live_... \\
    ARKER_BASE_URL=https://aws-us-west-2.arker.ai/api \\
    ARKER_SOURCE_VM=ubuntu \\
    python tests/test_presigned.py
"""

from __future__ import annotations

import hashlib
import os
import secrets
import sys

try:
    import pytest
except ImportError:  # pragma: no cover
    pytest = None

from arker import Arker, CompletedRunResult

API_KEY = os.environ.get("ARKER_API_KEY") or os.environ.get("AUTH_KEY")
BASE_URL = os.environ.get("ARKER_BASE_URL")
SOURCE_VM = os.environ.get("ARKER_SOURCE_VM")

if pytest and (not API_KEY or not BASE_URL or not SOURCE_VM):
    pytest.skip("live Arker credentials are not configured", allow_module_level=True)

if not API_KEY or not BASE_URL or not SOURCE_VM:
    print("ARKER_API_KEY, ARKER_BASE_URL, and ARKER_SOURCE_VM are required", file=sys.stderr)
    sys.exit(2)


def main() -> int:
    payload = secrets.token_bytes(5 * 1024 * 1024)
    expected = hashlib.sha256(payload).hexdigest()

    arker = Arker(api_key=API_KEY, base_url=BASE_URL)
    vm = arker.vm(SOURCE_VM).fork(name="python-sdk-presigned")

    try:
        vm.sync.write_file("/home/user/presigned.bin", payload)
        assert hashlib.sha256(vm.sync.read_file("/home/user/presigned.bin")).hexdigest() == expected

        run = vm.run("sha256sum /home/user/presigned.bin")
        assert isinstance(run, CompletedRunResult)
        assert run.exit_code == 0
        assert run.stdout.decode().split()[0] == expected

        print("PASS")
        return 0
    finally:
        vm.delete()


if __name__ == "__main__":
    sys.exit(main())


def test_live_presigned() -> None:
    assert main() == 0
