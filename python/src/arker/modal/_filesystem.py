"""`sandbox.filesystem` namespace.

Native ops (`read_*` / `write_*` / `copy_*`) use Arker's `sync` HTTP API.
Shell-shim ops (`list_files`, `make_directory`, `remove`, `stat`) go through
`Computer.run`.
"""

from __future__ import annotations

import os
import shlex
from typing import TYPE_CHECKING, Union

from ..computer import ArkerError, CompletedRunResult
from ._types import (
    FileInfo,
    FilesystemExecutionError,
    FileType,
    InvalidError,
    NotFoundError,
    translate_arker_error,
)

if TYPE_CHECKING:
    from ._sandbox import Sandbox

PathLike = Union[str, os.PathLike]


# Matches modal's FileInfo field set: name, path, type, size, mode,
# permissions, owner, group, modified_time, symlink_target.
# `%y|%s|%m|%U|%G|%T@|%l\n` — kind, size, octal-mode, numeric UID, numeric
# GID, mtime, symlink target.
_FIND_FMT = "%y|%s|%m|%U|%G|%T@|%l\\n"


def _kind_to_filetype(kind: str) -> FileType:
    if kind == "d":
        return FileType.DIRECTORY
    if kind == "f":
        return FileType.FILE
    if kind == "l":
        return FileType.SYMLINK
    return FileType.UNKNOWN


def _parse_find_line(line: str, remote_path: str) -> FileInfo | None:
    parts = line.split("|", 6)
    if len(parts) < 6:
        return None
    kind, size_s, mode_s, owner, group, mtime_s, *rest = parts
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
        mtime = float(mtime_s) if mtime_s else 0.0
    except ValueError:
        mtime = 0.0
    return FileInfo(
        name=os.path.basename(remote_path.rstrip("/")) or remote_path,
        path=remote_path,
        type=_kind_to_filetype(kind),
        size=size,
        mode=mode,
        permissions=mode_s.zfill(4) if mode_s else "",
        owner=owner,
        group=group,
        modified_time=mtime,
        symlink_target=symlink_target or None,
    )


def _validate_absolute(path: str, op: str) -> None:
    """Matches modal: every fs op rejects relative paths up-front."""
    if not isinstance(path, str) or not path:
        raise InvalidError(f"{op}: path must be a non-empty string")
    if not path.startswith("/"):
        raise InvalidError(f"{op}: path must be absolute (got {path!r})")


class SandboxFilesystem:
    """Mirrors `modal.Sandbox.filesystem`."""

    def __init__(self, sandbox: "Sandbox") -> None:
        self._sandbox = sandbox

    # ---- Native (Arker sync API) ----

    def read_bytes(self, remote_path: str) -> bytes:
        _validate_absolute(remote_path, "read_bytes")
        try:
            return self._sandbox._computer.sync.read_file(remote_path)
        except ArkerError as error:
            raise translate_arker_error(error) from error

    def read_text(self, remote_path: str) -> str:
        return self.read_bytes(remote_path).decode("utf-8", errors="replace")

    def write_bytes(self, data: bytes | bytearray | memoryview, remote_path: str) -> None:
        _validate_absolute(remote_path, "write_bytes")
        try:
            self._sandbox._computer.sync.write_file(remote_path, bytes(data))
        except ArkerError as error:
            raise translate_arker_error(error) from error

    def write_text(self, data: str, remote_path: str) -> None:
        _validate_absolute(remote_path, "write_text")
        try:
            self._sandbox._computer.sync.write_file(remote_path, data)
        except ArkerError as error:
            raise translate_arker_error(error) from error

    def copy_from_local(self, local_path: PathLike, remote_path: str) -> None:
        _validate_absolute(remote_path, "copy_from_local")
        with open(os.fspath(local_path), "rb") as fh:
            self.write_bytes(fh.read(), remote_path)

    def copy_to_local(self, remote_path: str, local_path: PathLike) -> None:
        _validate_absolute(remote_path, "copy_to_local")
        data = self.read_bytes(remote_path)
        with open(os.fspath(local_path), "wb") as fh:
            fh.write(data)

    # ---- Shell-shim ----

    def list_files(self, remote_path: str) -> list[FileInfo]:
        _validate_absolute(remote_path, "list_files")
        stdout, stderr, exit_code = self._shell(
            f"find {shlex.quote(remote_path)} -maxdepth 1 -mindepth 1 -printf {shlex.quote('%p|' + _FIND_FMT)}"
        )
        if exit_code != 0:
            if "No such" in stderr or "cannot access" in stderr.lower():
                raise NotFoundError(f"path {remote_path!r} not found")
            raise FilesystemExecutionError(f"list_files({remote_path!r}) failed: {stderr.strip()}")
        entries: list[FileInfo] = []
        for line in stdout.splitlines():
            if not line:
                continue
            # `%p|%y|%s|%m|%T@` — full path, then the rest.
            path, _, rest = line.partition("|")
            parsed = _parse_find_line(rest, path)
            if parsed:
                entries.append(parsed)
        return entries

    def make_directory(self, remote_path: str, *, create_parents: bool = True) -> None:
        _validate_absolute(remote_path, "make_directory")
        flag = "-p" if create_parents else ""
        _, stderr, exit_code = self._shell(
            f"mkdir {flag} {shlex.quote(remote_path)}".strip()
        )
        if exit_code != 0:
            raise FilesystemExecutionError(
                f"make_directory({remote_path!r}) failed: {stderr.strip()}"
            )

    def remove(self, remote_path: str, *, recursive: bool = False) -> None:
        _validate_absolute(remote_path, "remove")
        flag = "-rf" if recursive else "-f"
        _, stderr, exit_code = self._shell(f"rm {flag} {shlex.quote(remote_path)}")
        if exit_code != 0:
            raise FilesystemExecutionError(
                f"remove({remote_path!r}) failed: {stderr.strip()}"
            )

    def stat(self, remote_path: str) -> FileInfo:
        _validate_absolute(remote_path, "stat")
        stdout, stderr, exit_code = self._shell(
            f"find {shlex.quote(remote_path)} -maxdepth 0 -printf {shlex.quote(_FIND_FMT)}"
        )
        if exit_code != 0 or not stdout.strip():
            if "No such" in stderr or "cannot access" in stderr.lower():
                raise NotFoundError(f"path {remote_path!r} not found")
            raise FilesystemExecutionError(
                f"stat({remote_path!r}) failed: {stderr.strip() or 'not found'}"
            )
        parsed = _parse_find_line(stdout.splitlines()[0], remote_path)
        if parsed is None:
            raise FilesystemExecutionError(f"stat({remote_path!r}): unparseable")
        return parsed

    # ---- Not implemented (loud) ----

    def watch(self, *args, **kwargs):
        raise NotImplementedError(
            "arker.modal: filesystem.watch is not supported — Arker has no "
            "fs-event API. Poll list_files / stat if needed."
        )

    # ---- Internals ----

    def _shell(self, cmd: str) -> tuple[str, str, int]:
        try:
            result = self._sandbox._computer.run(cmd)
        except ArkerError as error:
            raise translate_arker_error(error) from error
        if not isinstance(result, CompletedRunResult):
            raise FilesystemExecutionError(f"unexpected run result type {type(result).__name__}")
        return (
            result.stdout.decode("utf-8", errors="replace"),
            result.stderr.decode("utf-8", errors="replace"),
            result.exit_code,
        )
