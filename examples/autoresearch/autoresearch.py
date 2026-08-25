#!/usr/bin/env python3
import os
from concurrent.futures import ThreadPoolExecutor

from arker import VM, Arker

from charts import chart, timeline
from helper import (AGENTS, EXEC_MARK, PROMPT, RUN, ENV, TASK, TURNS,
                    VGPUS, begin_config, log, parse_runs, prep_ready, save_summary,
                    turn_done, turn_started)


def prepare_vm(ark: Arker) -> VM:
    """Fork one VM and install the toolchain on it. Every agent forks from this."""
    # A small slice is enough for prep: it installs, it does not train.
    prep = ark.fork(source_vm_name="ubuntu-gpu", platforms=["x86_64-h100sxm"], name="prep",
                    vgpu=0.25, vcpu_count=2, memory_mib=16384, disk_mib=102400,
                    policies={
                        "secrets": {"OPENROUTER_API_KEY": os.environ["OPENROUTER_API_KEY"]},
                        "policies": [
                            {"type": "outbound",
                             "match": {"hosts": ["openrouter.ai"]},
                             "action": {"rewrite": {"headers": {
                                 "authorization": "Bearer ${secret:OPENROUTER_API_KEY}"}}}},
                            {"type": "outbound", "action": "allow"},
                        ],
                    })

    # uv, plus the ~ venv that everything below installs into: ~6s
    prep.run(ENV + "curl -fsSL https://astral.sh/uv/install.sh | UV_INSTALL_DIR=/usr/local/bin sh"
             " && uv venv")
    # torch for CUDA 12.4: ~170s, and the whole reason prep is forked once
    # rather than installed per agent. Nothing prints while it downloads.
    prep.run(ENV + "uv pip install -q torch --index-url https://download.pytorch.org/whl/cu124")
    # node, which the coding agent runs on: ~17s
    prep.run(ENV + "curl -fsSL -o /tmp/node.tar.xz "
             "https://nodejs.org/dist/v22.20.0/node-v22.20.0-linux-x64.tar.xz"
             " && tar -xf /tmp/node.tar.xz -C /usr/local --strip-components=1")
    # the coding agent itself: what drives each turn inside the VM: ~12s
    prep.run(ENV + "npm i -g --ignore-scripts @earendil-works/pi-coding-agent")
    # fail here, on prep, rather than once four agents are running: ~12s
    prep.run(ENV + ".venv/bin/python -c 'import torch; print(\"torch\", torch.__version__)'")

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
        vcpu_count=2, memory_mib=16384, disk_mib=102400)

    for turn in range(1, TURNS + 1):
        turn_started(f"agent{n}", turn)
        # queueing_timeout is the only bound here: on a contended host the run parks until a GPU slice frees, so a long turn means queueing, not a slow model.
        out = vm.run(ENV + f"echo {EXEC_MARK}=$(date +%s); pi --provider openrouter "
                     f'--model openai/gpt-5.6-luna --exclude-tools ask_question '
                     f'-p "{PROMPT}"', queueing_timeout=900).stdout
        tsv = vm.run(ENV + "cat results.tsv").stdout
        # out carries the VM's exec-start stamp, which is how the queue wait is measured
        turn_done(f"agent{n}", turn, tsv, out)

    experiments = parse_runs(tsv)   # the last turn's read, already in hand
    vm.delete()
    log(f"agent{n} finished — {len(experiments)} experiments")
    return experiments


def run_config(vgpu: float) -> dict:
    """Run every agent at one GPU fraction, concurrently, and save the summary."""
    begin_config(vgpu)
    ark = Arker()
    prep = prepare_vm(ark)

    # All agents are submitted at once. When they ask for more GPU than the host has, the platform queues them.
    with ThreadPoolExecutor(max_workers=AGENTS) as pool:
        futures = {n: pool.submit(run_agent, ark, prep, n, vgpu)
                   for n in range(1, AGENTS + 1)}
        agents = {f"agent{n}": f.result() for n, f in futures.items()}

    # last: the forks' parent
    prep.delete()
    return save_summary(vgpu, agents)


if __name__ == "__main__":
    RUN.mkdir(parents=True, exist_ok=True)
    print(f"results -> {RUN}")
    for vgpu in VGPUS:
        run_config(vgpu)
    chart(str(RUN))
    timeline(str(RUN))
