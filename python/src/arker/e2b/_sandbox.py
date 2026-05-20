"""Drop-in shim for `e2b.Sandbox`, backed by Arker VMs."""

from __future__ import annotations

import os
from typing import TYPE_CHECKING

from ..computer import Arker, ArkerError, Computer
from ._commands import Commands
from ._files import Filesystem
from ._handle import CommandHandle
from ._pty import Pty

if TYPE_CHECKING:
    pass

DEFAULT_TEMPLATE_ENV = "ARKER_E2B_DEFAULT_TEMPLATE"
DEFAULT_TEMPLATE = "ubuntu"


def _resolve_template(template: str | None) -> str:
    if template:
        return template
    return os.environ.get(DEFAULT_TEMPLATE_ENV, DEFAULT_TEMPLATE)


def _build_arker(api_key: str | None) -> Arker:
    """Build an Arker client, deferring api_key/region resolution to Arker itself.

    The Arker constructor already reads ARKER_API_KEY / ARKER_REGION /
    ARKER_BASE_URL from the env, so we only forward an explicit api_key.
    """
    return Arker(api_key=api_key)


class Sandbox:
    """e2b.Sandbox drop-in. Phase A surface:

    - Constructor (create-from-template or connect-to-existing)
    - `.kill()` instance method, `Sandbox.kill(sandbox_id)` static
    - `Sandbox.connect(sandbox_id)` classmethod
    - `.commands.run(cmd, ...)` foreground exec
    - `.files.read(path, format=...)`, `.files.write(path, data)`
    - `.sandbox_id` property
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

        self.commands = Commands(self)
        self.files = Filesystem(self)
        self.pty = Pty(self)

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

    def kill(self, request_timeout: float | None = None) -> bool:
        try:
            return bool(self._computer.delete().deleted)
        except ArkerError:
            return False

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

