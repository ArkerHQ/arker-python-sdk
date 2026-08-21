"""Everything in this demo that is NOT an Arker primitive.

autoresearch.py keeps fork / run / policies / delete and the concurrency; the task, the
prep recipe, the run folder, the logging and the saved summary live here, so
that file reads as "what the platform does". The pictures are in charts.py.
"""
import json
import os
import pathlib
import threading
import time

AGENTS = int(os.environ.get("AGENTS", 4))
TURNS = int(os.environ.get("TURNS", 8))

HERE = pathlib.Path(__file__).parent
RESULTS = HERE / "results"

# The GPU fractions to compare, smallest first: VGPUS="0.25,0.5,1.0".
# Each becomes one config, saved as vgpu<value>.json in the run folder.
VGPUS = [float(v) for v in os.environ.get("VGPUS", "0.25,1.0").split(",") if v.strip()]


def label_for(vgpu: float) -> str:
    return f"vgpu{vgpu:g}"

# One folder per invocation, holding every config in this run.
RUN = RESULTS / f"{time.strftime('%Y%m%d-%H%M%S', time.gmtime())}-{AGENTS}agents-{TURNS}turns"

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
    _state.update(vgpu=vgpu, t0=time.time(), turns=[], marks={}, prep_ready=None)
    log(f"=== {label_for(vgpu)}: {AGENTS} agents x {vgpu:g} vGPU, {TURNS} turns each ===")


def wall_seconds() -> int:
    return round(time.time() - _state["t0"])


def prep_ready() -> None:
    """Mark the end of setup: prep is installed, agents are about to fork."""
    _state["prep_ready"] = time.time() - _state["t0"]


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
            # seconds the training run itself took, from results.tsv — the rest
            # of the turn is the agent thinking (model latency, edits, reads)
            "train_s": runs[-1]["secs"] if runs else None,
            "loss": runs[-1]["loss"] if runs else None,
        })
        _save_partial()
        # imported here, not at the top: matplotlib is only needed once a turn
        # has finished, and the demo should fail on a bad API key long before
        # it fails on a missing plotting library
        from charts import draw_progress
        draw_progress(_state)
    waited = f", {queued:.0f}s queued" if queued >= 1 else ""
    log(f"{agent} turn {turn}/{TURNS} done in {took:.0f}s{waited} "
        f"— val_loss {last_loss(tsv)}")


# The prep VM's install steps, one shell snippet each, run as separate execs
# from autoresearch.py so each one is a readable line there rather than a wall
# of bash.
#
# A run() that names no session lands in session 0, the VM's default shell,
# and that shell is stateful: the exports and the cwd below are still in place
# for every later run — and, because sessions survive a fork, for every agent
# forked off prep. So the environment is set once, here, and nothing after it
# re-exports or re-cds. Multi-command stages chain with && rather than set -e,
# which does not carry between runs.
# OPENROUTER_API_KEY is deliberately a placeholder: `pi` refuses to start
# without one set, but the real key never reaches the VM — the policy on each
# agent fork injects the real one into its requests. See run_agent().
SETUP_SHELL = ("export PATH=/usr/local/bin:$PATH HOME=/home/user"
               " OPENROUTER_API_KEY=injected-by-policy; mkdir -p ~/lab; cd ~/lab")

INSTALL_UV = ("curl -fsSL https://astral.sh/uv/install.sh | UV_INSTALL_DIR=/usr/local/bin sh"
              " && uv venv")
INSTALL_TORCH = "uv pip install -q torch --index-url https://download.pytorch.org/whl/cu124"
INSTALL_NODE = ("curl -fsSL -o /tmp/node.tar.xz https://nodejs.org/dist/v22.20.0/node-v22.20.0-linux-x64.tar.xz"
                " && tar -xf /tmp/node.tar.xz -C /usr/local --strip-components=1")
INSTALL_AGENT = "npm i -g --ignore-scripts @earendil-works/pi-coding-agent"
VERIFY_TORCH = ".venv/bin/python -c 'import torch; print(\"torch\", torch.__version__)'"


PROMPT = (
    "You are tuning ~/lab/train.py to minimise val_loss. Check results.tsv for what "
    "has been tried, edit ONLY the HYPERPARAMS block, then run: "
    ".venv/bin/python train.py . Exactly one run this turn, then stop. "
    "IMPORTANT: your tool call is killed at 30 s and importing torch alone costs ~10-15 s, "
    "so keep STEPS <= 1200 - a run that is killed records NOTHING and wastes the turn."
)

TASK = (HERE / "train.py").read_text()

# The VM prints this the instant the exec starts. Subtracting it from when we
# submitted the run gives the time the run spent PARKED waiting for a GPU
# slice — the one part of contention a client otherwise cannot see.
EXEC_MARK = "ARKER_EXEC_START"


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
        "experiments": len(every),
        "gpu_seconds": round(sum(r["secs"] for r in every), 1),
        "best_loss": min((r["loss"] for r in every), default=None),
        "prep_ready_s": _state.get("prep_ready"),
        "timeline": _state["turns"],
        "per_agent": agents,
    }
    (RUN / f"{label}.json").write_text(json.dumps(summary, indent=2))
    log(f"{label}: {summary['experiments']} experiments in {wall}s, "
        f"best {summary['best_loss']}")
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
        "experiments": len(losses),
        "best_loss": min(losses, default=None),
        "prep_ready_s": _state.get("prep_ready"),
        "timeline": turns,
        "per_agent": per_agent,
    }, indent=2))
