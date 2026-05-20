"""Drop-in shim for `e2b.Sandbox`, backed by Arker VMs."""

from __future__ import annotations

import datetime as _dt
import logging
import os
import warnings
from typing import Any

from ..computer import Arker, ArkerError, Computer
from ._commands import Commands
from ._files import Filesystem
from ._handle import CommandHandle
from ._pty import Pty
from ._types import SandboxInfo

logger = logging.getLogger("arker.e2b")

DEFAULT_TEMPLATE_ENV = "ARKER_E2B_DEFAULT_TEMPLATE"
DEFAULT_TEMPLATE = "base"


def _resolve_template(template: str | None) -> str:
    if template:
        return template
    return os.environ.get(DEFAULT_TEMPLATE_ENV, DEFAULT_TEMPLATE)


def _build_arker(api_key: str | None) -> Arker:
    return Arker(api_key=api_key)


def _parse_dt(value: Any) -> _dt.datetime | None:
    if not isinstance(value, str) or not value:
        return None
    try:
        return _dt.datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError:
        return None


def _warn_timeout_noop(value: int) -> None:
    # TODO(arker-e2b): wire to a real server-side TTL once core Arker SDK
    # exposes a mutable VM lifetime endpoint. e2b's `timeout` bounds billing;
    # ours currently doesn't. See pending-work item #1 in __init__.py.
    warnings.warn(
        f"arker.e2b: Sandbox timeout={value} is stored locally only — "
        "Arker has no server-side auto-kill yet. VMs will live until "
        "explicitly killed. Track follow-up for SDK-level TTL support.",
        stacklevel=3,
    )


class _KillDispatcher:
    """Descriptor mimicking e2b's `@class_method_variant` — supports BOTH
    `sandbox.kill()` (instance) and `Sandbox.kill(sandbox_id)` (static)."""

    def __set_name__(self, owner: type, name: str) -> None:
        self._name = name

    def __get__(self, obj: Any, objtype: type | None = None) -> Any:
        if obj is None:
            def static_kill(sandbox_id: str, *, api_key: str | None = None, **_: Any) -> bool:
                arker = _build_arker(api_key)
                try:
                    return bool(arker.vm(sandbox_id).delete().deleted)
                except ArkerError:
                    return False
            return static_kill
        return lambda request_timeout=None: obj._instance_kill(request_timeout)


class _SetTimeoutDispatcher:
    """Same dual-dispatch trick for `set_timeout`."""

    def __get__(self, obj: Any, objtype: type | None = None) -> Any:
        if obj is None:
            def static_set_timeout(sandbox_id: str, timeout: int, *, api_key: str | None = None, **_: Any) -> None:
                # No remote effect — see warning emitted at instance use too.
                _warn_timeout_noop(timeout)
                logger.debug("arker.e2b: static set_timeout(%s, %d) — no remote effect", sandbox_id, timeout)
            return static_set_timeout
        return lambda timeout, request_timeout=None: obj._instance_set_timeout(timeout)


class Sandbox:
    """e2b.Sandbox drop-in.

    Supports:
    - Constructor (fork-from-template or attach-by-sandbox_id)
    - `Sandbox(...)` context manager — `with Sandbox() as sbx:` auto-kills
    - `.kill()` instance / `Sandbox.kill(sandbox_id)` static
    - `Sandbox.connect(sandbox_id)`, `Sandbox.list()`
    - `.set_timeout(secs)` / `Sandbox.set_timeout(id, secs)` — both warn
      that the value is local-only until Arker ships SDK-level TTL.
    - `.commands.run`, `.files.read/write/list/...`, `.pty.*` (raises),
      and `.sandbox_id` / `.is_running()` / `.timeout`
    """

    def __init__(
        self,
        template: str | None = None,
        *,
        timeout: int | None = None,
        metadata: dict[str, str] | None = None,
        envs: dict[str, str] | None = None,
        api_key: str | None = None,
        domain: str | None = None,
        debug: bool | None = None,
        sandbox_id: str | None = None,
        request_timeout: float | None = None,
        _arker: Arker | None = None,
        _computer: Computer | None = None,
    ) -> None:
        self._arker = _arker or _build_arker(api_key)

        if _computer is not None:
            self._computer = _computer
        elif sandbox_id:
            self._computer = self._arker.vm(sandbox_id)
        else:
            source = _resolve_template(template)
            name = (metadata or {}).get("name") if metadata else None
            self._computer = self._arker.vm(source).fork(name=name)

        self._template = template
        self._timeout = timeout
        self._metadata = dict(metadata or {})
        self._default_envs: dict[str, str] = dict(envs or {})
        self._bg_runs: dict[int, tuple[str, str]] = {}  # pid -> (run_id, cmd)
        self._next_pid = 1

        if timeout is not None:
            _warn_timeout_noop(timeout)

        self.commands = Commands(self)
        self.files = Filesystem(self)
        self.pty = Pty(self)

    # Context manager — e2b's blessed `with Sandbox() as sbx:` idiom.
    def __enter__(self) -> "Sandbox":
        return self

    def __exit__(self, *_exc: Any) -> None:
        try:
            self.kill()
        except Exception:
            pass

    def _register_run(self, run_id: str, cmd: str) -> CommandHandle:
        pid = self._next_pid
        self._next_pid += 1
        self._bg_runs[pid] = (run_id, cmd)
        return CommandHandle(self, pid, run_id, cmd)

    def _run_id_for(self, pid: int) -> str | None:
        entry = self._bg_runs.get(pid)
        return entry[0] if entry else None

    def _forget_pid(self, pid: int) -> None:
        self._bg_runs.pop(pid, None)

    @property
    def sandbox_id(self) -> str:
        return self._computer.id

    kill = _KillDispatcher()
    set_timeout = _SetTimeoutDispatcher()

    def _instance_kill(self, request_timeout: float | None = None) -> bool:
        try:
            return bool(self._computer.delete().deleted)
        except ArkerError:
            return False

    def _instance_set_timeout(self, timeout: int) -> None:
        self._timeout = timeout
        _warn_timeout_noop(timeout)

    def is_running(self, request_timeout: float | None = None) -> bool:
        try:
            return self._arker.get(self._computer.id).state == "running"
        except ArkerError:
            return False

    @property
    def timeout(self) -> int | None:
        return self._timeout

    @classmethod
    def connect(
        cls,
        sandbox_id: str,
        *,
        api_key: str | None = None,
        domain: str | None = None,
        debug: bool | None = None,
    ) -> "Sandbox":
        return cls(sandbox_id=sandbox_id, api_key=api_key, domain=domain, debug=debug)

    @classmethod
    def list(
        cls,
        *,
        api_key: str | None = None,
        domain: str | None = None,
        debug: bool | None = None,
        request_timeout: float | None = None,
    ) -> list[SandboxInfo]:
        """List sandboxes owned by the current API key.

        Maps Arker `VmInfo` → e2b `SandboxInfo`. Metadata isn't stored
        remotely, so the `metadata` field is always `{}`. Datetime fields
        are parsed to `datetime` to match e2b's shape; if Arker returns
        a malformed timestamp, the field stays None.

        TODO(arker-e2b): honor e2b's `metadata` filter once Arker stores
        per-VM metadata server-side. See pending-work item #8 in __init__.py.
        """
        arker = _build_arker(api_key)
        infos = arker.list().vms
        out: list[SandboxInfo] = []
        for vm in infos:
            started = _parse_dt(vm.created_at)
            if started is None:
                continue  # skip rows with malformed timestamps
            out.append(SandboxInfo(
                sandbox_id=vm.vm_id,
                template_id=vm.source_golden,
                name=vm.name,
                metadata={},
                started_at=started,
                end_at=_parse_dt(vm.last_activity),
            ))
        return out
