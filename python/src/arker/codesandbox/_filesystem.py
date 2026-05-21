"""`SandboxClient.fs` namespace.

Native ops (`readFile`/`writeFile`/`readTextFile`/`writeTextFile`) use Arker's
sync HTTP API. Shell-shim ops (`readdir`, `mkdir`, `remove`, `stat`, `rename`,
`copy`) go through `Computer.run`.
"""

from __future__ import annotations

import os
import shlex
from typing import TYPE_CHECKING

from ..computer import ArkerError, CompletedRunResult
from ._types import (
    CodeSandboxError,
    FSStatResult,
    ReaddirEntry,
    translate_arker_error,
)

if TYPE_CHECKING:
    from ._sandbox_client import SandboxClient


# `find ... -printf "%y|%s|%T@|%A@|%C@\n"` — kind, size, mtime, atime, ctime.
_STAT_FMT = "%y|%s|%T@|%A@|%C@\\n"

# `find ... -maxdepth 1 -mindepth 1 -printf "%f|%y\n"` for readdir.
_READDIR_FMT = "%f|%y\\n"


def _kind_to_type(kind: str) -> str:
    if kind == "d":
        return "directory"
    if kind == "l":
        return "symlink"
    return "file"


class Filesystem:
    """Mirrors `@codesandbox/sdk` SandboxClient.fs."""

    def __init__(self, client: "SandboxClient") -> None:
        self._client = client

    # ---- Native (Arker sync API) ----

    def readFile(self, path: str) -> bytes:  # noqa: N802 — matches @codesandbox/sdk
        try:
            return self._client._sandbox._computer.sync.read_file(path)
        except ArkerError as error:
            raise translate_arker_error(error) from error

    def readTextFile(self, path: str) -> str:  # noqa: N802
        return self.readFile(path).decode("utf-8", errors="replace")

    def writeFile(self, path: str, content: bytes) -> None:  # noqa: N802
        try:
            self._client._sandbox._computer.sync.write_file(path, bytes(content))
        except ArkerError as error:
            raise translate_arker_error(error) from error

    def writeTextFile(self, path: str, content: str, opts: dict | None = None) -> None:  # noqa: N802
        del opts  # `createIfNotExists` and friends — accepted but unused
        try:
            self._client._sandbox._computer.sync.write_file(path, content)
        except ArkerError as error:
            raise translate_arker_error(error) from error

    # Snake-case aliases for users coming from the Python conventions.
    read_file = readFile
    read_text_file = readTextFile
    write_file = writeFile
    write_text_file = writeTextFile

    # ---- Shell-shim ----

    def readdir(self, path: str) -> list[ReaddirEntry]:
        stdout, _, exit_code = self._shell(
            f"find {shlex.quote(path)} -maxdepth 1 -mindepth 1 -printf {shlex.quote(_READDIR_FMT)}"
        )
        if exit_code != 0:
            raise CodeSandboxError(f"readdir({path!r}) failed")
        entries: list[ReaddirEntry] = []
        for line in stdout.splitlines():
            if not line or "|" not in line:
                continue
            name, _, kind = line.rpartition("|")
            entries.append(ReaddirEntry(
                name=name,
                type=_kind_to_type(kind),
                is_symlink=kind == "l",
            ))
        return entries

    def stat(self, path: str) -> FSStatResult:
        stdout, _, exit_code = self._shell(
            f"find {shlex.quote(path)} -maxdepth 0 -printf {shlex.quote(_STAT_FMT)}"
        )
        if exit_code != 0 or not stdout.strip():
            raise CodeSandboxError(f"stat({path!r}) failed: not found")
        parts = stdout.splitlines()[0].split("|")
        if len(parts) < 5:
            raise CodeSandboxError(f"stat({path!r}): unparseable")
        kind, size_s, mtime_s, atime_s, ctime_s = parts[:5]
        return FSStatResult(
            type=_kind_to_type(kind),
            size=int(size_s) if size_s else 0,
            atime=float(atime_s) if atime_s else 0.0,
            mtime=float(mtime_s) if mtime_s else 0.0,
            ctime=float(ctime_s) if ctime_s else 0.0,
        )

    def mkdir(self, path: str, recursive: bool = False) -> None:
        flag = "-p" if recursive else ""
        _, stderr, exit_code = self._shell(f"mkdir {flag} {shlex.quote(path)}".strip())
        if exit_code != 0:
            raise CodeSandboxError(f"mkdir({path!r}) failed: {stderr.strip()}")

    def remove(self, path: str, recursive: bool = False) -> None:
        flag = "-rf" if recursive else "-f"
        _, stderr, exit_code = self._shell(f"rm {flag} {shlex.quote(path)}")
        if exit_code != 0:
            raise CodeSandboxError(f"remove({path!r}) failed: {stderr.strip()}")

    def rename(self, from_path: str, to_path: str, overwrite: bool = False) -> None:
        del overwrite  # `mv` overwrites by default
        _, stderr, exit_code = self._shell(
            f"mv {shlex.quote(from_path)} {shlex.quote(to_path)}"
        )
        if exit_code != 0:
            raise CodeSandboxError(f"rename failed: {stderr.strip()}")

    def copy(self, from_path: str, to_path: str, recursive: bool = False) -> None:
        flag = "-r" if recursive else ""
        _, stderr, exit_code = self._shell(
            f"cp {flag} {shlex.quote(from_path)} {shlex.quote(to_path)}".strip()
        )
        if exit_code != 0:
            raise CodeSandboxError(f"copy failed: {stderr.strip()}")

    # ---- Not implemented ----

    def watch(self, *args, **kwargs):
        raise NotImplementedError(
            "arker.codesandbox: fs.watch is not supported — no fs-event API. "
            "Poll readdir/stat if needed."
        )

    def download(self, path: str) -> dict:
        raise NotImplementedError(
            "arker.codesandbox: fs.download is not supported — Arker has no "
            "signed download URL endpoint. Use fs.readFile() and write locally."
        )

    def batchWrite(self, *args, **kwargs):  # noqa: N802
        raise NotImplementedError(
            "arker.codesandbox: fs.batchWrite is not supported — loop over fs.writeFile."
        )

    # ---- Internals ----

    def _shell(self, cmd: str) -> tuple[str, str, int]:
        try:
            result = self._client._sandbox._computer.run(cmd)
        except ArkerError as error:
            raise translate_arker_error(error) from error
        if not isinstance(result, CompletedRunResult):
            raise CodeSandboxError(f"unexpected run result type {type(result).__name__}")
        return (
            result.stdout.decode("utf-8", errors="replace"),
            result.stderr.decode("utf-8", errors="replace"),
            result.exit_code,
        )
