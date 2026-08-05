"""Command migration: move a running command (by PID) into an Arker VM.

This is the config-driven engine — every command-specific detail lives in
``command_migration.json`` (loaded here), so the same recipes drive the Python,
TypeScript, and CLI SDKs and adding a command is a config entry, not code.

No CRIU: we sync the command's working dir + its on-disk resumable transcript
and re-invoke the command's own resume entrypoint in the VM. Works for any
command that (a) persists a transcript and (b) can resume from it.
"""
from __future__ import annotations

import glob as _glob
import json
import os
import re
import signal
import time
from pathlib import Path
from typing import Any, Optional

_CONFIG: Optional[dict] = None


def load_config() -> dict:
    """Load (and cache) the declarative command-migration recipe map."""
    global _CONFIG
    if _CONFIG is None:
        with open(Path(__file__).with_name("command_migration.json")) as fh:
            _CONFIG = json.load(fh)
    return _CONFIG


def _cwd_key(cwd: str) -> str:
    return re.sub(r"[^A-Za-z0-9]", "-", cwd)


def _subst(template: str, vars: dict[str, str]) -> str:
    out = template
    for k, v in vars.items():
        out = out.replace("${" + k + "}", v)
    return os.path.expanduser(out)


def _detect(argv: str, spec: dict) -> bool:
    if "argv_contains" in spec:
        return spec["argv_contains"] in argv
    if "argv_regex" in spec:
        return re.search(spec["argv_regex"], argv) is not None
    return False


def _find_session(spec: dict, vars: dict[str, str]) -> tuple[Optional[str], Optional[str]]:
    pattern = _subst(spec["glob"], vars)
    matches = sorted(_glob.glob(pattern, recursive=True), key=os.path.getmtime)
    if not matches:
        return None, None
    path = matches[-1] if spec.get("pick", "newest_mtime") == "newest_mtime" else matches[-1]
    idspec = spec.get("id", "stem")
    if idspec == "stem":
        sid = Path(path).stem
    elif idspec == "session_path":
        sid = path
    elif isinstance(idspec, dict) and "regex" in idspec:
        m = re.search(idspec["regex"], os.path.basename(path))
        sid = m.group(1) if m else Path(path).stem
    else:
        sid = Path(path).stem
    return path, sid


def discover(pid: int) -> dict:
    """Inspect /proc/<pid> and match it to a recipe. Returns the migration plan."""
    cfg = load_config()
    cwd = os.readlink(f"/proc/{pid}/cwd")
    argv = " ".join(
        c for c in open(f"/proc/{pid}/cmdline", "rb").read().decode("utf8", "replace").split("\0") if c
    ).lower()
    environ: dict[str, str] = {}
    for e in open(f"/proc/{pid}/environ", "rb").read().decode("utf8", "replace").split("\0"):
        if "=" in e:
            k, v = e.split("=", 1)
            environ[k] = v
    command = next((name for name, spec in cfg["commands"].items() if _detect(argv, spec["detect"])), None)
    session_path = session_id = None
    if command:
        vars = {"cwd": cwd, "cwd_key": _cwd_key(cwd)}
        session_path, session_id = _find_session(cfg["commands"][command]["session"], vars)
    return dict(cwd=cwd, command=command, environ=environ, session_path=session_path, session_id=session_id)


def quiesce(session_path: Optional[str], timeout: Optional[float] = None, stable_secs: Optional[float] = None) -> bool:
    """Wait until the transcript stops growing (in-flight turn flushed). True if it settled."""
    cfg = load_config().get("quiesce", {})
    timeout = timeout if timeout is not None else cfg.get("timeout_secs", 30)
    stable_secs = stable_secs if stable_secs is not None else cfg.get("stable_secs", 2.0)
    if not session_path or not os.path.exists(session_path):
        return True
    last, stable_at, t0 = -1, None, time.time()
    while time.time() - t0 < timeout:
        sz = os.path.getsize(session_path)
        if sz == last:
            if stable_at and time.time() - stable_at >= stable_secs:
                return True
        else:
            last, stable_at = sz, time.time()
        time.sleep(0.4)
    return False


def migrate(
    client,
    *,
    pid: int,
    source: str = "ubuntu-small",
    memory_mib: int = 2048,
    do_quiesce: bool = True,
    freeze_local: bool = False,
    kill_local: bool = False,
    probe: str = "In one short line: what were you last doing?",
    keys: Optional[dict[str, str]] = None,
):
    """Migrate the running command at ``pid`` into a fresh Arker VM and resume it.

    Returns (vm, resumed_output). Purely client-side: uses the SDK's fork + sync
    + run under the hood — no special server route.
    """
    cfg = load_config()
    info = discover(pid)
    command = info["command"]
    if command is None:
        raise ValueError(
            f"pid {pid} is not a recognized migratable command (no matching recipe in command_migration.json)"
        )
    spec = cfg["commands"][command]
    cwd, environ = info["cwd"], info["environ"]
    sid, spath = info["session_id"], info["session_path"]
    vars = {"cwd": cwd, "cwd_key": _cwd_key(cwd), "session_id": sid or "", "probe": json.dumps(probe)}

    if do_quiesce and not quiesce(spath):
        # completed turns are on disk; only the current unflushed turn is lost
        pass
    if freeze_local:
        os.kill(pid, signal.SIGSTOP)

    vm = client.fork(source, memory_mib=memory_mib)
    vm.run(f"mkdir -p {cwd}")
    vm.sync_dir(cwd, cwd.lstrip("/"))
    vm.run(spec["install"])

    # place the transcript
    if spath and os.path.exists(spath):
        place = spec["place"]
        if isinstance(place, dict) and "verbatim_under" in place:
            root = os.path.expanduser(place["from_host_root"])
            dest = place["verbatim_under"] + "/" + os.path.relpath(spath, root)
        else:
            dest = _subst(place, vars)
        vm.sync(dest, open(spath, "rb").read())

    # extra config files (resolve placeholders inside the JSON)
    for vm_path, body in spec.get("extra_files", {}).items():
        if "json" in body:
            raw = _subst(json.dumps(body["json"]), vars)
            vm.sync(_subst(vm_path, vars), raw.encode())

    # forward keys (explicit override wins over discovered environ) + recipe env
    key_env = keys or {k: environ[k] for k in spec.get("keys", []) if environ.get(k)}
    proc_env = dict(spec.get("env", {}))
    proc_env.update(key_env)

    sess = vm.create_session(env=proc_env, cwd=cwd)
    r = vm.run(_subst(spec["resume"], vars), session_id=sess.session_id, timeout=180)
    out = getattr(r, "stdout", b"") or b""
    out = out.decode("utf8", "replace") if isinstance(out, (bytes, bytearray)) else str(out)

    if kill_local:
        try:
            os.kill(pid, signal.SIGTERM)
        except Exception:
            pass
    return vm, out
