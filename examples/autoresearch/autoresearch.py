#!/usr/bin/env python3
"""Agent-driven hyperparameter search on Arker GPUs, via the Python SDK.

    VGPUS=0.25          autoresearch.py    # one config: 4 agents x 0.25 vGPU
    VGPUS=0.25,1.0      autoresearch.py    # both, one after the other, then the chart
    AGENTS=4 TURNS=8 VGPUS=0.25,0.5,1.0 autoresearch.py

VGPUS is the whole interface: each fraction runs as its own config, one at a
time (each needs the host to itself or the comparison means nothing), and the
chart comparing them is drawn at the end. Every turn also rewrites
vgpu<x>.json and progress-vgpu<x>.png, so an interrupted run still leaves its
results behind.

Three Arker calls carry the whole demo:

    fork()    one prep VM installs the toolchain; every agent is a
              copy-on-write fork of it, ready in seconds
    run()     each turn is one exec inside an agent's VM
    delete()  agents clean themselves up, prep goes last

The point of comparing fractions: `vgpu=0.25` gives four agents one H100
between them and they genuinely run at the same time; `vgpu=1.0` gives each
agent a whole card, so on a 2-GPU host they queue — the platform hands the
card over as each run finishes, with no orchestration from this script. Same
experiments, same hardware; the chart shows what that costs in wall clock.

Everything that is not an Arker call — the task, the prep recipe, the run
folder, the logging, the chart — lives in lab.py.

Demo code: the success path only. On a busy host these calls can return a
retryable 503; production callers should retry it (the SDK already polls
background acks for you).
"""
import time
from concurrent.futures import ThreadPoolExecutor

from lab import (AGENTS, PLATFORM, READ_RESULTS, RUN, SETUP_STAGES, STAGE_PREFIX,
                 TURNS, VGPUS, WRITE_TASK, begin_config, chart, log, parse_runs, timeline,
                 prep_ready, save_summary, turn_command, turn_done, turn_started)


def prepare(ark) -> object:
    """Fork one VM and install the toolchain on it. Every agent forks from this."""
    prep = ark.fork(source_vm_name="ubuntu-gpu", platforms=[PLATFORM], name="prep",
                    vgpu=0.25, vcpu_count=2, memory_mib=15360, disk_mib=51200)
    log(f"prep {prep.id[-6:]} forked — installing the toolchain")

    for i, (name, script) in enumerate(SETUP_STAGES, 1):
        started = time.time()
        log(f"  prep [{i}/{len(SETUP_STAGES)}] {name} …")
        out = prep.run(STAGE_PREFIX + script).stdout.strip().splitlines()
        log(f"  prep [{i}/{len(SETUP_STAGES)}] {name} done — {time.time()-started:.0f}s "
            f"{out[-1][:70] if out else ''}")

    prep.run(WRITE_TASK)   # every agent inherits it by forking
    prep_ready()
    log(f"prep ready — forking {AGENTS} agents")
    return prep


def run_agent(ark, prep, n: int, vgpu: float) -> list[dict]:
    """One agent: fork off prep, run TURNS turns, hand back its experiments."""
    vm = ark.fork(source=prep, name=f"agent{n}", vgpu=vgpu,
                  vcpu_count=2, memory_mib=15360, disk_mib=51200)
    for turn in range(1, TURNS + 1):
        turn_started(f"agent{n}", turn)
        # queueing_timeout is the only bound here: on a contended host the run
        # parks until a GPU slice frees, so a long turn means queueing, not a
        # slow model. Execution is unbounded — demo code assumes it succeeds.
        out = vm.run(turn_command(), queueing_timeout=900).stdout
        tsv = vm.run(READ_RESULTS).stdout
        # out carries the VM's exec-start stamp, which is how the queue wait
        # is measured rather than guessed
        turn_done(f"agent{n}", turn, tsv, out)   # also redraws progress-<config>.png

    experiments = parse_runs(vm.run(READ_RESULTS).stdout)
    vm.delete()
    log(f"agent{n} finished — {len(experiments)} experiments")
    return experiments


def run_config(vgpu: float) -> dict:
    """Run every agent at one GPU fraction, concurrently, and save the summary."""
    from arker import Arker

    ark = Arker()
    begin_config(vgpu)
    prep = prepare(ark)

    # All agents are submitted at once — no waves, no gating. When they ask for
    # more GPU than the host has, the platform queues them.
    with ThreadPoolExecutor(max_workers=AGENTS) as pool:
        futures = {n: pool.submit(run_agent, ark, prep, n, vgpu)
                   for n in range(1, AGENTS + 1)}
        agents = {f"agent{n}": f.result() for n, f in futures.items()}

    prep.delete()  # last: the forks' parent
    return save_summary(vgpu, agents)


if __name__ == "__main__":
    RUN.mkdir(parents=True, exist_ok=True)
    print(f"results -> {RUN}")
    for vgpu in VGPUS:
        run_config(vgpu)
    chart(str(RUN))
    timeline(str(RUN))
