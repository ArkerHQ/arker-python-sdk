#!/usr/bin/env python3
"""One-touch launch: build the base VM if needed, then run the churn test.

    export ARKER_API_KEY=...                   # Arker account key
    export ARKER_ANTHROPIC_API_KEY=sk-ant-...  # injected by policy, never seen by a guest
    ./launch.py --minutes 10 --threads 8 --tests-per-agent 3

setup_base.py builds and verifies the base; run_fleet_test.py then churns agent
sessions against it, handed over via base.json.

Every VM is deleted when the test finishes — including after a failure or a
Ctrl-C. --keep-base keeps the base for the next run to reuse.
"""

import argparse
import json
import os
import subprocess
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import arker_api as api  # noqa: E402
import base_spec as spec  # noqa: E402

REQUIRED_ENV = ("ARKER_API_KEY", "ARKER_ANTHROPIC_API_KEY")


def base_is_reusable():
    """True iff base.json exists, its rewrite was verified, and the VM is live.

    An unverified base 401s every task and a missing one 503s every fork, so
    rebuilding beats a run that cannot progress.
    """
    if not os.path.exists(spec.BASE_FILE):
        return False, "no base.json"
    try:
        with open(spec.BASE_FILE) as f:
            base = json.load(f)
    except (OSError, ValueError) as e:
        return False, f"unreadable base.json ({e})"
    vm_id = base.get("base_vm_id")
    if not vm_id:
        return False, "base.json has no base_vm_id"
    if base.get("rewrite_verified") is not True:
        return False, "base.json rewrite_verified != true"
    try:
        api.get_vm(vm_id)
    except api.ApiError as e:
        return False, f"base VM {vm_id} unreachable ({e.status} {e.code})"
    return True, vm_id


def read_base_id():
    """The base VM id setup_base.py recorded, or None."""
    try:
        with open(spec.BASE_FILE) as f:
            return json.load(f).get("base_vm_id")
    except (OSError, ValueError):
        return None


def delete_base(vm_id):
    """Delete the base VM and drop the handoff file that names it.

    Runs even after a failed or interrupted churn test — the base holds a GPU
    slice for as long as it exists.
    """
    print(f"\n== delete base {vm_id} ==")
    err = api.delete_vm_retry(vm_id, attempts=10, floor=3.0)
    if err is not None:
        print(f"   FAILED ({err.status} {err.code}) — it still holds a GPU slice; "
              f"delete it manually:")
        print(f"   python3 -c \"import arker_api as a; a.delete_vm_retry('{vm_id}')\"")
        return
    print("   deleted")
    try:
        os.remove(spec.BASE_FILE)
    except OSError:
        pass


def main():
    ap = argparse.ArgumentParser(
        description="One-touch: build (or reuse) the base VM, then run the 8-thread churn test.")
    # forwarded to run_fleet_test.py
    ap.add_argument("--minutes", type=float, default=10)
    ap.add_argument("--threads", type=int, default=8)
    ap.add_argument("--tests-per-agent", type=int, default=3, metavar="N")
    # forwarded to both the base build and each child fork
    ap.add_argument("--vgpu", type=float, default=spec.VGPU,
                    help="GPU slice as a fraction of one card, in eighths (0.125 … 1.0)")
    ap.add_argument("--disk-mib", type=int, default=spec.DISK_MIB)
    # base only
    ap.add_argument("--memory-mib", type=int, default=spec.MEMORY_MIB,
                    help="RAM for the base VM (children inherit)")
    ap.add_argument("--rebuild-base", action="store_true",
                    help="force a fresh base even if a verified one is reachable")
    ap.add_argument("--keep-base", action="store_true",
                    help="do NOT delete the base VM at the end; it keeps holding a GPU "
                         "slice, but the next run reuses it instead of rebuilding")
    args = ap.parse_args()

    # Exported, not just defaulted in-process, so the child scripts inherit the
    # same endpoint rather than each re-deriving it.
    if not os.environ.get("ARKER_BASE_URL"):
        os.environ["ARKER_BASE_URL"] = api.DEFAULT_BASE_URL
        api.BASE = api._base_url()      # arker_api resolved BASE at import
        print(f"ARKER_BASE_URL not set — using {api.DEFAULT_BASE_URL}")

    missing = [k for k in REQUIRED_ENV if not os.environ.get(k)]
    if missing:
        raise SystemExit(
            "missing env: " + ", ".join(missing) + "\n"
            "  export ARKER_API_KEY=<your-arker-api-key>\n"
            "  export ARKER_ANTHROPIC_API_KEY=sk-ant-...   # injected by policy, never seen by a guest\n"
            f"  export ARKER_BASE_URL=...   # optional, defaults to {api.DEFAULT_BASE_URL}")

    py = sys.executable

    # ── stage 1: base ────────────────────────────────────────────────────────
    if args.rebuild_base:
        reuse, why = False, "rebuild forced"
    else:
        reuse, why = base_is_reusable()
    if reuse:
        print(f"== reuse base {why} (skip build; --rebuild-base to force) ==")
    else:
        print(f"== build base ({why}) ==")
        rc = subprocess.call([py, os.path.join(HERE, "setup_base.py"),
                              "--vgpu", str(args.vgpu),
                              "--disk-mib", str(args.disk_mib),
                              "--memory-mib", str(args.memory_mib)])
        if rc != 0:
            raise SystemExit(
                f"base build failed (exit {rc}); see the tail above — the harness will "
                f"not run off an unverified base.\nThe partly-built base VM is left "
                f"running so you can retry without re-installing; delete it yourself if "
                f"you are not retrying (see README 'Tear down').")

    # ── stage 2: churn ───────────────────────────────────────────────────────
    base_vm_id = read_base_id()
    print(f"\n== run churn test: {args.threads} threads x {args.minutes} min ==")
    proc = subprocess.Popen([py, os.path.join(HERE, "run_fleet_test.py"),
                             "--minutes", str(args.minutes),
                             "--threads", str(args.threads),
                             "--tests-per-agent", str(args.tests_per_agent),
                             "--vgpu", str(args.vgpu),
                             "--disk-mib", str(args.disk_mib)])
    try:
        try:
            rc = proc.wait()
        except KeyboardInterrupt:
            # Ctrl-C already reached the child through the process group. Let it
            # delete its own VMs before removing the base they forked from.
            print("\ninterrupted — waiting for the churn test to delete its VMs")
            try:
                rc = proc.wait(timeout=300)
            except subprocess.TimeoutExpired:
                proc.kill()
                rc = 130
    finally:
        # ── stage 3: tear down ───────────────────────────────────────────────
        if not base_vm_id:
            print(f"\ncould not read a base VM id from {spec.BASE_FILE}; "
                  f"check for a leftover base VM.")
        elif args.keep_base:
            print(f"\nbase {base_vm_id} kept (--keep-base). It holds a GPU slice until "
                  f"you delete it; the next run will reuse it.")
        else:
            delete_base(base_vm_id)
    raise SystemExit(rc)


if __name__ == "__main__":
    main()
