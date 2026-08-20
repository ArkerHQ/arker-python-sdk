"""The pictures the run leaves behind. Nothing here talks to Arker.

    progress-<config>.png   redrawn after every turn, while the run is going
    timeline.png            every config stacked, drawn at the end
    comparison.png          the configs side by side, drawn at the end

The last two read the saved JSON, so they redraw a finished run at any time:

    uv run --with matplotlib python -c "import charts; charts.timeline()"
"""
import json
import pathlib
import sys

from helper import AGENTS, RESULTS, RUN, TURNS, VGPUS, label_for


def _plt():
    """matplotlib with a headless backend, imported lazily so `chart` and the
    live progress chart are the only things that need it."""
    import matplotlib
    matplotlib.use("Agg")
    import matplotlib.pyplot as plt
    return plt


AGENT_COLORS = ["#2b7bba", "#c1553b", "#5b8c5a", "#c9a227", "#8155a6", "#4aa3a2"]


def draw_progress(state: dict) -> None:
    """Redraw progress-<config>.png from the live run state. helper.turn_done
    calls this after every turn, holding its chart lock."""
    plt = _plt()
    turns, vgpu = state["turns"], state["vgpu"]
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
    # The bar is the whole turn once it was granted a slice — the agent calling
    # the model, editing, and the training run. The slice is held throughout;
    # only part of it is compute. Queueing is excluded (see `queued`).
    ax_t.set_title(f"time running — {AGENTS} x {vgpu:g} vGPU",
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
    # only once some agent has a loss to plot — early turns can all be
    # "no run recorded", and an empty legend warns
    if ax_l.get_legend_handles_labels()[1]:
        ax_l.legend(fontsize=8, frameon=False)

    done = len(turns)
    fig.suptitle(f"{label_for(vgpu)} — {AGENTS} agents x {TURNS} turns, "
                 f"{done}/{AGENTS * TURNS} done", fontsize=11.5)
    fig.tight_layout(rect=[0, 0, 1, .90])
    fig.savefig(RUN / f"progress-{label_for(vgpu)}.png", dpi=140)
    plt.close(fig)


def timeline(folder: str | None = None) -> None:
    """One figure, every config in the run folder stacked: a setup phase, then
    one row per agent showing each turn — dark where the training run held the
    GPU, light where the agent was waiting on the model. Reads the saved JSON,
    so it redraws long after the run."""
    plt = _plt()
    where = pathlib.Path(folder) if folder else newest_run()
    loaded = [json.loads(f.read_text()) for f in sorted(where.glob("vgpu*.json"))]
    loaded = [d for d in loaded if d.get("timeline")]
    if not loaded:
        sys.exit(f"no timeline data in {where} — rerun to record it")
    loaded.sort(key=lambda d: d["vgpu"])

    # one panel per config, heights proportional to the agents they show
    fig, axes = plt.subplots(len(loaded), 1, figsize=(13, 2.4 + 1.5 * len(loaded)),
                             squeeze=False)
    span = max(max(t["end"] for t in d["timeline"]) for d in loaded)
    for ax, d in zip((a[0] for a in axes), loaded):
        dark, light = ("#2b7bba", "#bcd8ec") if d["vgpu"] < 1 else ("#c1553b", "#f2cdc4")
        names = sorted({t["agent"] for t in d["timeline"]})
        rows = ["setup"] + names

        setup_end = d.get("prep_ready_s") or 0
        ax.barh(0, setup_end, left=0, height=.5, color="#c9ced4")
        ax.text(setup_end + span * .006, 0, "agents fork", va="center", fontsize=7.5,
                color="#555")

        for t in d["timeline"]:
            y = rows.index(t["agent"])
            began = t["start"] + t.get("queued", 0.0)
            ax.barh(y, t["end"] - began, left=began, height=.55, color=light)
            train = t.get("train_s")
            if train:                       # the part that actually held the GPU
                ax.barh(y, train, left=t["end"] - train, height=.55, color=dark)
        for i, a in enumerate(names, start=1):
            last = max((t for t in d["timeline"] if t["agent"] == a), key=lambda t: t["end"])
            best = min((t["loss"] for t in d["timeline"]
                        if t["agent"] == a and t["loss"] is not None), default=None)
            if best is not None:
                ax.text(last["end"] + span * .006, i, f"{best:.4f}", va="center", fontsize=8)

        ax.set_yticks(range(len(rows)))
        ax.set_yticklabels(rows, fontsize=9)
        ax.invert_yaxis()
        ax.set_xlim(0, span * 1.08)
        ax.grid(axis="x", alpha=.25)
        ax.set_axisbelow(True)
        ax.set_title(f"{d['agents']} agents x {d['vgpu']:g} vGPU   —   "
                     f"{d['wall_s']}s · {d['experiments']} experiments",
                     fontsize=10, loc="left")

    axes[-1][0].set_xlabel("seconds since the config started", fontsize=9)
    handles = [plt.Rectangle((0, 0), 1, 1, color=c) for c in ("#c9ced4", "#2b7bba", "#bcd8ec")]
    fig.legend(handles, ["setup (prep + forks)", "on GPU (the training run)",
                         "agent alive, waiting on the model"],
               loc="upper right", fontsize=8, frameon=False)
    total = sum(d["experiments"] for d in loaded)
    fig.suptitle(f"Same {total // len(loaded)} experiments per config, same host: "
                 f"slicing vs whole GPUs", fontsize=11.5, x=.02, ha="left")
    fig.tight_layout(rect=[0, 0, 1, .92])
    out = where / "timeline.png"
    fig.savefig(out, dpi=150)
    plt.close(fig)
    print(f"wrote {out}")


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

    fig, ax = plt.subplots(1, 2, figsize=(7.4, 3.4))
    for i, (key, title, fmt) in enumerate([
        ("wall_s", "wall clock (s)", "{:.0f}"),
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
