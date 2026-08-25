#!/usr/bin/env python3
"""Churn short-lived GPU VMs across many threads, each running one Claude Code
agent session that generates and runs 1..N vLLM feature tests.

Each thread loops for the window: fork from the base -> one agent session ->
delete -> repeat. Keeping the VM lifecycle on the hot path is the point — it
measures fork latency, whether a deleted VM's GPU slice frees in time for the
next fork, and whether the credential policy survives fork inheritance.

Run via launch.py (builds the base first), or directly once a base exists:

    ./run_fleet_test.py --minutes 10 --tests-per-agent 3

Exits 0 regardless of findings — a measurement harness, not a gate.
"""

import argparse
import collections
import json
import os
import random
import sys
import threading
import time

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import arker_api as api  # noqa: E402
import base_spec as spec  # noqa: E402

EVENTS = os.environ.get("FLEET_EVENTS", "fleet_events.jsonl")

_lock = threading.Lock()

# Every VM this run forked and has not confirmed deleted; whatever is left at the
# end gets swept. Without it, a failed delete is forgotten and keeps its slice.
_vm_lock = threading.Lock()
_live_vms = set()


def track_vm(vm_id):
    with _vm_lock:
        _live_vms.add(vm_id)


def untrack_vm(vm_id):
    with _vm_lock:
        _live_vms.discard(vm_id)


def live_vms():
    with _vm_lock:
        return sorted(_live_vms)


def ev(kind, **kw):
    rec = {"t": time.time(), "ts": time.strftime("%H:%M:%S"), "kind": kind}
    rec.update(kw)
    with _lock:
        with open(EVENTS, "a") as f:
            f.write(json.dumps(rec) + "\n")


def backoff_for(e, floor=5.0):
    """Honour Retry-After, floored — else the retry storm becomes the load."""
    back = floor + random.random() * floor
    try:
        return max(back, float(e.retry_after or 0))
    except (TypeError, ValueError):
        return back


def run_agent_session(vm_id, thread_idx, cycle, features, args, stop, deadline,
                      vram_mib):
    """Detached agent session: one test per feature, then the marker.

    Success is the marker, not the exit code — `claude -p` exits 0 even after an
    API error.
    """
    tag = f"sess{cycle}"
    task = spec.feature_test_task(features, vram_mib, args.per_test_budget)
    t0 = time.time()
    try:
        api.run_sync_retry(vm_id, spec.detach(spec.claude_script(task, tag), tag),
                           session_idx=1, timeout=120)
    except api.ApiError as e:
        ev("task_launch_failed", thread=thread_idx, cycle=cycle,
           vm_id=vm_id, status=e.status, code=e.code)
        return False
    ev("task_launched", thread=thread_idx, cycle=cycle, vm_id=vm_id,
       n_tests=len(features), features=features, launch_secs=round(time.time() - t0, 1))

    while not stop.is_set():
        stop.wait(args.poll_secs)
        elapsed = time.time() - t0
        if elapsed > args.session_timeout or time.time() > deadline + args.grace:
            ev("task_timeout", thread=thread_idx, cycle=cycle, vm_id=vm_id,
               n_tests=len(features), features=features, waited=round(elapsed, 1))
            return False
        try:
            r = api.run_sync_retry(vm_id, spec.poll_cmd(tag), session_idx=4, timeout=60)
        except api.ApiError as e:
            ev("poll_error", thread=thread_idx, vm_id=vm_id, status=e.status)
            continue
        out = api.stdout_of(r).strip()
        if not out or "RUNNING" in out:
            continue

        rc = out.split()[0]
        log = ""
        try:
            log = api.stdout_of(api.run_sync_retry(
                vm_id, spec.collect_cmd(tag, 40), session_idx=4, timeout=90))
        except api.ApiError:
            pass
        ok = spec.MARKER in log
        ev("task_done", thread=thread_idx, cycle=cycle, vm_id=vm_id, rc=rc, ok=ok,
           total_secs=round(time.time() - t0, 1),
           n_tests=len(features), features=features, out=log[-500:])
        return ok
    ev("task_abandoned", thread=thread_idx, cycle=cycle, vm_id=vm_id,
       n_tests=len(features), features=features, waited=round(time.time() - t0, 1))
    return False


def churn_loop(thread_idx, base_vm_id, policy, args, deadline, stop, base_vram_mib):
    """One thread: fork -> one agent session (random 1..N feature tests) -> delete."""
    rng = random.Random(9000 + thread_idx)
    cycle = 0
    while not stop.is_set() and time.time() < deadline:
        cycle += 1
        name = f"{spec.PREFIX}-t{thread_idx}-c{cycle}"
        vm_id = None

        t_fork = time.time()
        try:
            vm = api.fork_vm(name, source_vm_id=base_vm_id,
                             resources={"vgpu": args.vgpu, "disk_mib": args.disk_mib},
                             policies=policy, timeout=args.fork_timeout)
            vm_id = vm.get("vm_id") or vm.get("id")
            track_vm(vm_id)
            vram_mib = spec.slice_mib(vm, base_vram_mib)
            ev("fork_ok", thread=thread_idx, cycle=cycle, vm_id=vm_id, name=name,
               fork_secs=round(time.time() - t_fork, 1))
        except api.ApiError as e:
            # 429 = your API concurrency limit; the fork never reached a GPU.
            # 503 = no GPU slice free in time — typically the previous VM's slice
            #       has not been released yet when the next fork asks for one.
            ev("fork_rejected", thread=thread_idx, cycle=cycle, status=e.status,
               code=e.code, waited=round(time.time() - t_fork, 1))
            stop.wait(backoff_for(e))
            continue

        try:
            # Rotated so coverage spreads across sessions rather than always #1.
            n = rng.randint(1, max(1, args.tests_per_agent))
            F = spec.CRITICAL_FEATURES
            features = [F[(thread_idx + cycle + i) % len(F)] for i in range(n)]
            ev("cycle_start", thread=thread_idx, cycle=cycle, vm_id=vm_id, n_tests=n)
            done = 1 if (not stop.is_set() and time.time() <= deadline and
                         run_agent_session(vm_id, thread_idx, cycle, features, args,
                                           stop, deadline, vram_mib)) else 0
            ev("cycle_done", thread=thread_idx, cycle=cycle, vm_id=vm_id,
               n_tests=n, ok_tasks=done)
        finally:
            # Always delete, even on interrupt — a leaked VM holds its GPU slice.
            # Retried; anything still undeleted is caught by the sweep at the end.
            if vm_id:
                t_del = time.time()
                err = api.delete_vm_retry(vm_id)
                if err is None:
                    untrack_vm(vm_id)
                    ev("deleted", thread=thread_idx, cycle=cycle, vm_id=vm_id,
                       delete_secs=round(time.time() - t_del, 1))
                else:
                    ev("delete_failed", thread=thread_idx, cycle=cycle, vm_id=vm_id,
                       status=err.status, code=err.code)


def sweep_leftovers():
    """Delete every VM this run created that is still alive. Returns the failures.

    The per-cycle delete already retries, so anything here has survived several
    attempts — and this run is the only thing that knows these VMs exist.
    """
    left = live_vms()
    if not left:
        return []
    print(f"\nsweeping {len(left)} VM(s) not deleted during the run...")
    failed = []

    # Concurrent: run sequentially, the retry chains would outlast the test.
    def sweep_one(vm_id):
        err = api.delete_vm_retry(vm_id, attempts=10, floor=3.0)
        if err is None:
            untrack_vm(vm_id)
            ev("swept", vm_id=vm_id)
            print(f"   deleted {vm_id}")
        else:
            failed.append((vm_id, err))
            ev("sweep_failed", vm_id=vm_id, status=err.status, code=err.code)
            print(f"   FAILED  {vm_id} ({err.status} {err.code})")

    workers = [threading.Thread(target=sweep_one, args=(v,)) for v in left]
    for w in workers:
        w.start()
    for w in workers:
        w.join()
    return failed


def pct(vals, p):
    if not vals:
        return 0.0
    s = sorted(vals)
    return s[min(len(s) - 1, int(len(s) * p))]


def report(path, window_min):
    # A zero-length window would divide by zero below.
    rate = (lambda n: f"{n / window_min:.2f}/min") if window_min > 0 else (lambda n: "n/a")
    if not os.path.exists(path):
        raise SystemExit(f"no event log at {path} — run the churn test first, or point "
                         f"FLEET_EVENTS at a log you kept.")
    rows = []
    with open(path) as f:
        for line in f:
            line = line.strip()
            if line:
                try:
                    rows.append(json.loads(line))
                except Exception:
                    pass
    starts = [r for r in rows if r["kind"] == "start"]
    t0 = starts[-1]["t"] if starts else 0
    rows = [r for r in rows if r["t"] >= t0]
    cfg = starts[-1] if starts else {}

    forks = [r for r in rows if r["kind"] == "fork_ok"]
    rej = [r for r in rows if r["kind"] == "fork_rejected"]
    dels = [r for r in rows if r["kind"] == "deleted"]
    del_fail = [r for r in rows if r["kind"] == "delete_failed"]
    swept = [r for r in rows if r["kind"] == "swept"]
    sweep_fail = [r for r in rows if r["kind"] == "sweep_failed"]
    cycles = [r for r in rows if r["kind"] == "cycle_done"]
    tasks = [r for r in rows if r["kind"] == "task_done"]
    ok = [r for r in tasks if r.get("ok")]
    tmo = [r for r in rows if r["kind"] == "task_timeout"]
    lfail = [r for r in rows if r["kind"] == "task_launch_failed"]
    launched = [r for r in rows if r["kind"] == "task_launched"]
    aband = [r for r in rows if r["kind"] == "task_abandoned"]
    threads = sorted({r["thread"] for r in rows if "thread" in r})

    print("\n" + "=" * 66)
    print(f"vLLM AGENT CHURN — {cfg.get('threads', len(threads))} threads, "
          f"{window_min:.0f} min window")
    print(f"1..{cfg.get('tests_per_agent','?')} feature-tests per agent session, "
          f"slice vgpu={cfg.get('vgpu','?')} "
          f"({cfg.get('vram_mib','?')} MiB resolved)")
    print("=" * 66)

    print("\nVM LIFECYCLE")
    print(f"  forks succeeded      : {len(forks)}   ({rate(len(forks))})")
    gpu_rej = [r for r in rej if r.get("status") == 503]
    api_rej = [r for r in rej if r.get("status") == 429]
    other = [r for r in rej if r.get("status") not in (503, 429)]
    print(f"  503 no GPU slice     : {len(gpu_rej)}   (none free when the fork asked)")
    print(f"  429 API concurrency  : {len(api_rej)}   (your concurrency limit)")
    if other:
        print(f"  other fork failures  : {len(other)}   "
              f"{collections.Counter(r.get('status') for r in other)}")
    print(f"  deleted              : {len(dels)}"
          + (f"   ({len(del_fail)} still undeleted after retries)" if del_fail else ""))
    if swept:
        print(f"  swept at end         : {len(swept)}   (missed by their own cycle)")
    leaked = len(forks) - len(dels) - len(swept)
    if leaked > 0:
        print(f"  *** {leaked} VM(s) NOT deleted — each still holds a GPU slice ***")
        for r in sweep_fail:
            print(f"        {r.get('vm_id')}  ({r.get('status')} {r.get('code')})")
        print(f"      delete them with:")
        print(f"        python3 -c \"import arker_api as a; "
              f"a.delete_vm_retry('<vm_id>')\"")
    if forks:
        f_lat = [r["fork_secs"] for r in forks]
        print(f"  fork latency         : p50={pct(f_lat,.5):.1f}s "
              f"p90={pct(f_lat,.9):.1f}s max={max(f_lat):.1f}s")
    if dels:
        d_lat = [r["delete_secs"] for r in dels]
        print(f"  delete latency       : p50={pct(d_lat,.5):.1f}s max={max(d_lat):.1f}s")

    print("\nAGENT TASKS")
    print(f"  launched             : {len(launched)}")
    print(f"  SUCCEEDED (marker)   : {len(ok)}   ({rate(len(ok))})")
    print(f"  completed w/o marker : {len(tasks) - len(ok)}")
    print(f"  timed out            : {len(tmo)}")
    if aband:
        w = [r["waited"] for r in aband]
        print(f"  STILL RUNNING at end : {len(aband)}   (max {max(w):.0f}s in flight)")
        print("      -> the window was too short for this workload, NOT a failure;")
        print("         raise --minutes or lower --per-test-budget before reading throughput")
    if lfail:
        print(f"  launch failed        : {len(lfail)}")
    if ok:
        t_lat = [r["total_secs"] for r in ok]
        print(f"  task wall time       : p50={pct(t_lat,.5):.0f}s "
              f"p90={pct(t_lat,.9):.0f}s max={max(t_lat):.0f}s")
    if cycles:
        print(f"  cycles completed     : {len(cycles)}   "
              f"(avg {sum(c['ok_tasks'] for c in cycles)/len(cycles):.1f} ok tasks/VM)")

    if not forks:
        print("\n*** NO VM WAS EVER FORKED — this is not a throughput measurement. ***")
        print("    Every fork was rejected, so the per-thread counts below are zero")
        print("    by construction. Check the base VM and the GPU slot ledger.")

    print("\nFAIRNESS — per thread (forks / ok tasks):")
    f_by = collections.Counter(r["thread"] for r in forks)
    o_by = collections.Counter(r["thread"] for r in ok)
    for t in threads:
        print(f"   thread {t:<2d}  forks={f_by.get(t,0):<4d} ok_tasks={o_by.get(t,0)}")
    starved = [t for t in threads if o_by.get(t, 0) == 0]
    if starved and forks:
        print(f"\n   NO SUCCESSFUL TASK on thread(s): "
              f"{', '.join(str(x) for x in starved)}")

    if ok:
        feat_counts = collections.Counter(
            f for r in ok for f in (r.get("features") or []))
        print("\nCRITICAL FEATURES exercised (across completed sessions):")
        for feat, c in feat_counts.most_common():
            print(f"   {c:>3d}x  {str(feat)[:70]}")
    print("=" * 66 + "\n")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--minutes", type=float, default=10,
                    help="wall-clock window each thread churns for")
    ap.add_argument("--threads", type=int, default=8,
                    help="concurrent churn threads (default 8 = one per GPU slice)")
    ap.add_argument("--tests-per-agent", type=int, default=3, metavar="N",
                    help="each session runs a RANDOM 1..N feature tests (one per curated "
                         "vLLM feature), seeded per thread. Each loads vLLM in a fresh "
                         "process, so keep N modest.")
    ap.add_argument("--vgpu", type=float, default=spec.VGPU,
                    help="GPU slice per forked VM, as a fraction of one card in eighths "
                         "(0.125 … 1.0). At the 0.125 default, 8 threads fill one card.")
    ap.add_argument("--disk-mib", type=int, default=spec.DISK_MIB,
                    help="guest disk quota per forked VM; must fit the base rootfs "
                         "(vLLM + staged model, ~12 GiB).")
    ap.add_argument("--session-timeout", type=int, default=1200,
                    help="give up on a session after this long; scale with --tests-per-agent "
                         "(runs detached, so not bounded by the synchronous-exec cap)")
    ap.add_argument("--per-test-budget", type=int, default=180,
                    help="per-test runtime budget written into the prompt so N tests fit "
                         "within --session-timeout")
    ap.add_argument("--fork-timeout", type=int, default=300)
    ap.add_argument("--poll-secs", type=int, default=15)
    ap.add_argument("--grace", type=int, default=180,
                    help="how long past the deadline a task may still finish")
    ap.add_argument("--report-only", action="store_true")
    args = ap.parse_args()

    if not (0.125 <= args.vgpu <= 1.0) or round(args.vgpu * 8) != args.vgpu * 8:
        raise SystemExit(f"--vgpu must be a multiple of 0.125 in [0.125, 1.0]; got {args.vgpu}")

    if args.report_only:
        report(EVENTS, args.minutes)
        return

    real_key = os.environ.get("ARKER_ANTHROPIC_API_KEY", "")
    if not real_key:
        raise SystemExit(
            "ARKER_ANTHROPIC_API_KEY must be set — the harness injects it via the "
            "per-fork policy. It is never written into any guest."
        )

    with open(spec.BASE_FILE) as f:
        base = json.load(f)
    base_vm_id = base["base_vm_id"]

    # Numbers off an unverified base would read like a platform verdict rather
    # than a setup problem — every task 401s identically.
    if base.get("rewrite_verified") is not True:
        raise SystemExit("base.json does not record rewrite_verified=true — rebuild with "
                         "setup_base.py (an unverified base makes every task 401 "
                         "identically, which reads like a platform verdict)")

    # A cheap GET first: "no GPU was ever free" and "the base is gone" otherwise
    # produce identical empty reports.
    try:
        api.get_vm(base_vm_id)
    except api.ApiError as e:
        raise SystemExit(
            f"PREFLIGHT FAILED: base VM {base_vm_id} unreachable ({e.status} {e.code}).\n"
            "Rebuild the base with setup_base.py."
        )

    policy = spec.policy_doc(real_key)
    base_vram_mib = base.get("resolved_gpu_vram_mib")
    print(f"churning {args.threads} threads for {args.minutes} min "
          f"(1..{args.tests_per_agent} feature-tests per agent session); events -> {EVENTS}")
    print(f"base={base_vm_id} slice=vgpu{args.vgpu} ({base_vram_mib or '?'} MiB) "
          f"model={base.get('model_id')}")

    ev("start", threads=args.threads, minutes=args.minutes,
       tests_per_agent=args.tests_per_agent, vgpu=args.vgpu, vram_mib=base_vram_mib,
       disk_mib=args.disk_mib, base_vm_id=base_vm_id,
       session_timeout=args.session_timeout, per_test_budget=args.per_test_budget)

    deadline = time.time() + args.minutes * 60
    stop = threading.Event()
    threads = [
        threading.Thread(target=churn_loop,
                         args=(i, base_vm_id, policy, args, deadline, stop, base_vram_mib),
                         daemon=True)
        for i in range(args.threads)
    ]
    for t in threads:
        t.start()
    try:
        while time.time() < deadline and any(t.is_alive() for t in threads):
            time.sleep(5)
    except KeyboardInterrupt:
        print("interrupted — draining and deleting VMs")
    stop.set()
    # Generous: threads are mid-cycle and must still delete their VM.
    for t in threads:
        t.join(timeout=args.grace + 120)
    ev("end")
    # Before the report, so its numbers describe the final state.
    sweep_leftovers()
    report(EVENTS, args.minutes)


if __name__ == "__main__":
    main()
