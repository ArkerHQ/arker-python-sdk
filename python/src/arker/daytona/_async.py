"""`AsyncDaytona` + `AsyncSandbox` — thread-pool wrappers around the sync
shim. Until Arker ships a native async HTTP client, all async calls hop
through `asyncio.to_thread`. Network latency dominates so the hop is free.

DRY: zero method-body duplication — each async method is a proxy.
"""

from __future__ import annotations

import asyncio
from typing import Any, Callable

from ._client import Daytona
from ._sandbox import Sandbox
from ._types import DaytonaConfig


async def _to_thread(fn: Callable[..., Any], *args: Any, **kwargs: Any) -> Any:
    return await asyncio.to_thread(fn, *args, **kwargs)


class _AsyncProcess:
    def __init__(self, sync_sbx: Sandbox) -> None:
        self._sync = sync_sbx

    async def exec(self, command: str, **kwargs: Any) -> Any:
        return await _to_thread(self._sync.process.exec, command, **kwargs)

    async def code_run(self, code: str, *args: Any, **kwargs: Any) -> Any:
        return await _to_thread(self._sync.process.code_run, code, *args, **kwargs)

    async def create_session(self, sid: str) -> None:
        return await _to_thread(self._sync.process.create_session, sid)

    async def list_sessions(self) -> Any:
        return await _to_thread(self._sync.process.list_sessions)

    async def get_session(self, sid: str) -> Any:
        return await _to_thread(self._sync.process.get_session, sid)

    async def delete_session(self, sid: str) -> None:
        return await _to_thread(self._sync.process.delete_session, sid)

    async def execute_session_command(self, sid: str, req: Any, timeout: int | None = None) -> Any:
        return await _to_thread(self._sync.process.execute_session_command, sid, req, timeout)

    async def get_session_command(self, sid: str, cid: str) -> Any:
        return await _to_thread(self._sync.process.get_session_command, sid, cid)

    async def get_session_command_logs(self, sid: str, cid: str) -> Any:
        return await _to_thread(self._sync.process.get_session_command_logs, sid, cid)

    # Methods that throw on the sync side throw the same way here.

    async def get_entrypoint_session(self) -> Any:
        return await _to_thread(self._sync.process.get_entrypoint_session)

    async def get_entrypoint_logs(self) -> Any:
        return await _to_thread(self._sync.process.get_entrypoint_logs)

    async def get_entrypoint_logs_async(self, *args: Any, **kwargs: Any) -> Any:
        return await _to_thread(self._sync.process.get_entrypoint_logs_async, *args, **kwargs)

    async def get_session_command_logs_async(self, *args: Any, **kwargs: Any) -> Any:
        return await _to_thread(self._sync.process.get_session_command_logs_async, *args, **kwargs)

    async def send_session_command_input(self, sid: str, cid: str, data: str) -> None:
        return await _to_thread(self._sync.process.send_session_command_input, sid, cid, data)


class _AsyncFileSystem:
    def __init__(self, sync_sbx: Sandbox) -> None:
        self._sync = sync_sbx

    async def upload_file(self, file: Any, remote_path: str, **kwargs: Any) -> None:
        return await _to_thread(self._sync.fs.upload_file, file, remote_path, **kwargs)

    async def download_file(self, remote_path: str, local_path: str | None = None, **kwargs: Any) -> Any:
        return await _to_thread(self._sync.fs.download_file, remote_path, local_path, **kwargs)

    async def list_files(self, path: str) -> Any:
        return await _to_thread(self._sync.fs.list_files, path)

    async def create_folder(self, path: str, mode: str = "755") -> None:
        return await _to_thread(self._sync.fs.create_folder, path, mode)

    async def delete_file(self, path: str, recursive: bool = False) -> None:
        return await _to_thread(self._sync.fs.delete_file, path, recursive)

    async def get_file_info(self, path: str) -> Any:
        return await _to_thread(self._sync.fs.get_file_info, path)

    async def move_files(self, source: str, destination: str) -> None:
        return await _to_thread(self._sync.fs.move_files, source, destination)

    async def find_files(self, path: str, pattern: str) -> Any:
        return await _to_thread(self._sync.fs.find_files, path, pattern)

    async def set_file_permissions(self, path: str, **kwargs: Any) -> None:
        return await _to_thread(self._sync.fs.set_file_permissions, path, **kwargs)


class AsyncSandbox:
    """Async drop-in for daytona's `AsyncSandbox`. Construct via
    `AsyncDaytona.create()` / `.get()` etc. — not directly."""

    def __init__(self, _sync: Sandbox) -> None:
        self._sync = _sync
        self.process = _AsyncProcess(_sync)
        self.fs = _AsyncFileSystem(_sync)

    @property
    def id(self) -> str:
        return self._sync.id

    @property
    def env(self) -> dict[str, str]:
        return self._sync.env

    @property
    def labels(self) -> dict[str, str]:
        return self._sync.labels

    @property
    def state(self) -> Any:
        return self._sync.state

    @property
    def snapshot(self) -> str | None:
        return self._sync.snapshot

    async def delete(self, timeout: float | None = 60) -> None:
        return await _to_thread(self._sync.delete, timeout)

    async def start(self, timeout: float | None = 60) -> None:
        return await _to_thread(self._sync.start, timeout)

    async def stop(self, timeout: float | None = 60, force: bool = False) -> None:
        return await _to_thread(self._sync.stop, timeout, force)

    async def archive(self) -> None:
        return await _to_thread(self._sync.archive)

    async def set_labels(self, labels: dict[str, str]) -> dict[str, str]:
        return await _to_thread(self._sync.set_labels, labels)

    async def __aenter__(self) -> "AsyncSandbox":
        return self

    async def __aexit__(self, *_exc: Any) -> None:
        try:
            await self.delete()
        except Exception:
            pass


class AsyncDaytona:
    """Async drop-in for `daytona.AsyncDaytona`.

    Construct directly or use `async with AsyncDaytona(config) as d:`. The
    underlying Arker client construction is thread-pool-wrapped so the
    event loop stays responsive even on cold start.
    """

    def __init__(self, config: DaytonaConfig | None = None, *, _sync: Daytona | None = None) -> None:
        self._sync = _sync or Daytona(config)

    async def create(self, **kwargs: Any) -> AsyncSandbox:
        sandbox = await _to_thread(self._sync.create, **kwargs)
        return AsyncSandbox(sandbox)

    async def get(self, sandbox_id: str) -> AsyncSandbox:
        sandbox = await _to_thread(self._sync.get, sandbox_id)
        return AsyncSandbox(sandbox)

    async def list(self) -> list[AsyncSandbox]:
        sandboxes = await _to_thread(self._sync.list)
        return [AsyncSandbox(s) for s in sandboxes]

    async def find(self, **filters: Any) -> AsyncSandbox | None:
        sandbox = await _to_thread(self._sync.find, **filters)
        return AsyncSandbox(sandbox) if sandbox is not None else None

    async def remove(self, sandbox_id: str) -> None:
        return await _to_thread(self._sync.remove, sandbox_id)

    async def close(self) -> None:
        # Symmetry with daytona's API; nothing to release on our side.
        return None

    async def __aenter__(self) -> "AsyncDaytona":
        return self

    async def __aexit__(self, *_exc: Any) -> None:
        await self.close()
