"""End-to-end test for the Arker Python SDK against a live deployment.

Mirrors `cloudflare/lambda/scripts/smoke-sync.py` but exercises the
SDK's own surface — proves the wire-level smoke and the
SDK-level smoke produce the same end-to-end behaviour.

Usage:

    ARKER_API_KEY=ark_live_... \\
    ARKER_BASE_URL=http://arker-scheduler-alb-…elb.amazonaws.com \\
    python3 sdk/custom/python/e2e_test.py

Exits 0 on full pass, 1 on any failure. No pytest dep — it's a single
script so you can drop it on a fresh box and run it.
"""

from __future__ import annotations

import hashlib
import os
import secrets
import sys
from pathlib import Path

import arker.computer as sdk  # local-import; install with pip install -e .

API_KEY = os.environ.get("ARKER_API_KEY") or os.environ.get("AUTH_KEY")
BASE_URL = os.environ.get("ARKER_BASE_URL") or os.environ.get("PROXY_URL")
# The SDK now defaults to the regional ALB, which doesn't run the CF
# worker's name-lookup. Pass a real template ULID (e.g. arkuntu's per
# this org) via env, or override BASE_URL=https://arker.ai if you
# want to use the friendlier "arkuntu" name.
TEMPLATE = os.environ.get(
    "ARKER_TEMPLATE",
    "01KQBYKEV5WJ7YB010603T1DCT_d8c0",  # arkuntu template ULID (this org)
)

if not API_KEY:
    print("ARKER_API_KEY (or AUTH_KEY) is required", file=sys.stderr)
    sys.exit(2)
# BASE_URL=None falls through to the SDK's DEFAULT_BASE_URL (ALB).

results: list[tuple[str, bool, str]] = []


def check(name: str, ok: bool, detail: str = "") -> None:
    results.append((name, ok, detail))
    print(f"  {'✅' if ok else '❌'} {name}  {detail}")


arker = sdk.Arker(api_key=API_KEY, base_url=BASE_URL)

print(f"\n━━━ vm(TEMPLATE).fork() + run (TEMPLATE={TEMPLATE}) ━━━")
vm = arker.vm(TEMPLATE).fork(name="sdk-e2e")
check(f"vm({TEMPLATE!r}).fork()", bool(vm.id), f"vm={vm.id}")

try:
    r = vm.run("echo hello-from-sdk")
    check("run echo exits 0", isinstance(r, sdk.RunResult) and r.exit_code == 0,
          f"stdout={r.stdout!r}")
    check("run stdout matches", r.stdout.startswith(b"hello-from-sdk"))

    print("\n━━━ small write_file (fast-path) ━━━")
    payload_small = b"sdk-small-payload\n"
    vm.sync.write_file("/home/user/small.txt", payload_small)
    back = vm.sync.read_file("/home/user/small.txt")
    check("small round-trip", back == payload_small, f"got {len(back)}B")

    print("\n━━━ medium write_file (multi-chunk) ━━━")
    payload_med = secrets.token_bytes(12 * 1024 * 1024)  # 12 MB → 3× 4 MB chunks
    vm.sync.write_file("/home/user/medium.bin", payload_med)
    back_med = vm.sync.read_file("/home/user/medium.bin")
    check("12 MB round-trip via multi-chunk",
          hashlib.sha256(back_med).digest() == hashlib.sha256(payload_med).digest(),
          f"len={len(back_med)}")

    print("\n━━━ large write_file (presigned bypass) ━━━")
    payload_big = secrets.token_bytes(60 * 1024 * 1024)  # 60 MB
    vm.sync.write_file("/home/user/big.bin", payload_big)
    back_big = vm.sync.read_file("/home/user/big.bin")
    check("60 MB round-trip via presigned bypass",
          hashlib.sha256(back_big).digest() == hashlib.sha256(payload_big).digest(),
          f"len={len(back_big)}")

    print("\n━━━ cat /sync parity ━━━")
    r = vm.run("cat /home/user/small.txt")
    check("cat sees the SDK-written file",
          r.exit_code == 0 and r.stdout == payload_small,
          f"stdout={r.stdout!r}")

    print("\n━━━ fork ━━━")
    child = vm.fork(name="sdk-e2e-child")
    check("fork → new vm_id",
          isinstance(child, sdk.Computer) and child.id != vm.id,
          f"child={child.id}")
    r_child = child.run("cat /home/user/small.txt")
    check("child sees parent's file",
          r_child.exit_code == 0 and r_child.stdout == payload_small)
    child.delete()

    print("\n━━━ error path ━━━")
    try:
        vm.sync.read_file("/home/user/does-not-exist.txt")
        check("missing file raises ArkerError", False, "no exception raised")
    except sdk.ArkerError as e:
        check("missing file → ArkerError(not_found)",
              e.code == "not_found" and e.status == 404,
              f"code={e.code} status={e.status}")
finally:
    try:
        vm.delete()
        check("delete cleanup", True)
    except Exception as e:
        check("delete cleanup", False, str(e))

# ── Summary ──
total = len(results)
passed = sum(1 for _, ok, _ in results if ok)
print(f"\n━━━ SUMMARY ━━━\n  {passed}/{total} passed")
if passed != total:
    print("Failures:")
    for name, ok, detail in results:
        if not ok:
            print(f"   - {name}  {detail}")
sys.exit(0 if passed == total else 1)
