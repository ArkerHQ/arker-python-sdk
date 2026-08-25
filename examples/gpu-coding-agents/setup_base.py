#!/usr/bin/env python3
"""Build the BASE VM the churn test forks from, and write base.json.

    1. fork ubuntu-gpu with the outbound policy attached
    2. seed the guest env with a DUMMY Anthropic key
    3. install what the golden lacks (vLLM + dev headers), pre-stage the model
    4. verify the credential rewrite with one real `claude -p`
    5. verify vLLM stands up on the slice

    export ARKER_API_KEY=...  ARKER_ANTHROPIC_API_KEY=sk-ant-...
    ./setup_base.py [--vgpu 0.125]

Step 4 makes the agent write AND execute a file: a chat-only prompt would pass
even with tools broken, and a 401 there means the rewrite never applied.
"""

import argparse
import json
import os
import sys
import time

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import arker_api as api  # noqa: E402
import base_spec as spec  # noqa: E402

VERIFY_TASK = (
    "Create a file named toolcheck.py containing exactly "
    "print('ARKER_AGENT_OK'), then run it with python3 and show the output."
)


def wait_marker(vm_id, tag, timeout_s, label, poll_s=20):
    """Poll a detached job's marker file. Returns (rc, elapsed); rc is None on timeout."""
    t0 = time.time()
    while time.time() - t0 < timeout_s:
        time.sleep(poll_s)
        try:
            r = api.run_sync_retry(vm_id, spec.poll_cmd(tag), session_idx=4, timeout=60)
        except api.ApiError as e:
            print(f"   {label}: poll error {e.status}")
            continue
        out = api.stdout_of(r).strip()
        if out and "RUNNING" not in out:
            return out.split()[0], int(time.time() - t0)
        el = int(time.time() - t0)
        if el % 120 < poll_s:
            print(f"   {label}: {el}s elapsed…", flush=True)
    return None, int(time.time() - t0)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--vgpu", type=float, default=spec.VGPU,
                    help="GPU slice as a fraction of one card, in eighths "
                         "(0.125 … 1.0). The only GPU sizing a fork accepts.")
    ap.add_argument("--memory-mib", type=int, default=spec.MEMORY_MIB)
    ap.add_argument("--disk-mib", type=int, default=spec.DISK_MIB,
                    help="guest disk quota; vLLM + torch + the model need ~12 GiB, and "
                         "running out mid-install reads as a hang")
    ap.add_argument("--vcpu", type=int, default=2)
    ap.add_argument("--install-timeout", type=int, default=3600)
    ap.add_argument("--verify-timeout", type=int, default=900)
    args = ap.parse_args()

    # Caught here rather than as a 422 on the first call.
    if not (0.125 <= args.vgpu <= 1.0) or round(args.vgpu * 8) != args.vgpu * 8:
        raise SystemExit(f"--vgpu must be a multiple of 0.125 in [0.125, 1.0]; got {args.vgpu}")

    real_key = os.environ.get("ARKER_ANTHROPIC_API_KEY", "")
    if not real_key:
        raise SystemExit(
            "ARKER_ANTHROPIC_API_KEY must be set — the policy injects it; "
            "only the dummy is ever written into the guest."
        )

    resources = {
        "vcpu": args.vcpu,
        "memory_mib": args.memory_mib,
        "disk_mib": args.disk_mib,
        "vgpu": args.vgpu,
    }
    policy = spec.policy_doc(real_key)

    org = f" (org {spec.GOLDEN_ORG})" if spec.GOLDEN_ORG else ""
    plats = ", ".join(spec.PLATFORMS) if spec.PLATFORMS else "auto"
    print(f"== 1/5 fork base from {spec.GOLDEN}{org} on [{plats}] ==")
    print(f"   resources={resources}")
    print(f"   policy: rewrite x-api-key on api.anthropic.com <- ${{secret:{spec.SECRET_NAME}}}")
    t0 = time.time()
    vm = api.fork_vm(f"{spec.PREFIX}-base", source_name=spec.GOLDEN,
                     source_org_id=spec.GOLDEN_ORG or None,
                     resources=resources, platforms=spec.PLATFORMS or None,
                     policies=policy)
    base = vm["vm_id"]
    vram_mib = spec.slice_mib(vm)
    got = vm.get("resources") or {}
    print(f"   base -> {base} in {time.time()-t0:.1f}s")
    print(f"   landed on {vm.get('platform')}")
    print(f"   slice: vgpu={args.vgpu} -> {vram_mib} MiB / {got.get('gpu_sms')} SMs")

    # Prove the secret is stored masked before anything else logs it.
    echoed = api.get_policies(base)
    secrets = echoed.get("secrets", {})
    print(f"   stored secrets (must be masked): {json.dumps(secrets)}")
    if real_key in json.dumps(echoed):
        raise SystemExit("FAIL: the real key came back UNMASKED from GET /policies — stop.")

    print("\n== 2/5 seed guest env with the DUMMY key ==")
    r = api.run_sync_retry(base, spec.ENV_SH.format(key=spec.DUMMY_KEY),
                           session_idx=3, timeout=90)
    print(f"   exit={r.get('exit_code')} {api.stdout_of(r).strip()[:80]}")

    print("\n== 3/5 install vLLM + stage model (detached; claude-code ships with the golden) ==")
    print(f"   model {spec.MODEL_ID} -> {spec.MODEL_DIR}")
    api.run_sync_retry(base, spec.detach(spec.INSTALL, "install"),
                       session_idx=2, timeout=120)
    rc, secs = wait_marker(base, "install", args.install_timeout, "install")
    log = api.stdout_of(api.run_sync_retry(base, spec.collect_cmd("install", 25),
                                           session_idx=2, timeout=90))
    print(f"   install finished after {secs}s rc={rc}")
    print("   " + log.strip().replace("\n", "\n   ")[-1200:])
    if rc is None:
        raise SystemExit(
            f"FAIL: install did not finish within {args.install_timeout}s.\n"
            f"Check the tail for `No space left on device`: disk is {args.disk_mib} MiB, "
            f"the install needs ~12 GiB, and ENOSPC truncates the log so the last line "
            f"may mislead."
        )
    if rc != "0":
        print(f"   WARNING: install exited rc={rc}; the checks below decide usability")

    check = api.stdout_of(api.run_sync_retry(
        base,
        f". {spec.AGENT}/env.sh; "
        f"command -v claude >/dev/null && echo CLAUDE_OK || echo NO_CLAUDE; "
        f"python3 -c 'import vllm' 2>/dev/null && echo VLLM_OK || echo NO_VLLM; "
        # Real weights, not just the directory: INSTALL creates MODEL_DIR up front,
        # so `test -d` would pass even on a failed download.
        f"test -s {spec.MODEL_DIR}/config.json "
        f"&& ( ls {spec.MODEL_DIR}/*.safetensors >/dev/null 2>&1 "
        f"|| ls {spec.MODEL_DIR}/*.bin >/dev/null 2>&1 ) "
        f"&& echo MODEL_OK || echo NO_MODEL",
        session_idx=2, timeout=180))
    print(f"   toolchain: {check.strip().replace(chr(10), '  ')}")
    for missing in ("NO_CLAUDE", "NO_VLLM", "NO_MODEL"):
        if missing in check:
            raise SystemExit(f"FAIL: {missing} — base is not usable; fix before forking.")

    print("\n== 4/5 verify: dummy key in guest + policy rewrite -> real call ==")
    api.run_sync_retry(base, spec.detach(spec.claude_script(VERIFY_TASK, "verify"), "verify"),
                       session_idx=1, timeout=120)
    rc, secs = wait_marker(base, "verify", args.verify_timeout, "verify", poll_s=15)
    out = api.stdout_of(api.run_sync_retry(base, spec.collect_cmd("verify", 40),
                                           session_idx=1, timeout=90))
    print(f"   verify finished after {secs}s rc={rc}")
    print("   " + out.strip().replace("\n", "\n   ")[-1000:])

    if "ARKER_AGENT_OK" not in out:
        raise SystemExit(
            "FAIL: the agent did not complete a tool-using task. Two likely causes:\n"
            "  * 401/authentication_error -> the policy rewrite did not apply; check that\n"
            "    ARKER_ANTHROPIC_API_KEY is a valid key and was attached at fork.\n"
            "  * permission/tool errors   -> IS_SANDBOX=1 missing from env.sh.\n"
            f"The base VM {base} is left running so you can retry without re-installing."
        )

    print("\n== 5/5 verify vLLM can STAND UP on the GPU slice ==")
    api.run_sync_retry(base, spec.detach(spec.VLLM_SMOKE, "vllm"), session_idx=2, timeout=120)
    rc, secs = wait_marker(base, "vllm", args.verify_timeout, "vllm-smoke", poll_s=15)
    vout = api.stdout_of(api.run_sync_retry(base, spec.collect_cmd("vllm", 30),
                                            session_idx=2, timeout=90))
    print(f"   vllm smoke finished after {secs}s rc={rc}")
    print("   " + vout.strip().replace("\n", "\n   ")[-900:])
    if spec.VLLM_OK_MARKER not in vout:
        raise SystemExit(
            "FAIL: vLLM did not initialize on the GPU. Common causes:\n"
            "  * 'Python.h: No such file' -> python3-dev missing (Triton JIT). INSTALL adds it.\n"
            "  * 'Could not find nvcc'     -> flashinfer JIT; env.sh sets "
            "VLLM_USE_FLASHINFER_SAMPLER=0 to avoid it.\n"
            f"The base VM {base} is left running so you can inspect /root/agent/vllm.log."
        )
    print("   VERIFIED: vLLM engine initialized and generated on the slice")

    base_rec = {
        "base_vm_id": base,
        "resources": resources,
        "vgpu": args.vgpu,
        "resolved_gpu_vram_mib": vram_mib,
        "resolved_gpu_sms": got.get("gpu_sms"),
        "golden": spec.GOLDEN,
        # What it landed on, not what was allowed.
        "platform": vm.get("platform"),
        "allowed_platforms": spec.PLATFORMS,
        "model_id": spec.MODEL_ID,
        "model_dir": spec.MODEL_DIR,
        # Lets the harness refuse a base whose rewrite was never proven.
        "rewrite_verified": True,
        "built_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
    }
    with open(spec.BASE_FILE, "w") as f:
        json.dump(base_rec, f, indent=2)

    print(f"\nVERIFIED: guest held only the dummy key and the call succeeded —")
    print(f"          the outbound rewrite is live.")
    print(f"wrote {spec.BASE_FILE}")
    print(f"\nbase ready — run: ./run_fleet_test.py --minutes 10 --tests-per-agent 3")
    print(f"NOTE: base VM {base} stays running so forks are instant. launch.py deletes "
          f"it at the end of a run; if you drive run_fleet_test.py yourself, delete it "
          f"when you are done — see README 'Tear down'.")


if __name__ == "__main__":
    main()
