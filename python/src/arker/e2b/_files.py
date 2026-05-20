"""`sandbox.files` namespace — full surface.

Native operations (`read` / `write`) use Arker's `sync` HTTP API. Everything
else (`list`, `exists`, `remove`, `rename`, `make_dir`) is shell-shimmed via
`Computer.run` since Arker doesn't expose them natively.
"""

from __future__ import annotations

import datetime as _dt
import os
import shlex
import stat as _stat_mod
from typing import TYPE_CHECKING, Any, Iterator, Literal, overload

from ..computer import CompletedRunResult
from ._types import EntryInfo, FileType

if TYPE_CHECKING:
    from ._sandbox import Sandbox


# `find ... -printf "%f|%y|%s|%m|%u|%g|%T@|%l\n"` — one line per entry.
#   %f = name, %y = type (f/d/l/...), %s = size, %m = octal mode,
#   %u = user, %g = group, %T@ = mtime unix-ts, %l = symlink target
_FIND_FMT = "%f|%y|%s|%m|%u|%g|%T@|%l\\n"
_FIND_TYPE_TO_ENUM = {"f": FileType.FILE, "d": FileType.DIR}


def _parse_find_line(line: str, parent: str) -> EntryInfo | None:
    parts = line.split("|", 7)
    if len(parts) < 7:
        return None
    name, kind, size_s, mode_s, owner, group, mtime_s, *rest = parts
    symlink_target = rest[0] if rest else ""
    try:
        size = int(size_s) if size_s else 0
    except ValueError:
        size = 0
    try:
        mode = int(mode_s, 8) if mode_s else 0
    except ValueError:
        mode = 0
    try:
        mtime = _dt.datetime.fromtimestamp(float(mtime_s), tz=_dt.timezone.utc) if mtime_s else None
    except (ValueError, OSError):
        mtime = None
    return EntryInfo(
        name=name,
        type=_FIND_TYPE_TO_ENUM.get(kind, FileType.FILE),
        path=f"{parent.rstrip('/')}/{name}",
        size=size,
        mode=mode,
        permissions=_stat_mod.filemode(mode | _stat_mod.S_IFDIR if kind == "d" else mode) if mode else "",
        owner=owner,
        group=group,
        modified_time=mtime,
        symlink_target=symlink_target or None,
    )


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
        stdout, _, exit_code = self._shell(
            f"find {shlex.quote(path)} -maxdepth 1 -mindepth 1 -printf {shlex.quote(_FIND_FMT)}"
        )
        if exit_code != 0:
            return []
        entries: list[EntryInfo] = []
        for line in stdout.splitlines():
            if not line:
                continue
            entry = _parse_find_line(line, path)
            if entry:
                entries.append(entry)
        return entries

    def exists(self, path: str, *, user: str = "user", request_timeout: float | None = None) -> bool:
        _, _, exit_code = self._shell(f"test -e {shlex.quote(path)}")
        return exit_code == 0

    def remove(self, path: str, *, user: str = "user", request_timeout: float | None = None) -> None:
        self._shell(f"rm -rf {shlex.quote(path)}")

    def rename(self, old_path: str, new_path: str, *, user: str = "user", request_timeout: float | None = None) -> EntryInfo:
        self._shell(f"mv {shlex.quote(old_path)} {shlex.quote(new_path)}")
        return self._stat_entry(new_path)

    def make_dir(self, path: str, *, user: str = "user", request_timeout: float | None = None) -> bool:
        _, _, exit_code = self._shell(f"mkdir -p {shlex.quote(path)}")
        return exit_code == 0

    def watch_dir(self, path: str, *, user: str = "user", request_timeout: float | None = None):
        raise NotImplementedError(
            "arker.e2b: files.watch_dir is not supported — Arker has no "
            "filesystem-event API. Poll files.list / files.exists if needed."
        )

    # ------------------------------------------------------------------
    # Internals

    def _shell(self, cmd: str) -> tuple[str, str, int]:
        result = self._sandbox._computer.run(cmd)
        if not isinstance(result, CompletedRunResult):
            raise RuntimeError(f"unexpected run result type {type(result).__name__}")
        return (
            result.stdout.decode("utf-8", errors="replace"),
            result.stderr.decode("utf-8", errors="replace"),
            result.exit_code,
        )

    def _stat_entry(self, path: str) -> EntryInfo:
        """Best-effort EntryInfo for a single path (used by rename).
        Falls back to a FILE-typed entry with no metadata if stat fails."""
        stdout, _, exit_code = self._shell(
            f"find {shlex.quote(path)} -maxdepth 0 -printf {shlex.quote(_FIND_FMT)}"
        )
        if exit_code == 0 and stdout.strip():
            parsed = _parse_find_line(stdout.splitlines()[0], os.path.dirname(path) or "/")
            if parsed:
                # `_parse_find_line` builds `.path` from parent + name; override to keep the user's path.
                return EntryInfo(
                    name=os.path.basename(path),
                    type=parsed.type,
                    path=path,
                    size=parsed.size,
                    mode=parsed.mode,
                    permissions=parsed.permissions,
                    owner=parsed.owner,
                    group=parsed.group,
                    modified_time=parsed.modified_time,
                    symlink_target=parsed.symlink_target,
                )
        return EntryInfo(name=os.path.basename(path), type=FileType.FILE, path=path)
