# autoresearch on Arker

Several agents tune a small model at once, each on its own slice of a shared H100.

Every agent gets a VM, and every turn is the same loop: 
- read `results.tsv` for what has been tried
- edit the `HYPERPARAMS` block in `train.py`
- train
- record `val_loss`. 

`autoresearch.py` is the main entrypoint. The task, prep recipe and logging are in `helper.py` and the charts are in `charts.py`.

## Run it

`VGPUS` is the parameter to specify gpu slice. `AGENTS` and `TURNS` set the size of the experiment.

```bash
export ARKER_API_KEY=ark_live_...
export ARKER_BASE_URL=https://arker-us-west.arker.ai/api
export OPENROUTER_API_KEY=sk-or-v1-...

# smoke test: 2 agents, 2 turns each, ~5 minutes
AGENTS=2 TURNS=2 VGPUS=0.25 \
  uv run --with arker --with matplotlib python autoresearch.py

# the real comparison: quarter-slices vs whole cards
AGENTS=4 TURNS=8 VGPUS=0.25,1.0 \
  uv run --with arker --with matplotlib python autoresearch.py
```
## What you see

```
results -> results/20260819-194048-4agents-2turns
[19:40:49] === vgpu0.25: 4 agents x 0.25 vGPU, 2 turns each ===
[19:44:31] prep ready — forking 4 agents
[19:44:33] agent1 turn 1/2 started
[19:45:01] agent1 turn 1/2 done in 28s — val_loss 3.6545
```

Everything lands in the run folder: `run.log`, a `vgpu<x>.json` per config, and three charts: `progress-vgpu<x>.png` redrawn every turn, plus `timeline.png` and `comparison.png` at the end.

At `0.25` vGPU four agents share one card and run at the same time. At `1.0` each agent wants a whole card, so on a 2-GPU host they queue, the platform hands the card over as each turn finishes.
