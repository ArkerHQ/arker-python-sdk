# autoresearch on Arker

Several agents tune a small GPT at once, each on its own slice of a shared H100.

Every agent gets a VM, and every turn is the same loop: read `results.tsv` for what has
been tried → edit the `HYPERPARAMS` block in `train.py` → train → record `val_loss`. At
`0.25` vGPU four agents share one card and run at the same time. At `1.0` each agent
wants a whole card, so on a 2-GPU host they queue — the platform hands the card over as
each turn finishes, with no orchestration from the script.

Three Arker calls carry the whole thing:

| | |
| ---------- | --- |
| `fork()`   | one prep VM installs the toolchain; every agent is a copy-on-write fork of it, ready in seconds |
| `run()`    | each turn is one exec inside an agent's VM |
| `delete()` | agents clean themselves up; prep goes last, since it is their parent |

The OpenRouter key never enters a VM: it is passed to `fork()` as a policy secret, and
the platform injects it into the agent's requests to `openrouter.ai`. Inside the machine
the environment holds only a placeholder.

`autoresearch.py` is those calls and the concurrency around them. The task, prep recipe
and logging are in `helper.py`; the charts are in `charts.py`.

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

`VGPUS` is the whole interface — each fraction runs as its own config, one after the
other. `AGENTS` and `TURNS` set the size of the search.

## What you see

```
results -> results/20260819-194048-4agents-2turns
[19:40:49] === vgpu0.25: 4 agents x 0.25 vGPU, 2 turns each ===
[19:44:31] prep ready — forking 4 agents
[19:44:33] agent1 turn 1/2 started
[19:45:01] agent1 turn 1/2 done in 28s — val_loss 3.6545
```

Prep takes ~4 minutes to install uv, torch, node and the agent — torch alone is ~170s of
that, and nothing prints while it downloads. Every agent then forks off it in about a
second. Everything lands in the run folder: `run.log`, a `vgpu<x>.json` per config,
and three charts — `progress-vgpu<x>.png` redrawn every turn, plus `timeline.png` and
`comparison.png` at the end. An interrupted run still leaves usable results.

To redraw a chart later from the saved JSON:

```bash
uv run --with matplotlib python -c "import charts; charts.chart()"
```

## What queueing looks like

Each turn reports how long it took and how much of that was spent waiting for a GPU
slice:

```
[21:00:27] agent1 turn 1/2 done in 50s, 3s queued — val_loss 3.6545
[21:02:46] agent1 turn 2/2 done in 139s, 94s queued — val_loss 1.5267
```

Same agent, same work — the second turn was slower because it parked. `run()` passes
`queueing_timeout`, so a run waits for a slice rather than failing. A long turn with no
queueing is just the agent thinking.
