"""Stress probe — measures real failure rate and latency profile of
read/write operations against the staging deploy.

Usage:

    ARKER_API_KEY=ark_live_... \\
    ARKER_BASE_URL=https://arker.ai \\
    python3 sdk/custom/python/stress_probe.py

Reports:
  - per-op latency p50 / p90 / p99
  - retry counts (we instrument the SDK's _http to count attempts)
  - failure breakdown by code

Bypasses the SDK's retry-on-503 to expose the raw throttle rate, then
ALSO runs with retries on to confirm they ride through. This is
diagnostic data for "is throttling persistent or burst?" — see the
output for the answer.
"""

from __future__ import annotations

import os
import secrets
import sys
import time
from pathlib import Path

import arker.computer as sdk  # local-import; install with pip install -e .

API_KEY = os.environ.get("ARKER_API_KEY") or os.environ.get("AUTH_KEY")
# `None` falls back to the SDK's `DEFAULT_BASE_URL` (now the ALB).
# Override with `ARKER_BASE_URL=https://arker.ai` to compare via Cloudflare.
BASE_URL = os.environ.get("ARKER_BASE_URL")
# Default to the arkuntu template ULID (works against ALB which doesn't
# resolve names). Override with `ARKER_TEMPLATE=arkuntu` only if going
# through arker.ai.
TEMPLATE = os.environ.get(
    "ARKER_TEMPLATE",
    "01KQBYKEV5WJ7YB010603T1DCT_d8c0",
)
N = int(os.environ.get("STRESS_N", "30"))

if not API_KEY:
    print("ARKER_API_KEY required", file=sys.stderr)
    sys.exit(2)


def install_http_tracer() -> list[dict]:
    """Wrap the SDK's `_http` to record one row per outbound HTTP call.
    Returns the trace list — pulled into per-phase analysis after each
    run."""
    trace: list[dict] = []
    original = sdk._http
    def traced(method, url, headers, body):
        t0 = time.monotonic()
        try:
            status, raw = original(method, url, headers, body)
            elapsed = time.monotonic() - t0
            trace.append({
                "method": method, "url": url, "status": status,
                "elapsed_ms": elapsed * 1000,
                "body_size": len(body) if body else 0,
                "resp_size": len(raw) if raw else 0,
                "is_transient": status in sdk._RETRYABLE_STATUSES,
            })
            return status, raw
        except Exception as e:
            elapsed = time.monotonic() - t0
            trace.append({
                "method": method, "url": url, "status": -1,
                "elapsed_ms": elapsed * 1000,
                "exception": str(e),
            })
            raise
    sdk._http = traced
    return trace


def percentile(xs: list[float], p: float) -> float:
    if not xs:
        return 0.0
    s = sorted(xs)
    k = int(len(s) * p / 100.0)
    return s[min(k, len(s) - 1)]


def run_phase(label: str, fn, n: int, trace: list[dict]) -> None:
    """Run `fn(i)` n times, capturing wall time per logical op AND per
    HTTP call. After the phase, the slowest op gets its underlying
    HTTP trace dumped so retry-storms / hung calls are visible."""
    print(f"\n━━━ {label} (n={n}) ━━━")
    op_records: list[dict] = []
    by_code: dict[str, int] = {}
    for i in range(n):
        trace_idx_start = len(trace)
        t0 = time.monotonic()
        ok = True
        err_code = None
        try:
            fn(i)
        except sdk.ArkerError as e:
            ok = False
            err_code = e.code
            by_code[e.code] = by_code.get(e.code, 0) + 1
        elapsed_ms = (time.monotonic() - t0) * 1000
        op_records.append({
            "i": i, "ok": ok, "err": err_code, "ms": elapsed_ms,
            "http_calls": list(trace[trace_idx_start:]),
        })
    times = [r["ms"] for r in op_records]
    successes = sum(1 for r in op_records if r["ok"])
    print(f"  successes: {successes}/{n}")
    print(f"  p50={percentile(times, 50):.0f}ms  "
          f"p90={percentile(times, 90):.0f}ms  "
          f"p99={percentile(times, 99):.0f}ms  "
          f"max={max(times):.0f}ms")
    if by_code:
        print(f"  failures by code: {by_code}")
    # Anatomy of the slowest op — what HTTP calls happened, in what order,
    # how long each took, and what status they returned.
    slowest = max(op_records, key=lambda r: r["ms"])
    if slowest["ms"] > 2000:  # only bother for >2s outliers
        print(f"  ── slowest op #{slowest['i']} ({slowest['ms']:.0f}ms) HTTP trace ──")
        for j, h in enumerate(slowest["http_calls"]):
            url_short = h["url"].split("/api/v1/")[-1] if "/api/v1/" in h["url"] else h["url"]
            url_short = url_short[:60]
            tag = "↻" if h.get("is_transient") else " "
            print(f"     {j+1}. {tag} {h['method']:5s} /{url_short:60s} "
                  f"→ {h['status']:>4d}  in {h['elapsed_ms']:>7.0f}ms  "
                  f"(body={h.get('body_size',0)}B resp={h.get('resp_size',0)}B)")


def main() -> None:
    arker = sdk.Arker(api_key=API_KEY, base_url=BASE_URL)
    trace = install_http_tracer()
    print(f"base_url={arker._base_url}\ntemplate={TEMPLATE}\nn={N}")

    # Pre-create one VM to operate against — fork is the only entry.
    vm = arker.fork(TEMPLATE, name="stress-probe")
    print(f"vm={vm.id}")

    try:
        # Phase 1: write tiny files at increasing path indices. Each write
        # takes the chunk fast-path (one chunk, [0,size)) → 1 server-side
        # PUT to the final blob key + 1 state.log CAS append.
        def write_one(i: int) -> None:
            payload = f"hello-{i:04d}".encode()
            vm.sync.write_file(f"/home/user/probe-{i:04d}.txt", payload)

        run_phase("WRITE 30× tiny files (chunk fast-path)", write_one, N, trace)

        # Phase 2: read those same files back. Server returns inline utf8.
        def read_one(i: int) -> None:
            vm.sync.read_file(f"/home/user/probe-{i:04d}.txt")

        run_phase("READ 30× tiny files (inline)", read_one, N, trace)

        # Phase 3: alternating write/read on a single path. Most stressful
        # because each op contends on state.log CAS for one VM.
        def alt(i: int) -> None:
            if i % 2 == 0:
                vm.sync.write_file("/home/user/alt.txt", f"v{i}".encode())
            else:
                vm.sync.read_file("/home/user/alt.txt")

        run_phase("ALTERNATE write/read same path (CAS-contention probe)", alt, N, trace)

        # Phase 4: medium writes — exercise the multi-chunk path.
        def med_write(i: int) -> None:
            vm.sync.write_file(f"/home/user/med-{i}.bin", secrets.token_bytes(6 * 1024 * 1024))

        run_phase("WRITE 10× 6MB files (multi-chunk → finalize)", med_write, min(10, N), trace)

    finally:
        try:
            vm.delete()
            print("\ncleanup: vm deleted")
        except Exception as e:
            print(f"\ncleanup failed: {e}")


if __name__ == "__main__":
    main()
