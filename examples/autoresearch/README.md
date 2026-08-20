# autoresearch on Arker

Several agents tune a small GPT at once, each on its own slice of a shared H100. The run
shows what GPU slicing buys you.

Every agent gets a VM, and every turn is the same loop: read `results.tsv` for what has
been tried → edit the `HYPERPARAMS` block in `train.py` → train → record `val_loss`. At
`0.25` vGPU four agents share one card and genuinely run at the same time. At `1.0` each
agent wants a whole card, so on a 2-GPU host they queue — the platform hands the card
over as each turn finishes, with no orchestration from the script.

Three Arker calls carry the whole thing:

| | |
| ---------- | --- |
| `fork()`   | one prep VM installs the toolchain; every agent is a copy-on-write fork of it, ready in seconds instead of repeating a 3-minute install |
| `run()`    | each turn is one exec inside an agent's VM |
| `delete()` | agents clean themselves up; prep goes last, since it is their parent |

`autoresearch.py` is those calls and the concurrency around them. The task, prep recipe,
run folder and logging are in `helper.py`; the charts are in `charts.py`.

## Run it

```bash
export ARKER_API_KEY=ark_live_...
export ARKER_BASE_URL=https://arker-us-west.arker.ai/api   # note the /api suffix
export OPENROUTER_API_KEY=sk-or-v1-...

# smoke test: 2 agents, 2 turns each, ~5 minutes
AGENTS=2 TURNS=2 VGPUS=0.25 \
  uv run --with arker --with matplotlib python autoresearch.py

# the real comparison: quarter-slices vs whole cards
AGENTS=4 TURNS=8 VGPUS=0.25,1.0 \
  uv run --with arker --with matplotlib python autoresearch.py
```

`VGPUS` is the whole interface: each fraction runs as its own config, one after the
other, and the comparison chart is drawn at the end.

| variable | default | |
| -------- | ---------- | --- |
| `VGPUS`  | `0.25,1.0` | GPU fractions to run, in order |
| `AGENTS` | `4`        | agents per config |
| `TURNS`  | `8`        | turns per agent |

## What you see

The first line printed is the run folder — everything lands there:

```
results -> results/20260819-194048-4agents-2turns
[19:40:48] === vgpu1: 4 agents x 1 vGPU, 2 turns each ===
[19:40:49] prep 7VEVGY forked — installing the toolchain
[19:40:52]   prep [1/5] uv + venv done — 3s
[19:41:23]   prep [2/5] torch (cu124) done — 31s
...
[19:42:25] prep ready — forking 4 agents
[19:42:29] agent1 turn 1/2 started
[19:42:57] agent1 turn 1/2 done in 28s — val_loss 3.6545
```

Prep takes ~90s: uv, torch, node, the pi agent, and a torch import to prove the GPU stack
works before anything forks off it. Agents then appear within seconds each, because they
are copy-on-write forks rather than fresh installs.

| file | |
| ---------------------- | --- |
| `run.log`              | every line above, timestamped |
| `vgpu<x>.json`         | rewritten **after every turn**, with `in_progress` and `turns_done` |
| `progress-vgpu<x>.png` | redrawn after every turn |
| `timeline.png`         | every config stacked, drawn at the end |
| `comparison.png`       | wall clock and best loss per config, drawn at the end |

Because the JSON and the progress chart are rewritten every turn, an interrupted run
still leaves usable results — and `tail -f run.log`, or an image viewer left open on
`progress-vgpu<x>.png`, works as a live view.

`progress-vgpu<x>.png` has two panels. The left one is a timeline of turns: each bar
covers the time a turn actually ran, so time spent parked waiting for a slice is **not**
in the bar — it is annotated beside it as `(+26s queued)`. The right panel tracks best
`val_loss` so far per agent.

## What queueing looks like

Every turn prints how long it took and how much of that was spent parked waiting for a
GPU slice — from a real 2 × 0.25 run on a busy host:

```
[21:00:27] agent1 turn 1/2 done in 50s, 3s queued — val_loss no run recorded
[21:00:31] agent2 turn 1/2 done in 54s, 2s queued — val_loss no run recorded
[21:01:22] agent2 turn 2/2 done in 51s — val_loss 3.6545
[21:02:46] agent1 turn 2/2 done in 139s, 94s queued — val_loss 1.5267
```

Agent1's last turn took nearly three times as long as its first, and the `94s queued`
says why: the work was identical, the wait was for a slice. The VM stamps the moment it
begins executing, and the script subtracts that from when it submitted the run — so the
queue wait is measured, not guessed. `queueing_timeout` on `run()` is what makes a run
park instead of failing.

A turn that reports no queueing but still ran long is the agent thinking, not the
platform: model latency, edits and reads all happen inside the same turn.

## Comparing two runs

`VGPUS=0.25,1.0` writes both configs into one folder and charts them together. To combine
runs done separately, point them at the same folder:

```bash
RUN_DIR=results/compare VGPUS=0.25 uv run --with arker --with matplotlib python autoresearch.py
RUN_DIR=results/compare VGPUS=1.0  uv run --with arker --with matplotlib python autoresearch.py
```

The second run draws `comparison.png` across whatever it finds there. To redraw without
running anything:

```bash
uv run --with matplotlib python -c "import charts; charts.chart('results/compare')"
```

`chart()` with no argument uses the newest folder under `results/`, and picks up any
`vgpu<x>.json` matching the current `VGPUS` — so `VGPUS=0.25,0.5,1.0` compares three.

Only compare configs run on the **same host**. Wall clock is the point of the chart, and
a pod far from the snapshot store pays a cold-start tax that dwarfs the effect being
measured.

## Notes

**Quality does not depend on the slice.** The task is seeded, so the same hyperparameters
give the same `val_loss` on a 0.25 slice and a whole card. Only throughput changes. With
few turns the `best val loss` bars still differ — that is which hyperparameters the agent
happened to try, not the hardware.

**prep holds a slice too.** It forks with `vgpu=0.25` for the install and keeps that
slice until it suspends — with no further runs to trigger a handover, that means waiting
out the 30-second idle TTL, delaying the first agent by ~26s on a full host.

**Demo code: the success path only.** These calls can return a retryable 503 on a busy
host, and nothing here retries or cleans up after a crash. If a run dies partway, its VMs
are still alive and holding slices — list and delete them before the next run.

**GPU model matters.** `train.py` runs anywhere, but every timing above is H100 (sm90)
via `ubuntu-gpu` on `x86_64-h100sxm`. Do not compare numbers across GPU models.
