"""Thin Arker API client shared by the fleet scripts. Stdlib only."""

import json
import os
import time
import urllib.error
import urllib.request

# Used when ARKER_BASE_URL is unset — the region carrying GPU platforms.
DEFAULT_BASE_URL = "https://arker-us-west.arker.ai"


def _base_url():
    """API root. ARKER_BASE_URL may include the `/api` suffix or omit it."""
    raw = (os.environ.get("ARKER_BASE_URL") or DEFAULT_BASE_URL).rstrip("/")
    return raw[:-len("/api")] if raw.endswith("/api") else raw


BASE = _base_url()
KEY = os.environ.get("ARKER_API_KEY", "")

# How long a foreground run may block before the API hands it back.
SYNC_WINDOW_SECS = 80


class ApiError(Exception):
    def __init__(self, status, body, code=None, retry_after=None):
        super().__init__(f"HTTP {status}: {body[:400]}")
        self.status = status
        self.body = body
        self.code = code
        self.retry_after = retry_after


def api(method, path, payload=None, timeout=180):
    """One HTTP call against /api/v1. Raises ApiError on non-2xx."""
    if not KEY:
        raise SystemExit("ARKER_API_KEY must be set — export it first")
    data = json.dumps(payload).encode() if payload is not None else None
    req = urllib.request.Request(f"{BASE}/api{path}", data=data, method=method)
    req.add_header("Authorization", f"Bearer {KEY}")
    req.add_header("User-Agent", "arker-gpu-agent-fleet/1.0")
    if data:
        req.add_header("Content-Type", "application/json")
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            raw = r.read().decode()
            return json.loads(raw) if raw else {}
    except urllib.error.HTTPError as e:
        raw = e.read().decode()
        code = retry = None
        try:
            err = (json.loads(raw) or {}).get("error") or {}
            code, retry = err.get("code"), err.get("retry_after")
        except Exception:
            pass
        raise ApiError(e.code, raw, code, retry) from None
    except Exception as e:
        raise ApiError(0, f"{type(e).__name__}: {e}") from None


# ── VM lifecycle ───────────────────────────────────────────────────────────


def fork_vm(name, source_name=None, source_vm_id=None, resources=None,
            platforms=None, egress=True, policies=None, timeout=300,
            source_org_id=None):
    """Fork a VM.

    `policies` is passed at fork, not set later: the guest only trusts a policy
    attached as the VM is created. `source_org_id` qualifies `source_name`,
    which otherwise resolves against your own org.
    """
    body = {"name": name}
    if source_vm_id:
        body["source_vm_id"] = source_vm_id
    else:
        body["source_vm_name"] = source_name
        if source_org_id:
            body["source_org_id"] = source_org_id
        if platforms:
            body["platforms"] = platforms
    if resources:
        body["resources"] = resources
    if policies is not None:
        body["policies"] = policies
    elif egress:
        body["policies"] = {}
    return api("POST", "/v1/fork", body, timeout=timeout)


def get_policies(vm_id):
    """The VM's stored policy doc. Secret VALUES come back masked as `***`."""
    return api("GET", f"/v1/vms/{vm_id}/policies", timeout=60)


def get_vm(vm_id):
    return api("GET", f"/v1/vms/{vm_id}", timeout=60)


def delete_vm(vm_id):
    return api("DELETE", f"/v1/vms/{vm_id}", timeout=180)


def delete_vm_retry(vm_id, attempts=6, floor=2.0):
    """delete_vm that retries; 404 counts as success.

    A VM holds its GPU slice until it is gone, so one transient 503 here is the
    difference between a clean run and a leaked slice.

    Returns None once the VM is gone, or the last ApiError if it never went.
    """
    last = None
    for i in range(attempts):
        try:
            delete_vm(vm_id)
            return None
        except ApiError as e:
            if e.status == 404:
                return None
            last = e
            # A 4xx other than 429 will not improve on retry.
            if e.status and 400 <= e.status < 500 and e.status != 429:
                break
            try:
                hinted = float(e.retry_after or 0)
            except (TypeError, ValueError):
                hinted = 0.0
            time.sleep(max(floor * (i + 1), hinted))
    return last


# ── runs ───────────────────────────────────────────────────────────────────


def run_sync(vm_id, command, session_idx=1, timeout=600):
    """Foreground run, bounded by SYNC_WINDOW_SECS."""
    body = {
        "command": command,
        "session_idx": session_idx,
        "timeout": timeout,
        "time_to_background": SYNC_WINDOW_SECS,
    }
    return api("POST", f"/v1/vms/{vm_id}/runs", body, timeout=SYNC_WINDOW_SECS + 40)


def is_suspend_race(r):
    """A run that landed while the VM was suspending — transient, so retry.

    The next run restores the VM.
    """
    return r.get("exit_code") == 128 and "in state stopped" in (r.get("stderr") or "")


def run_sync_retry(vm_id, command, attempts=4, **kw):
    """run_sync that retries the suspend race and transient errors."""
    last = None
    for i in range(attempts):
        try:
            r = run_sync(vm_id, command, **kw)
        except ApiError as e:
            last = e
            time.sleep(5 + 5 * i)
            continue
        if not is_suspend_race(r):
            return r
        last = r
        time.sleep(10 + 10 * i)
    if isinstance(last, ApiError):
        raise last
    return last


def stdout_of(r):
    return r.get("stdout") or r.get("output") or ""
