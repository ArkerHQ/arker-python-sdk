"""Live Python SDK demo.

Run:
    ARKER_API_KEY=ark_live_... \\
    ARKER_PROVIDER=aws \\
    ARKER_REGION=us-west-2 \\
    ARKER_SOURCE_VM=<source-name> \\
    python tests/demo.py
"""

from __future__ import annotations

import contextlib
import os
import sys
import urllib.request

from arker import Arker, ArkerError, CompletedRunResult


def required_env(name: str) -> str:
    value = os.environ.get(name)
    if not value or not value.strip():
        print(f"{name} is required", file=sys.stderr)
        sys.exit(2)
    return value.strip()


def optional_env(name: str) -> str | None:
    value = os.environ.get(name)
    return value.strip() if value and value.strip() else None


api_key = required_env("ARKER_API_KEY")
base_url = optional_env("ARKER_BASE_URL")
region = optional_env("ARKER_REGION")
provider = optional_env("ARKER_PROVIDER")
source_vm = required_env("ARKER_SOURCE_VM")

original_urlopen = urllib.request.urlopen


def trace_urlopen(req, *args, **kwargs):  # type: ignore[no-untyped-def]
    if hasattr(req, "full_url"):
        method = req.get_method()
        url = req.full_url
        body = ""
        if req.data and len(req.data) <= 220:
            body = f" body={req.data.decode('utf-8', 'replace')}"
        print(f"{method} {url}{body}")
    else:
        print(f"GET {req}")
    return original_urlopen(req, *args, **kwargs)


urllib.request.urlopen = trace_urlopen  # type: ignore[assignment]

arker = Arker(api_key=api_key, base_url=base_url, provider=provider, region=region)
vm = None

try:
    vm = arker.vm(source_vm).fork(name="python-sdk-demo")

    hello = "hello-from-python-sdk"
    run = vm.run(f"printf '{hello}\\n'")
    if not isinstance(run, CompletedRunResult):
        raise RuntimeError(f"expected completed run result, got {run!r}")
    if run.exit_code != 0 or run.stdout != f"{hello}\n":
        raise RuntimeError(f"unexpected run output: exit={run.exit_code} stdout={run.stdout!r}")

    vm.sync("/home/user/python-sdk-demo.txt", f"{hello}\n")
    if vm.sync("/home/user/python-sdk-demo.txt") != f"{hello}\n".encode():
        raise RuntimeError("sync round trip failed")

    print(f"PASS {vm.id}")
except ArkerError as error:
    print(f"FAIL {error.code} status={error.status}: {error.message}", file=sys.stderr)
    sys.exit(1)
except Exception as error:
    print(f"FAIL {error}", file=sys.stderr)
    sys.exit(1)
finally:
    if vm is not None:
        with contextlib.suppress(Exception):
            vm.delete()
