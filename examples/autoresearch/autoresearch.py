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

Four things the platform does carry the whole demo:

    fork()      one prep VM installs the toolchain once (~4 min); every agent
                is a copy-on-write fork of it, ready in about a second
    run()       each turn is one exec inside an agent's VM; every run is its
                own process, so each command carries its own environment
    policies=   the OpenRouter key goes to the platform, not the VM. It is
                spliced into the agent's requests on their way out, so the key
                never exists inside the machine that uses it
    delete()    agents clean themselves up, prep goes last

The point of comparing fractions: `vgpu=0.25` gives four agents one H100
between them and they genuinely run at the same time; `vgpu=1.0` gives each
agent a whole card, so on a 2-GPU host they queue — the platform hands the
card over as each run finishes, with no orchestration from this script. Same
experiments, same hardware; the chart shows what that costs in wall clock.

Everything that is not an Arker call — the task, the prep recipe, the run
folder, the logging — lives in helper.py; the charts live in charts.py.
"""
import os
from concurrent.futures import ThreadPoolExecutor

from arker import VM, Arker

from charts import chart, timeline
from helper import (AGENTS, INSTALL_AGENT, INSTALL_NODE, INSTALL_TORCH, INSTALL_UV,
                    EXEC_MARK, PROMPT, RUN, ENV, TASK, TURNS, VERIFY_TORCH,
                    VGPUS, begin_config, log, parse_runs, prep_ready, save_summary,
                    turn_done, turn_started)


# The OpenRouter key goes to the platform, not the VM: stored as a policy secret
# and spliced into the Authorization header on the way out to openrouter.ai, so
# the key never exists inside the machine that uses it.
#
# Applied at prep's fork as well as the agents'. The platform installs its MITM
# CA into a VM's trust store when the VM is forked WITH a policy; a policy
# attached while forking off a VM that had none leaves the CA absent and every
# TLS connection to openrouter.ai fails. prep carries it so its forks inherit a
# trust store that already has the CA.
OPENROUTER_POLICY = {
    "secrets": {"OPENROUTER_API_KEY": os.environ["OPENROUTER_API_KEY"]},
    "policies": [
        {"type": "outbound",
         "match": {"hosts": ["openrouter.ai"]},
         "action": {"rewrite": {"headers": {
             "authorization": "Bearer ${secret:OPENROUTER_API_KEY}"}}}},
        # A non-empty document denies every flow it does not match, and the
        # agent still needs the rest of the internet.
        {"type": "outbound", "action": "allow"},
    ],
}


def prepare_vm(ark: Arker) -> VM:
    """Fork one VM and install the toolchain on it. Every agent forks from this."""
    # A small slice is enough for prep: it installs, it does not train.
    prep = ark.fork(source_vm_name="ubuntu-gpu", platforms=["x86_64-h100sxm"], name="prep",
                    vgpu=0.25, vcpu_count=2, memory_mib=16384, disk_mib=102400,
                    policies=OPENROUTER_POLICY)

    # uv, plus the ~/lab venv that everything below installs into — ~6s
    prep.run(ENV + INSTALL_UV)
    # torch for CUDA 12.4 — ~170s, and the whole reason prep is forked once
    # rather than installed per agent. Nothing prints while it downloads.
    prep.run(ENV + INSTALL_TORCH)
    # node, which the coding agent runs on — ~17s
    prep.run(ENV + INSTALL_NODE)
    # the coding agent itself: what drives each turn inside the VM — ~12s
    prep.run(ENV + INSTALL_AGENT)
    # fail here, on prep, rather than once four agents are running — ~12s
    prep.run(ENV + VERIFY_TORCH)

    prep.run(ENV + f"cat > train.py <<'EOF'\n{TASK}\nEOF")   # agents inherit it by forking
    prep_ready()
    log(f"prep ready — forking {AGENTS} agents")
    return prep


def run_agent(ark: Arker, prep: VM, n: int, vgpu: float) -> list[dict]:
    """One agent: fork off prep, run TURNS turns, hand back its experiments."""
    vm = ark.fork(
        source=prep,
        name=f"agent{n}",
        vgpu=vgpu,
        platforms=["x86_64-h100sxm"],
        vcpu_count=2, memory_mib=16384, disk_mib=102400,
        policies=OPENROUTER_POLICY)
    for turn in range(1, TURNS + 1):
        turn_started(f"agent{n}", turn)
        # queueing_timeout is the only bound here: on a contended host the run
        # parks until a GPU slice frees, so a long turn means queueing, not a
        # slow model. Execution is unbounded — demo code assumes it succeeds.
        out = vm.run(ENV + f"echo {EXEC_MARK}=$(date +%s); pi --provider openrouter "
                     f'--model openai/gpt-5.6-luna --exclude-tools ask_question '
                     f'-p "{PROMPT}"', queueing_timeout=900).stdout
        tsv = vm.run(ENV + "cat results.tsv").stdout
        # out carries the VM's exec-start stamp, which is how the queue wait
        # is measured rather than guessed
        turn_done(f"agent{n}", turn, tsv, out)   # also redraws progress-<config>.png

    experiments = parse_runs(tsv)   # the last turn's read, already in hand
    vm.delete()
    log(f"agent{n} finished — {len(experiments)} experiments")
    return experiments


def run_config(vgpu: float) -> dict:
    """Run every agent at one GPU fraction, concurrently, and save the summary."""
    begin_config(vgpu)
    ark = Arker()
    prep = prepare_vm(ark)

    # All agents are submitted at once.
    # When they ask for more GPU than the host has, the platform queues them.
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
