# autoresearch on Arker

Several agents tune a small GPT at once, each on its own slice of a shared H100, and
the run shows what GPU slicing buys you.

Each agent gets a VM, and each turn is: read `results.tsv` for what has been tried →
edit the `HYPERPARAMS` block in `train.py` → train → record `val_loss`. Run it at
`0.25` vGPU and four agents share one card and genuinely run at the same time; run it at
`1.0` and each agent wants a whole card, so on a 2-GPU host they queue — the platform
hands the card over as each turn finishes, with no orchestration from the script.

Three Arker calls carry the whole thing:


|            |                                                                                                                                         |
| ---------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| `fork()`   | one prep VM installs the toolchain; every agent is a copy-on-write fork of it, ready in seconds instead of repeating a 3-minute install |
| `run()`    | each turn is one exec inside an agent's VM                                                                                              |
| `delete()` | agents clean themselves up; prep goes last, since it is their parent                                                                    |


`autoresearch.py` is those calls and the concurrency around them. Everything else — the
task, the prep recipe, the run folder, the logging, the charts — is in `helper.py`.

## Setup

```bash
export ARKER_API_KEY=ark_live_...
export ARKER_BASE_URL=https://arker-us-west.arker.ai/api   # note the /api suffix
export OPENROUTER_API_KEY=sk-or-v1-...
```

`vgpu=` requires a recent SDK. If `fork()` raises
`TypeError: unexpected keyword argument 'vgpu'`, you are on an older published `arker`
— point `uv` at a checkout instead: `--with /path/to/arker-sdk/python`.

## Run it

`VGPUS` is the whole interface. Each fraction runs as its own config, one after the
other, and the comparison chart is drawn at the end.

```bash
# smoke test: 2 agents, 2 turn each, ~5 minutes
AGENTS=2 TURNS=2 VGPUS=0.25 \
  uv run --with arker --with matplotlib python autoresearch.py

# the real comparison: quarter-slices vs whole cards
AGENTS=4 TURNS=8 VGPUS=0.25,1.0 \
  uv run --with arker --with matplotlib python autoresearch.py
```


| variable           | default                |                                                 |
| ------------------ | ---------------------- | ----------------------------------------------- |
| `VGPUS`            | `0.25,1.0`             | GPU fractions to run, in order                  |
| `AGENTS`           | `4`                    | agents per config                               |
| `TURNS`            | `8`                    | turns per agent                                 |
| `PLATFORM`         | `x86_64-h100sxm`       | must match a platform `ubuntu-gpu` is baked for |
| `GPUS_ON_HOST`     | `2`                    | for the cost estimate only                      |
| `USD_PER_GPU_HOUR` | `2.69`                 | for the cost estimate only                      |
| `RUN_DIR`          | new timestamped folder | write into an existing folder instead           |




## What to expect

The first line printed is the run folder — everything lands there:

```
results -> results/20260819-194048-4agents-2turns
[19:40:48] === vgpu1: 4 agents x 1 vGPU, 2 turns each ===
[19:40:49] prep 7VEVGY forked — installing the toolchain
[19:40:49]   prep [1/5] uv + venv …
[19:40:52]   prep [1/5] uv + venv done — 3s everything's installed!
[19:41:23]   prep [2/5] torch (cu124) done — 31s
...
[19:42:25] prep ready — forking 4 agents
[19:42:29] agent1 turn 1/2 started
[19:42:57] agent1 turn 1/2 done — val_loss 3.6545
```

Prep takes ~90s: uv, torch, node, the pi agent, and a torch import to prove the GPU
stack works before anything forks off it. Then agents appear within seconds each,
because they are copy-on-write forks rather than fresh installs.


| file                   |                                                                     |
| ---------------------- | ------------------------------------------------------------------- |
| `run.log`              | every line above, timestamped                                       |
| `vgpu<x>.json`         | rewritten **after every turn**, with `in_progress` and `turns_done` |
| `progress-vgpu<x>.png` | redrawn after every turn                                            |
| `comparison.png`       | drawn at the end, across all `VGPUS`                                |


Because the JSON and progress chart are rewritten each turn, an interrupted run still
leaves usable results — and `tail -f run.log` or an image viewer on
`progress-vgpu<x>.png` works as a live view.

`progress-vgpu<x>.png` has two panels. The left one is a timeline of turns, and it is
where queueing becomes visible — but read it by **bar length, not by gaps**. A bar starts
when the turn is submitted, not when the GPU is granted: a run parks in admission until a
slice frees, so waiting is inside the bar. Two agents handed the same work at the same
moment, one bar twice as long as the other, means that one queued. The right panel tracks
best `val_loss` so far per agent.

### What queueing looks like

Two agents at `1.0` on a 2-GPU host, both submitted at the same instant. `prep` still
held 0.25 of one card, so only one whole card was free — from the worker log:

```
20:20:53.652  agent A asks 81559 MiB, 142729 free   -> assigned
20:20:53.718  agent B asks 81559 MiB,  61170 free   -> parked
20:20:53.719  no eligible victim
   ... 26 seconds ...
20:21:19.497  prep suspended (30s idle TTL) — its 0.25 released
20:21:19.727  agent B granted after 26009 ms
```

Client-side that appears as agent B's first turn taking 52s against agent A's 30s. Same
work; the extra 22-26s was spent parked. Note what freed the card: `prep` had no more
runs to finish, so it held its slice until the 30-second idle-suspend TTL expired.

A 4 × 1.0 run — 4 whole cards wanted, 2 available — looked like this:


| agent  | first turn started | turn 1 took |
| ------ | ------------------ | ----------- |
| agent1 | +101s              | 25s         |
| agent2 | +129s              | **56s**     |
| agent3 | **+184s**          | 23s         |


Same work, twice the wall time for agent2, because half its turn was spent parked, and
agent3 waited 83s for a card at all. All four agents still finished every turn; nobody
starved. The timeline panel shows this as agent2's bar being twice agent1's.

## Drawing two results together

The comparison chart needs both configs' JSON in one folder. Running with
`VGPUS=0.25,1.0` does that for you.

To combine runs done separately — different days, or one config re-run — point them at
the same folder with `RUN_DIR`:

```bash
RUN_DIR=results/compare VGPUS=0.25 uv run --with arker --with matplotlib python autoresearch.py
RUN_DIR=results/compare VGPUS=1.0  uv run --with arker --with matplotlib python autoresearch.py
```

Both write into `results/compare/`, and the second run draws `comparison.png` across
whatever it finds there. To redraw without running anything:

```bash
uv run --with matplotlib python -c \
  "import helper; helper.chart('results/compare')"
```

`chart()` with no argument uses the newest folder under `results/`. It picks up any
`vgpu<x>.json` matching the current `VGPUS`, so three-way comparisons work the same way:
`VGPUS=0.25,0.5,1.0`.

One caveat: only compare configs run on the **same host**. Wall clock and cost are the
point of the chart, and they are not comparable across machines — a pod far from the
snapshot store pays a cold-start tax that dwarfs the effect being measured.

## Notes

**Quality does not depend on the slice.** The task is seeded, so the same hyperparameters
give the same `val_loss` on a 0.25 slice and a whole card. What changes is throughput:
the fractions differ in wall clock and cost, not in the answer they find. With few turns
the `best val loss` bars will still differ — that is which hyperparameters the agent
happened to try, not the hardware.

**Turn time is the contention signal.** A slow turn on a contended host is usually
queueing, not a slow model — `run()` passes `queueing_timeout`, so a run parks until a
GPU slice frees rather than failing. The client cannot see the moment a slice is granted,
so the wait is only visible as a longer turn. The worker log has the real story
(`ADMIT_ENTRY`, `gpu_reclaim`, `budget[gpu_vram] acquire ... wait_ms`).

**prep holds a GPU slice too.** It is forked with `vgpu=0.25` for the toolchain install,
and it keeps that slice until it is suspended — which, with no further runs to trigger a
handover, means waiting out the 30-second idle TTL. On a host with no spare capacity that
delays the first agent by ~26s.

**Demo code: the success path only.** On a busy host these calls can return a retryable
503, and nothing here retries or cleans up after a crash. If a run dies partway, its VMs
are still alive and holding slices — list and delete them before the next run.

**GPU model matters.** `train.py` is small enough to run anywhere, but the
timings quoted above are H100 (sm90) via `ubuntu-gpu` on `x86_64-h100sxm`. On another
GPU the wall-clock numbers move, so do not compare across GPU models.