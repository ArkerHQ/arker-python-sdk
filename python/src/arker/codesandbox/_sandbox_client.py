"""`SandboxClient` — returned by `Sandbox.connect()`.

Holds `.commands`, `.fs`. Mirrors `@codesandbox/sdk` SandboxClient.
Long-running primitives (`.shells`, `.tasks`, `.ports`, `.interpreters`,
`.hosts`) throw NotImplementedError — they need WS / persistent connection
plumbing we don't have.
"""

from __future__ import annotations

import logging
from typing import TYPE_CHECKING

from ._commands import Commands
from ._filesystem import Filesystem

if TYPE_CHECKING:
    from ._sandbox import Sandbox

logger = logging.getLogger("arker.codesandbox")


class _NotImplementedNamespace:
    def __init__(self, name: str, reason: str) -> None:
        self._name = name
        self._reason = reason

    def __getattr__(self, attr: str):
        raise NotImplementedError(
            f"arker.codesandbox: SandboxClient.{self._name}.{attr} is not "
            f"supported — {self._reason}"
        )


class SandboxClient:
    """Returned by `Sandbox.connect()`. Tied to a Sandbox lifetime."""

    def __init__(self, sandbox: "Sandbox") -> None:
        self._sandbox = sandbox
        self._disposed = False
        self.commands = Commands(self)
        self.fs = Filesystem(self)
        self.shells = _NotImplementedNamespace(
            "shells",
            "interactive shells need a WS client we haven't shipped",
        )
        self.tasks = _NotImplementedNamespace(
            "tasks",
            "task definitions are codesandbox-specific project metadata",
        )
        self.ports = _NotImplementedNamespace(
            "ports",
            "port previews need a persistent tunnel URL bound to the sandbox lifetime",
        )
        self.interpreters = _NotImplementedNamespace(
            "interpreters",
            "stateful interpreters need a long-running kernel",
        )
        self.hosts = _NotImplementedNamespace(
            "hosts",
            "host tokens are codesandbox auth-server primitives",
        )

    def disconnect(self) -> None:
        """Local-only cleanup. We don't hold a persistent connection."""
        self._disposed = True
