"""Live SDK demo: exercises every public method against the production
deployment, printing what each call sends on the wire and the result.
Doubles as smoke test and as documentation — if you wonder "what does
`a.list(q='hello')` actually do?", look at the printed line and the
returned data.

Run:
    ARKER_API_KEY=ark_live_... python sdk/python/tests/demo.py

Exits 0 on full pass, 1 on any failure.
"""
from __future__ import annotations

import hashlib
import os
import secrets
import sys
import time
import urllib.request

import arker
from arker import Arker, ArkerError, Computer, RunResult, VmList, VmSummary

API_KEY = os.environ.get("ARKER_API_KEY") or os.environ.get("AUTH_KEY")
if not API_KEY:
    print("ARKER_API_KEY is required", file=sys.stderr)
    sys.exit(2)
# Source VM to fork from. Defaults to the public `arkuntu` base image.
SOURCE_VM = os.environ.get("ARKER_SOURCE_VM", "arkuntu")

# ── Wire-level request tracing ─────────────────────────────────────────
# Wrap urlopen so every HTTP call the SDK makes is printed verbatim.
# This is what makes the demo double as documentation.
_orig_urlopen = urllib.request.urlopen


def _trace_urlopen(req, *args, **kwargs):
    if hasattr(req, "full_url"):
        method = req.get_method()
        url = req.full_url
        body_preview = ""
        if req.data:
            n = len(req.data)
            body_preview = f"  ({n} byte body)" if n > 200 else f"  body={req.data[:200]!r}"
        print(f"    → {method} {url}{body_preview}")
    else:
        print(f"    → GET {req}")
    return _orig_urlopen(req, *args, **kwargs)


urllib.request.urlopen = _trace_urlopen  # type: ignore[assignment]

# ── Test harness ───────────────────────────────────────────────────────
results: list[tuple[str, bool, str]] = []


def section(title: str) -> None:
    print(f"\n━━━ {title} ━━━")


def check(name: str, ok: bool, detail: str = "") -> None:
    results.append((name, ok, detail))
    icon = "✅" if ok else "❌"
    suffix = f"  [{detail}]" if detail else ""
    print(f"  {icon} {name}{suffix}")


# ── 0. Construct client ────────────────────────────────────────────────
section("Arker(api_key=...)")
print(f"  arker version: {arker.__version__}")
arker_client = Arker(api_key=API_KEY)
print(f"  default base_url: {arker_client._base_url}")
check("client constructed", isinstance(arker_client, Arker))

# ── 1. list() — paginated VMs (always hits arker.ai) ───────────────────
section("arker_client.list(limit=5) — should hit https://arker.ai")
page_before = arker_client.list(limit=5)
check(
    "returns VmList",
    isinstance(page_before, VmList) and all(isinstance(item, VmSummary) for item in page_before),
    f"total={page_before.total} items={len(page_before)}",
)
for summary in page_before.items[:3]:
    print(f"     · {summary.vm_id}  name={summary.name!r}  region={summary.region}  created={summary.created_at}")

# ── 2. vm() — open handle, no network call ─────────────────────────────
section(f'arker_client.vm("{SOURCE_VM}") — handle, no network call')
source = arker_client.vm(SOURCE_VM)
check(
    f'arker_client.vm("{SOURCE_VM}") returns Computer',
    isinstance(source, Computer) and source.id == SOURCE_VM,
    f"id={source.id!r}",
)

# ── 3. fork() ──────────────────────────────────────────────────────────
section(f'source.fork(name="sdk-demo") — fork from {SOURCE_VM}')
vm = source.fork(name="sdk-demo")
check(
    "fork returns Computer with new ULID id",
    isinstance(vm, Computer) and vm.id != "arkuntu" and len(vm.id) >= 26,
    f"vm.id={vm.id}",
)

try:
    # ── 4. run(simple command) ─────────────────────────────────────────
    section('vm.run("echo hello") — POST .../run')
    run_result = vm.run("echo hello-from-sdk")
    check(
        "run returns RunResult",
        isinstance(run_result, RunResult),
        f"exit={run_result.exit_code} duration_ms={run_result.duration_ms:.0f}",
    )
    check("stdout matches", run_result.stdout == b"hello-from-sdk\n", f"stdout={run_result.stdout!r}")

    # ── 5. write_file (small / fast path) ──────────────────────────────
    section('vm.sync.write_file("/home/user/small.txt", b"...") — single call')
    payload_small = b"hello-small-payload\n"
    vm.sync.write_file("/home/user/small.txt", payload_small)
    check("small write returned", True, f"{len(payload_small)} bytes")

    # ── 6. read_file (small / inline) ──────────────────────────────────
    section('vm.sync.read_file("/home/user/small.txt") — inline response')
    back_small = vm.sync.read_file("/home/user/small.txt")
    check("small round-trip", back_small == payload_small)

    # ── 7. cat the file via run() — proves wire is consistent ──────────
    section('vm.run("cat /home/user/small.txt") — same bytes via shell')
    cat_result = vm.run("cat /home/user/small.txt")
    check(
        "shell sees the SDK-written file",
        cat_result.exit_code == 0 and cat_result.stdout == payload_small,
        f"stdout={cat_result.stdout!r}",
    )

    # ── 8. write_file (large / presigned bypass) ───────────────────────
    section('vm.sync.write_file(big_blob)  — large payload uses presigned upload')
    payload_big = secrets.token_bytes(8 * 1024 * 1024)  # 8 MiB → presigned bypass
    t0 = time.monotonic()
    vm.sync.write_file("/home/user/big.bin", payload_big)
    check("8 MiB write returned", True, f"{(time.monotonic()-t0)*1000:.0f}ms")

    # ── 9. read_file (large / inline, since 8 MiB still fits) ──────────
    section('vm.sync.read_file(big_blob) — handles inline-or-presigned automatically')
    t0 = time.monotonic()
    back_big = vm.sync.read_file("/home/user/big.bin")
    check(
        "8 MiB round-trip integrity",
        hashlib.sha256(back_big).digest() == hashlib.sha256(payload_big).digest(),
        f"{(time.monotonic()-t0)*1000:.0f}ms, sha256 match",
    )

    # ── 10. fork from existing VM (non-alias path) ────────────────────
    section('vm.fork(name="branch") — fork an existing VM')
    child = vm.fork(name="sdk-demo-child")
    check(
        "child has new id",
        isinstance(child, Computer) and child.id != vm.id,
        f"child.id={child.id}",
    )

    # ── 11. child sees parent's filesystem ────────────────────────────
    section('child.run("cat /home/user/small.txt") — child inherits parent state')
    child_cat = child.run("cat /home/user/small.txt")
    check(
        "child sees parent's file",
        child_cat.exit_code == 0 and child_cat.stdout == payload_small,
        f"stdout={child_cat.stdout!r}",
    )
    child.delete()
    check("child.delete() succeeded", True)

    # ── 12. error path — read missing file raises ArkerError ──────────
    section("error path: vm.sync.read_file('/home/user/does-not-exist.txt')")
    try:
        vm.sync.read_file("/home/user/does-not-exist.txt")
        check("missing file raises ArkerError", False, "no exception raised")
    except ArkerError as err:
        check(
            "ArkerError(not_found, status=404)",
            err.code == "not_found" and err.status == 404,
            f"code={err.code!r} status={err.status}",
        )

    # ── 13. list() shows our new VM ───────────────────────────────────
    section('arker_client.list(q="sdk-demo") — filter shows the VMs we just made')
    page_after = arker_client.list(q="sdk-demo")
    check(
        "list filters by name substring",
        any(summary.vm_id == vm.id for summary in page_after),
        f"total={page_after.total} matched",
    )

finally:
    # ── 14. delete() — cleanup ────────────────────────────────────────
    section("vm.delete() — cleanup")
    try:
        vm.delete()
        check("vm.delete() succeeded", True)
    except Exception as e:
        check("vm.delete() succeeded", False, str(e))

# ── Summary ────────────────────────────────────────────────────────────
total = len(results)
passed = sum(1 for _, ok, _ in results if ok)
print(f"\n━━━ SUMMARY ━━━\n  {passed}/{total} passed")
if passed != total:
    print("  Failures:")
    for name, ok, detail in results:
        if not ok:
            print(f"    × {name}  [{detail}]")
sys.exit(0 if passed == total else 1)
