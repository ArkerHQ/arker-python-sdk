"""Everything in this demo that is NOT an Arker primitive.

autoresearch.py keeps fork / run / delete and the concurrency; the task
definition, the prep recipe, the run folder, the logging and the chart all
live here so that file reads as "what the platform does".
"""
import json
import os
import pathlib
import sys
import threading
import time

AGENTS = int(os.environ.get("AGENTS", 4))
TURNS = int(os.environ.get("TURNS", 8))
PLATFORM = os.environ.get("PLATFORM", "x86_64-h100sxm")
GPUS_ON_HOST = int(os.environ.get("GPUS_ON_HOST", 2))   # for the cost estimate
USD_PER_GPU_HOUR = float(os.environ.get("USD_PER_GPU_HOUR", 2.69))

HERE = pathlib.Path(__file__).parent
RESULTS = HERE / "results"

# The GPU fractions to compare, smallest first: VGPUS="0.25,0.5,1.0".
# Each becomes one config, saved as vgpu<value>.json in the run folder.
VGPUS = [float(v) for v in os.environ.get("VGPUS", "0.25,1.0").split(",") if v.strip()]


def label_for(vgpu: float) -> str:
    return f"vgpu{vgpu:g}"

# One folder per invocation. RUN_DIR lets `both` reuse a folder across two
# processes, and lets you point a rerun at an existing one.
RUN = pathlib.Path(os.environ.get("RUN_DIR") or
                   RESULTS / f"{time.strftime('%Y%m%d-%H%M%S', time.gmtime())}-{AGENTS}agents-{TURNS}turns")

_log_lock = threading.Lock()
_chart_lock = threading.Lock()

# Live state for the config currently running: when it started, which turns
# have finished, and when each agent's current turn began. The progress chart
# is redrawn from this after every turn.
_state: dict = {"vgpu": None, "t0": None, "turns": [], "marks": {}}


def log(msg: str) -> None:
    """Print and append to the run folder's run.log, safe across agent threads."""
    line = f"[{time.strftime('%H:%M:%S', time.gmtime())}] {msg}"
    print(line, flush=True)
    with _log_lock:
        with (RUN / "run.log").open("a") as fh:
            fh.write(line + "\n")


def begin_config(vgpu: float) -> None:
    _state.update(vgpu=vgpu, t0=time.time(), turns=[], marks={})
    log(f"=== {label_for(vgpu)}: {AGENTS} agents x {vgpu:g} vGPU, {TURNS} turns each ===")


def wall_seconds() -> int:
    return round(time.time() - _state["t0"])


def turn_started(agent: str, turn: int) -> None:
    with _chart_lock:
        _state["marks"][agent] = time.time()
    log(f"{agent} turn {turn}/{TURNS} started")


def turn_done(agent: str, turn: int, tsv: str, stdout: str = "") -> None:
    """Record one finished turn and redraw the progress chart."""
    runs = parse_runs(tsv)
    began = exec_started_at(stdout)
    with _chart_lock:
        submitted = _state["marks"].get(agent, _state["t0"])
        took = time.time() - submitted
        # queued = submitted -> the VM actually started running it
        queued = max(0.0, began - submitted) if began else 0.0
        _state["turns"].append({
            "agent": agent,
            "turn": turn,
            "start": submitted - _state["t0"],
            "queued": queued,
            "end": time.time() - _state["t0"],
            "loss": runs[-1]["loss"] if runs else None,
        })
        _save_partial()
        _draw_progress()
    waited = f", {queued:.0f}s queued" if queued >= 1 else ""
    log(f"{agent} turn {turn}/{TURNS} done in {took:.0f}s{waited} "
        f"— val_loss {last_loss(tsv)}")


# Prep is run stage by stage instead of as one silent 3-minute call, so a slow
# torch wheel or npm install is visible while it happens.
STAGE_PREFIX = "set -e\nexport PATH=/usr/local/bin:$PATH HOME=/home/user\nmkdir -p ~/lab\n"
SETUP_STAGES = [
    ("uv + venv", "curl -fsSL https://astral.sh/uv/install.sh | UV_INSTALL_DIR=/usr/local/bin sh\n"
                  "cd ~/lab && uv venv"),
    ("torch (cu124)", "cd ~/lab && uv pip install -q torch --index-url https://download.pytorch.org/whl/cu124"),
    ("node 22", "curl -fsSL -o /tmp/node.tar.xz https://nodejs.org/dist/v22.20.0/node-v22.20.0-linux-x64.tar.xz\n"
                "tar -xf /tmp/node.tar.xz -C /usr/local --strip-components=1"),
    ("pi coding agent", "npm i -g --ignore-scripts @earendil-works/pi-coding-agent"),
    ("verify torch", "cd ~/lab && .venv/bin/python -c 'import torch; print(\"torch\", torch.__version__)'"),
]

PROMPT = (
    "You are tuning ~/lab/train_small.py to minimise val_loss. Check results.tsv for what "
    "has been tried, edit ONLY the HYPERPARAMS block, then run: "
    ".venv/bin/python train_small.py . Exactly one run this turn, then stop. "
    "IMPORTANT: your tool call is killed at 30 s and importing torch alone costs ~10-15 s, "
    "so keep STEPS <= 1200 - a run that is killed records NOTHING and wastes the turn."
)

TASK = (HERE / "train_small.py").read_text()

# Shell snippets the agent VMs run. Kept here so autoresearch.py shows the
# Arker call, not the bash.
WRITE_TASK = (f"export HOME=/home/user; mkdir -p ~/lab && cd ~/lab && "
              f"cat > train_small.py <<'EOF'\n{TASK}\nEOF")
READ_RESULTS = "export HOME=/home/user; cat ~/lab/results.tsv"
SETTLE = "sleep 45"  # let prep's disk settle before forking off it


# The VM prints this the instant the exec starts. Subtracting it from when we
# submitted the run gives the time the run spent PARKED waiting for a GPU
# slice — the one part of contention a client otherwise cannot see.
EXEC_MARK = "ARKER_EXEC_START"


def turn_command() -> str:
    key = os.environ["OPENROUTER_API_KEY"]
    return (
        f"echo {EXEC_MARK}=$(date +%s); "
        f"export PATH=/usr/local/bin:$PATH HOME=/home/user OPENROUTER_API_KEY={key}; cd ~/lab && "
        f'pi --provider openrouter --model openai/gpt-5.6-luna --exclude-tools ask_question -p "{PROMPT}"'
    )


def exec_started_at(stdout: str) -> float | None:
    """Epoch seconds when the VM began executing the turn, or None."""
    for line in (stdout or "").splitlines():
        if line.startswith(EXEC_MARK + "="):
            try:
                return float(line.split("=", 1)[1].strip())
            except ValueError:
                return None
    return None


def parse_runs(tsv: str) -> list[dict]:
    """results.tsv columns: time lr d_model n_layer n_head steps batch params val_loss secs"""
    runs = []
    for line in tsv.splitlines():
        c = line.split("\t")
        if len(c) >= 10:
            try:
                runs.append({"loss": float(c[8]), "secs": float(c[9]), "steps": int(c[5])})
            except ValueError:
                pass  # header row
    return runs


def last_loss(tsv: str) -> str:
    runs = parse_runs(tsv)
    return f"{runs[-1]['loss']:.4f}" if runs else "no run recorded"


def save_summary(vgpu: float, agents: dict) -> dict:
    label = label_for(vgpu)
    wall = wall_seconds()
    every = [r for runs in agents.values() for r in runs]
    summary = {
        "config": label,
        "vgpu": vgpu,
        "agents": AGENTS,
        "turns": TURNS,
        "wall_s": wall,
        "in_progress": False,
        "turns_done": AGENTS * TURNS,
        # the whole host is rented for the run, whatever fraction the agents used
        "cost_usd": round(GPUS_ON_HOST * wall / 3600 * USD_PER_GPU_HOUR, 2),
        "experiments": len(every),
        "gpu_seconds": round(sum(r["secs"] for r in every), 1),
        "best_loss": min((r["loss"] for r in every), default=None),
        "per_agent": agents,
    }
    (RUN / f"{label}.json").write_text(json.dumps(summary, indent=2))
    log(f"{label}: {summary['experiments']} experiments in {wall}s, "
        f"${summary['cost_usd']}, best {summary['best_loss']}")
    log(f"wrote {RUN / f'{label}.json'}")
    return summary


def _save_partial() -> None:
    """Write vgpu<x>.json from the turns finished so far, so a run that is
    interrupted still leaves its results behind. save_summary overwrites this
    with the full version (per-run secs and steps) when the config finishes.
    Called with _chart_lock held."""
    vgpu, turns = _state["vgpu"], _state["turns"]
    per_agent: dict = {}
    for t in sorted(turns, key=lambda t: (t["agent"], t["turn"])):
        if t["loss"] is not None:
            per_agent.setdefault(t["agent"], []).append({"loss": t["loss"]})
    losses = [r["loss"] for runs in per_agent.values() for r in runs]
    wall = wall_seconds()
    (RUN / f"{label_for(vgpu)}.json").write_text(json.dumps({
        "config": label_for(vgpu),
        "vgpu": vgpu,
        "agents": AGENTS,
        "turns": TURNS,
        "in_progress": len(turns) < AGENTS * TURNS,
        "turns_done": len(turns),
        "wall_s": wall,
        "cost_usd": round(GPUS_ON_HOST * wall / 3600 * USD_PER_GPU_HOUR, 2),
        "experiments": len(losses),
        "best_loss": min(losses, default=None),
        "per_agent": per_agent,
    }, indent=2))


def _plt():
    """matplotlib with a headless backend, imported lazily so `chart` and the
    live progress chart are the only things that need it."""
    import matplotlib
    matplotlib.use("Agg")
    import matplotlib.pyplot as plt
    return plt


AGENT_COLORS = ["#2b7bba", "#c1553b", "#5b8c5a", "#c9a227", "#8155a6", "#4aa3a2"]


def _draw_progress() -> None:
    """Redraw progress-<config>.png from _state. Called after every turn, with
    _chart_lock already held."""
    plt = _plt()
    turns, vgpu = _state["turns"], _state["vgpu"]
    if not turns:
        return
    names = sorted({t["agent"] for t in turns})
    color = {a: AGENT_COLORS[i % len(AGENT_COLORS)] for i, a in enumerate(names)}

    fig, (ax_t, ax_l) = plt.subplots(1, 2, figsize=(12, 3.6))

    # Left: when each turn actually ran. Gaps between an agent's bars are the
    # agent waiting for a GPU slice — this is what queueing looks like.
    # Only the part that actually ran on the GPU is drawn: a bar starts when the
    # VM began executing the turn, not when it was submitted. Time spent parked
    # in admission is simply absent, so on a contended host the bars step across
    # the page instead of all starting together.
    for t in turns:
        y = names.index(t["agent"])
        queued = t.get("queued", 0.0)
        began = t["start"] + queued
        ax_t.barh(y, t["end"] - began, left=began, height=.55,
                  color=color[t["agent"]], edgecolor="white", linewidth=.5)
        label = f'  {t["end"]-began:.0f}s'
        if queued >= 1:
            label += f' (+{queued:.0f}s queued)'
        ax_t.text(t["end"], y, label, va="center", fontsize=7, color="#555")
    ax_t.set_yticks(range(len(names)))
    ax_t.set_yticklabels(names, fontsize=9)
    ax_t.set_xlabel("seconds since config start", fontsize=9)
    # A turn's bar starts when the turn is submitted, not when the GPU is
    # granted: a run parks in admission until a slice frees, so waiting shows
    # up as a LONGER BAR, never as a gap. Two agents given the same work at
    # the same time, one bar twice the other's = that one queued.
    ax_t.set_title(f"time actually running on the GPU — {AGENTS} x {vgpu:g} vGPU",
                   fontsize=10)
    ax_t.grid(axis="x", alpha=.25)
    ax_t.set_axisbelow(True)
    ax_t.invert_yaxis()

    # Right: best val_loss so far, per agent, against the same clock.
    for a in names:
        pts = [t for t in turns if t["agent"] == a and t["loss"] is not None]
        if not pts:
            continue
        best, xs, ys = float("inf"), [], []
        for t in sorted(pts, key=lambda t: t["end"]):
            best = min(best, t["loss"])
            xs.append(t["end"])
            ys.append(best)
        ax_l.plot(xs, ys, marker="o", ms=4, color=color[a], label=a)
    ax_l.set_xlabel("seconds since config start", fontsize=9)
    ax_l.set_title("best val_loss so far", fontsize=10)
    ax_l.grid(alpha=.25)
    ax_l.set_axisbelow(True)
    if names:
        ax_l.legend(fontsize=8, frameon=False)

    done = len(turns)
    fig.suptitle(f"{label_for(vgpu)} — {AGENTS} agents x {TURNS} turns, "
                 f"{done}/{AGENTS * TURNS} done", fontsize=11.5)
    fig.tight_layout(rect=[0, 0, 1, .90])
    fig.savefig(RUN / f"progress-{label_for(vgpu)}.png", dpi=140)
    plt.close(fig)


def newest_run() -> pathlib.Path:
    runs = sorted((d for d in RESULTS.glob("*") if d.is_dir() and any(d.glob("*.json"))),
                  key=lambda d: d.name)
    if not runs:
        sys.exit("no results yet — run `autoresearch.py both` first")
    return runs[-1]


def chart(folder: str | None = None) -> None:
    plt = _plt()

    where = pathlib.Path(folder) if folder else newest_run()
    loaded = {v: json.loads((where / f"{label_for(v)}.json").read_text())
              for v in VGPUS if (where / f"{label_for(v)}.json").exists()}
    if not loaded:
        sys.exit(f"no results in {where}")
    # smallest fraction bluest, largest reddest — same order as VGPUS
    palette = ["#2b7bba", "#5b8c5a", "#c9a227", "#c1553b"]
    colors = {v: palette[min(i, len(palette) - 1)] for i, v in enumerate(sorted(loaded))}
    labels = {v: f"{AGENTS} x {v:g} vGPU" for v in loaded}

    fig, ax = plt.subplots(1, 3, figsize=(11, 3.4))
    for i, (key, title, fmt) in enumerate([
        ("wall_s", "wall clock (s)", "{:.0f}"),
        ("cost_usd", "GPU cost (USD)", "${:.2f}"),
        ("best_loss", "best val loss", "{:.4f}"),
    ]):
        names = sorted(loaded)
        vals = [loaded[n][key] for n in names]
        ax[i].bar([labels[n] for n in names], vals, color=[colors[n] for n in names], width=.6)
        for x, v in enumerate(vals):
            ax[i].text(x, v, fmt.format(v), ha="center", va="bottom", fontsize=9)
        ax[i].set_title(title, fontsize=10)
        ax[i].set_ylim(0, max(vals) * 1.25)
        ax[i].grid(axis="y", alpha=.25)
        ax[i].set_axisbelow(True)
    n = next(iter(loaded.values()))
    fig.suptitle(f"Same {n['experiments']} experiments on the same host: slicing vs whole GPUs",
                 fontsize=11.5)
    fig.tight_layout(rect=[0, 0, 1, .90])
    out = where / "comparison.png"
    fig.savefig(out, dpi=150)
    print(f"wrote {out}")
