"""`sandbox.files` namespace — full Phase A+C surface.

Native operations (`read` / `write`) use Arker's `sync` HTTP API. Everything
else (`list`, `exists`, `remove`, `rename`, `make_dir`) is shell-shimmed via
`Computer.run` since Arker doesn't expose them natively.
"""

from __future__ import annotations

import logging
import os
import shlex
from typing import TYPE_CHECKING, Any, Iterator, Literal, overload

from ..computer import CompletedRunResult
from ._types import EntryInfo, FileType

if TYPE_CHECKING:
    from ._sandbox import Sandbox

logger = logging.getLogger("arker.e2b")


# `find ... -printf` emits one line per entry: "<name>|<type>"
#   %f = filename (no leading path)
#   %y = type letter: f=file, d=dir, l=symlink, ...
_FIND_FMT = "%f|%y\\n"
_FIND_TYPE_TO_ENUM = {"f": FileType.FILE, "d": FileType.DIR}


class WatchHandle:
    """Inert watch handle — Arker has no fs-event API."""

    def __enter__(self) -> "WatchHandle":
        return self

    def __exit__(self, *_: Any) -> None:
        return None

    def stop(self) -> None:
        return None


class Filesystem:
    def __init__(self, sandbox: "Sandbox") -> None:
        self._sandbox = sandbox

    # ------------------------------------------------------------------
    # Native ops (Arker sync API)

    @overload
    def read(self, path: str, *, format: Literal["text"] = "text", user: str = "user", request_timeout: float | None = None) -> str: ...
    @overload
    def read(self, path: str, *, format: Literal["bytes"], user: str = "user", request_timeout: float | None = None) -> bytearray: ...
    @overload
    def read(self, path: str, *, format: Literal["stream"], user: str = "user", request_timeout: float | None = None) -> Iterator[bytes]: ...

    def read(
        self,
        path: str,
        *,
        format: str = "text",
        user: str = "user",
        request_timeout: float | None = None,
    ) -> Any:
        if format == "stream":
            raise NotImplementedError(
                "arker.e2b: files.read(format='stream') is not supported — "
                "Arker's sync API returns the whole file. Use format='bytes' "
                "and stream from there if needed."
            )
        data = self._sandbox._computer.sync.read_file(path)
        if format == "bytes":
            return bytearray(data)
        return data.decode("utf-8", errors="replace")

    def write(
        self,
        path: str,
        data: bytes | str,
        *,
        user: str = "user",
        request_timeout: float | None = None,
    ) -> EntryInfo:
        self._sandbox._computer.sync.write_file(path, data)
        return EntryInfo(name=os.path.basename(path), type=FileType.FILE, path=path)

    # ------------------------------------------------------------------
    # Shell-shim ops

    def list(self, path: str, *, user: str = "user", request_timeout: float | None = None) -> list[EntryInfo]:
        stdout, _, exit_code = self._shell(f"find {shlex.quote(path)} -maxdepth 1 -mindepth 1 -printf {shlex.quote(_FIND_FMT)}")
        if exit_code != 0:
            return []
        entries: list[EntryInfo] = []
        for line in stdout.splitlines():
            if not line or "|" not in line:
                continue
            name, _, kind = line.rpartition("|")
            entries.append(EntryInfo(
                name=name,
                type=_FIND_TYPE_TO_ENUM.get(kind, FileType.FILE),
                path=f"{path.rstrip('/')}/{name}",
            ))
        return entries

    def exists(self, path: str, *, user: str = "user", request_timeout: float | None = None) -> bool:
        _, _, exit_code = self._shell(f"test -e {shlex.quote(path)}")
        return exit_code == 0

    def remove(self, path: str, *, user: str = "user", request_timeout: float | None = None) -> None:
        self._shell(f"rm -rf {shlex.quote(path)}")

    def rename(self, old_path: str, new_path: str, *, user: str = "user", request_timeout: float | None = None) -> EntryInfo:
        self._shell(f"mv {shlex.quote(old_path)} {shlex.quote(new_path)}")
        return EntryInfo(name=os.path.basename(new_path), type=FileType.FILE, path=new_path)

    def make_dir(self, path: str, *, user: str = "user", request_timeout: float | None = None) -> bool:
        _, _, exit_code = self._shell(f"mkdir -p {shlex.quote(path)}")
        return exit_code == 0

    def watch_dir(self, path: str, *, user: str = "user", request_timeout: float | None = None) -> WatchHandle:
        raise NotImplementedError(
            "arker.e2b: files.watch_dir is not supported — Arker has no "
            "filesystem-event API. Poll files.list / files.exists if needed."
        )

    # ------------------------------------------------------------------
    # Internals

    def _shell(self, cmd: str) -> tuple[str, str, int]:
        """Run a shell command and return decoded (stdout, stderr, exit_code)
        without raising on nonzero. The public `commands.run` wrapper raises;
        the shell-shim ops here interpret exit codes (e.g. test -e returns 1
        for "missing") so they need the raw result.
        """
        result = self._sandbox._computer.run(cmd)
        if not isinstance(result, CompletedRunResult):
            raise RuntimeError(f"unexpected run result type {type(result).__name__}")
        return (
            result.stdout.decode("utf-8", errors="replace"),
            result.stderr.decode("utf-8", errors="replace"),
            result.exit_code,
        )
