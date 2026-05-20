"""`AsyncSandbox` — async wrapper around the sync `Sandbox`.

Until Arker ships a native async HTTP client, this thread-pool-wraps the
sync SDK calls via `asyncio.to_thread`. Behaviorally equivalent to e2b's
AsyncSandbox; performance is dominated by network latency, so the
thread-pool hop adds negligible overhead.

DRY: this file does not re-implement any Arker-call logic. Each async
method is a thin proxy onto the corresponding sync method.
"""

from __future__ import annotations

import asyncio
from typing import Any, Callable

from ._handle import CommandHandle
from ._sandbox import Sandbox
from ._types import CommandResult, EntryInfo, ProcessInfo


async def _to_thread(fn: Callable[..., Any], *args: Any, **kwargs: Any) -> Any:
    return await asyncio.to_thread(fn, *args, **kwargs)


class _AsyncCommands:
    def __init__(self, sync_sbx: Sandbox) -> None:
        self._sync = sync_sbx

    async def run(self, cmd: str, **kwargs: Any) -> CommandResult | CommandHandle:
        return await _to_thread(self._sync.commands.run, cmd, **kwargs)

    async def list(self, **kwargs: Any) -> list[ProcessInfo]:
        return await _to_thread(self._sync.commands.list, **kwargs)

    async def kill(self, pid: int, **kwargs: Any) -> bool:
        return await _to_thread(self._sync.commands.kill, pid, **kwargs)

    async def send_stdin(self, pid: int, data: str, **kwargs: Any) -> None:
        return await _to_thread(self._sync.commands.send_stdin, pid, data, **kwargs)

    async def connect(self, pid: int, **kwargs: Any) -> CommandHandle:
        return await _to_thread(self._sync.commands.connect, pid, **kwargs)


class _AsyncFiles:
    def __init__(self, sync_sbx: Sandbox) -> None:
        self._sync = sync_sbx

    async def read(self, path: str, **kwargs: Any) -> Any:
        return await _to_thread(self._sync.files.read, path, **kwargs)

    async def write(self, path: str, data: bytes | str, **kwargs: Any) -> EntryInfo:
        return await _to_thread(self._sync.files.write, path, data, **kwargs)

    async def list(self, path: str, **kwargs: Any) -> list[EntryInfo]:
        return await _to_thread(self._sync.files.list, path, **kwargs)

    async def exists(self, path: str, **kwargs: Any) -> bool:
        return await _to_thread(self._sync.files.exists, path, **kwargs)

    async def remove(self, path: str, **kwargs: Any) -> None:
        return await _to_thread(self._sync.files.remove, path, **kwargs)

    async def rename(self, old_path: str, new_path: str, **kwargs: Any) -> EntryInfo:
        return await _to_thread(self._sync.files.rename, old_path, new_path, **kwargs)

    async def make_dir(self, path: str, **kwargs: Any) -> bool:
        return await _to_thread(self._sync.files.make_dir, path, **kwargs)

    async def watch_dir(self, path: str, **kwargs: Any) -> Any:
        return await _to_thread(self._sync.files.watch_dir, path, **kwargs)


class _AsyncPty:
    def __init__(self, sync_sbx: Sandbox) -> None:
        self._sync = sync_sbx

    async def create(self, *args: Any, **kwargs: Any) -> CommandHandle:
        return await _to_thread(self._sync.pty.create, *args, **kwargs)

    async def send_stdin(self, pid: int, data: bytes, **kwargs: Any) -> None:
        return await _to_thread(self._sync.pty.send_stdin, pid, data, **kwargs)

    async def resize(self, pid: int, size: Any, **kwargs: Any) -> None:
        return await _to_thread(self._sync.pty.resize, pid, size, **kwargs)

    async def kill(self, pid: int, **kwargs: Any) -> bool:
        return await _to_thread(self._sync.pty.kill, pid, **kwargs)


class AsyncSandbox:
    """Async drop-in for `e2b.AsyncSandbox`.

    Construct via `await AsyncSandbox.create(template=...)` to keep VM
    creation off the event loop. Direct construction is allowed but
    will block briefly on the fork call.
    """

    def __init__(self, *args: Any, _sync: Sandbox | None = None, **kwargs: Any) -> None:
        self._sync = _sync if _sync is not None else Sandbox(*args, **kwargs)
        self.commands = _AsyncCommands(self._sync)
        self.files = _AsyncFiles(self._sync)
        self.pty = _AsyncPty(self._sync)

    @property
    def sandbox_id(self) -> str:
        return self._sync.sandbox_id

    @classmethod
    async def create(cls, *args: Any, **kwargs: Any) -> "AsyncSandbox":
        sync = await asyncio.to_thread(Sandbox, *args, **kwargs)
        return cls(_sync=sync)

    @classmethod
    async def connect(cls, sandbox_id: str, **kwargs: Any) -> "AsyncSandbox":
        sync = await asyncio.to_thread(Sandbox.connect, sandbox_id, **kwargs)
        return cls(_sync=sync)

    async def kill(self, **kwargs: Any) -> bool:
        return await _to_thread(self._sync.kill, **kwargs)
