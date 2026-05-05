"""Presigned-bypass round-trip probe.

Uploads a 60 MB random blob via the SDK (which routes Shape 2 →
direct-to-S3 PUT → Shape 3 commit), then verifies the file actually
landed by `cat`-ing it through the /run shell and comparing md5.

This is the cross-check between the sync write path and the run
shell's view of the filesystem — the same VFS the user's commands
see at execution time. If presigned-bypass writes are landing in S3
but not surfacing through state.log → vfs, this test catches it.

Usage:

    ARKER_API_KEY=ark_live_... python3 sdk/custom/python/presigned_probe.py
"""

from __future__ import annotations

import hashlib
import os
import secrets
import sys
import time
from pathlib import Path

import arker.computer as sdk  # local-import; install with pip install -e .

API_KEY = os.environ.get("ARKER_API_KEY") or os.environ.get("AUTH_KEY")
BASE_URL = os.environ.get("ARKER_BASE_URL")
TEMPLATE = os.environ.get("ARKER_TEMPLATE", "01KQBYKEV5WJ7YB010603T1DCT_d8c0")

if not API_KEY:
    print("ARKER_API_KEY required", file=sys.stderr)
    sys.exit(2)

arker = sdk.Arker(api_key=API_KEY, base_url=BASE_URL)
print(f"base_url={arker._base_url}\ntemplate={TEMPLATE}")

vm = arker.fork(TEMPLATE, name="presigned-probe")
print(f"vm={vm.id}")

results: list[tuple[str, bool, str]] = []
def check(name: str, ok: bool, detail: str = "") -> None:
    results.append((name, ok, detail))
    print(f"  {'✅' if ok else '❌'} {name}  {detail}")


try:
    # ── 60 MB random payload — well above PRESIGNED_THRESHOLD (50 MB),
    # so the SDK takes the Shape 2 → S3 PUT → Shape 3 path. ─────────
    size = 60 * 1024 * 1024
    payload = secrets.token_bytes(size)
    expected_md5 = hashlib.md5(payload).hexdigest()
    print(f"\nuploading {size} bytes via presigned bypass (md5={expected_md5})")

    t0 = time.monotonic()
    vm.sync.write_file("/home/user/presigned.bin", payload)
    upload_ms = (time.monotonic() - t0) * 1000
    print(f"  upload took {upload_ms:.0f}ms")

    # ── Verification 1: SDK read-back, byte-for-byte equality ───────
    t0 = time.monotonic()
    back = vm.sync.read_file("/home/user/presigned.bin")
    read_ms = (time.monotonic() - t0) * 1000
    check("SDK read-back length matches", len(back) == size, f"{len(back)}B in {read_ms:.0f}ms")
    check("SDK read-back md5 matches",
          hashlib.md5(back).hexdigest() == expected_md5,
          f"got md5={hashlib.md5(back).hexdigest()}")

    # ── Verification 2: shell `md5sum` via /run — proves the file is
    # actually visible inside the VM's filesystem (not just sitting
    # in S3 unreferenced). ───────────────────────────────────────────
    r = vm.run("md5sum /home/user/presigned.bin")
    check("run md5sum exits 0",
          r.exit_code == 0,
          f"exit={r.exit_code} stderr={r.stderr!r}")
    cat_md5 = r.stdout.decode().strip().split()[0] if r.stdout else ""
    check("shell md5 matches expected",
          cat_md5 == expected_md5,
          f"shell={cat_md5}  expected={expected_md5}")

    # ── Verification 3: shell `wc -c` to confirm size ───────────────
    r = vm.run("wc -c /home/user/presigned.bin")
    wc_size = int(r.stdout.decode().strip().split()[0]) if r.stdout else 0
    check("shell wc -c size matches",
          wc_size == size,
          f"shell={wc_size} expected={size}")

    # ── Verification 4: `head -c 16 | xxd` to peek at the first bytes ─
    r = vm.run("head -c 16 /home/user/presigned.bin | xxd -p")
    shell_head = r.stdout.decode().strip() if r.stdout else ""
    expected_head = payload[:16].hex()
    check("shell first-16 bytes match",
          shell_head == expected_head,
          f"shell={shell_head!r}  expected={expected_head!r}")

    # ── Verification 5: read it back from a freshly forked CHILD —
    # confirms the state.log copy at fork actually carries the new
    # blob reference, not just a stale parent-state-only fork. ──────
    child = vm.fork(name="presigned-child")
    print(f"\nforked child {child.id}")
    r = child.run("md5sum /home/user/presigned.bin")
    child_md5 = r.stdout.decode().strip().split()[0] if r.stdout else ""
    check("child shell md5 matches",
          child_md5 == expected_md5,
          f"child={child_md5}")
    child.delete()

finally:
    try:
        vm.delete()
        print("\ncleanup: vm deleted")
    except Exception as e:
        print(f"\ncleanup failed: {e}")

# ── Summary ──
total = len(results)
passed = sum(1 for _, ok, _ in results if ok)
print(f"\n━━━ {passed}/{total} passed ━━━")
sys.exit(0 if passed == total else 1)
