"""`sandbox.fs` namespace.

Native ops (`upload_file`, `download_file`) use Arker's `sync` HTTP API.
Shell-shim ops (`list_files`, `delete_file`, `create_folder`, `find_files`,
`get_file_info`, `move_files`, `set_file_permissions`) route through
`Computer.run`.
"""

from __future__ import annotations

import os
import shlex
from typing import TYPE_CHECKING, Union

from ..computer import ArkerError, CompletedRunResult
from ._types import (
    FileInfo,
    FileSystemError,
    Match,
    ReplaceResult,
    SearchFilesResponse,
    translate_arker_error,
)

if TYPE_CHECKING:
    from ._sandbox import Sandbox

FileSource = Union[bytes, bytearray, str]


# `find ... -printf "%f|%y|%s|%m|%u|%g|%T@\n"` — one line per entry.
# We keep `mode` as the literal octal string daytona returns ("644", "755").
_FIND_FMT = "%f|%y|%s|%m|%u|%g|%T@\\n"


def _parse_find_line(line: str) -> FileInfo | None:
    parts = line.split("|")
    if len(parts) < 7:
        return None
    name, kind, size_s, mode_s, owner, group, mtime_s = parts[:7]
    try:
        size = int(size_s) if size_s else 0
    except ValueError:
        size = 0
    # Keep `mode` as the raw octal string. daytona's toolbox API returns
    # it that way; converting to int would diverge.
    mode = mode_s or ""
    is_dir = kind == "d"
    return FileInfo(
        name=name,
        is_dir=is_dir,
        size=size,
        mode=mode,
        owner=owner,
        group=group,
        mod_time=mtime_s,
        permissions=mode,  # daytona populates both fields with the same octal
    )


class FileSystem:
    def __init__(self, sandbox: "Sandbox") -> None:
        self._sandbox = sandbox

    # ---- Native (Arker sync API) ----

    def upload_file(
        self,
        file: FileSource,
        remote_path: str,
        timeout: int = 30 * 60,
    ) -> None:
        del timeout
        try:
            if isinstance(file, (bytes, bytearray)):
                self._sandbox._computer.sync.write_file(remote_path, bytes(file))
                return
            if isinstance(file, str):
                if os.path.exists(file) and os.path.isfile(file):
                    with open(file, "rb") as fh:
                        self._sandbox._computer.sync.write_file(remote_path, fh.read())
                    return
                self._sandbox._computer.sync.write_file(remote_path, file)
                return
        except ArkerError as error:
            raise translate_arker_error(error) from error
        raise FileSystemError(f"unsupported file argument type: {type(file).__name__}")

    def download_file(
        self,
        remote_path: str,
        local_path: str | None = None,
        timeout: int = 30 * 60,
    ) -> bytes | None:
        del timeout
        try:
            data = self._sandbox._computer.sync.read_file(remote_path)
        except ArkerError as error:
            raise translate_arker_error(error) from error
        if local_path is None:
            return data
        with open(local_path, "wb") as fh:
            fh.write(data)
        return None

    # ---- Shell-shim ----

    def list_files(self, path: str) -> list[FileInfo]:
        stdout, _, exit_code = self._shell(
            f"find {shlex.quote(path)} -maxdepth 1 -mindepth 1 -printf {shlex.quote(_FIND_FMT)}"
        )
        if exit_code != 0:
            return []
        entries: list[FileInfo] = []
        for line in stdout.splitlines():
            if not line:
                continue
            parsed = _parse_find_line(line)
            if parsed:
                entries.append(parsed)
        return entries

    def create_folder(self, path: str, mode: str) -> None:
        """Create a folder. `mode` is REQUIRED to match daytona's signature."""
        _, stderr, exit_code = self._shell(
            f"mkdir -m {shlex.quote(mode)} -p {shlex.quote(path)}"
        )
        if exit_code != 0:
            raise FileSystemError(
                f"create_folder({path!r}) failed: {stderr.strip() or 'exit ' + str(exit_code)}"
            )

    def delete_file(self, path: str, recursive: bool = False) -> None:
        flag = "-rf" if recursive else "-f"
        _, stderr, exit_code = self._shell(f"rm {flag} {shlex.quote(path)}")
        if exit_code != 0:
            raise FileSystemError(f"delete_file({path!r}) failed: {stderr.strip()}")

    def get_file_info(self, path: str) -> FileInfo:
        stdout, stderr, exit_code = self._shell(
            f"find {shlex.quote(path)} -maxdepth 0 -printf {shlex.quote(_FIND_FMT)}"
        )
        if exit_code != 0 or not stdout.strip():
            raise FileSystemError(
                f"get_file_info({path!r}) failed: {stderr.strip() or 'not found'}"
            )
        parsed = _parse_find_line(stdout.splitlines()[0])
        if parsed is None:
            raise FileSystemError(f"get_file_info({path!r}): unparseable find output")
        return FileInfo(
            name=os.path.basename(path) or path,
            is_dir=parsed.is_dir,
            size=parsed.size,
            mode=parsed.mode,
            owner=parsed.owner,
            group=parsed.group,
            mod_time=parsed.mod_time,
            permissions=parsed.permissions,
        )

    def move_files(self, source: str, destination: str) -> None:
        _, stderr, exit_code = self._shell(
            f"mv {shlex.quote(source)} {shlex.quote(destination)}"
        )
        if exit_code != 0:
            raise FileSystemError(
                f"move_files({source!r}, {destination!r}) failed: {stderr.strip()}"
            )

    def find_files(self, path: str, pattern: str) -> list[Match]:
        """Grep recursively under `path` for lines matching `pattern`.

        daytona's regex flavor is RE2 (Go regexp). We use `grep -rnE` which
        is POSIX ERE — patterns that rely on RE2-only constructs (e.g. `\\d`
        as a digit shorthand) won't match. See pending notes in __init__.py.
        """
        cmd = f"grep -rnE --no-messages {shlex.quote(pattern)} {shlex.quote(path)}"
        stdout, _, exit_code = self._shell(cmd)
        # grep exit 1 = no matches.
        if exit_code not in (0, 1):
            raise FileSystemError(f"find_files failed: exit {exit_code}")
        matches: list[Match] = []
        for line in stdout.splitlines():
            file_part, _, rest = line.partition(":")
            line_part, _, content = rest.partition(":")
            try:
                line_no = int(line_part) if line_part else 0
            except ValueError:
                line_no = 0
            matches.append(Match(file=file_part, line=line_no, content=content))
        return matches

    def set_file_permissions(
        self,
        path: str,
        mode: str | None = None,
        owner: str | None = None,
        group: str | None = None,
    ) -> None:
        if mode is None and owner is None and group is None:
            return
        if mode is not None:
            _, stderr, exit_code = self._shell(
                f"chmod {shlex.quote(mode)} {shlex.quote(path)}"
            )
            if exit_code != 0:
                raise FileSystemError(f"chmod failed: {stderr.strip()}")
        if owner is not None or group is not None:
            target = f"{owner or ''}:{group or ''}"
            _, stderr, exit_code = self._shell(
                f"chown {shlex.quote(target)} {shlex.quote(path)}"
            )
            if exit_code != 0:
                raise FileSystemError(f"chown failed: {stderr.strip()}")

    # ---- Not implemented (loud) ----

    def search_files(self, path: str, pattern: str) -> SearchFilesResponse:
        raise NotImplementedError(
            "arker.daytona: fs.search_files is not implemented — "
            "use fs.find_files (content grep) or fs.list_files for now."
        )

    def replace_in_files(
        self,
        files: list[str],
        pattern: str,
        new_value: str,
    ) -> list[ReplaceResult]:
        raise NotImplementedError(
            "arker.daytona: fs.replace_in_files is not implemented — "
            "regex flavor mismatch risk."
        )

    def upload_files(self, files: list, timeout: int = 30 * 60) -> None:
        raise NotImplementedError(
            "arker.daytona: fs.upload_files (batch) is not implemented — "
            "loop over fs.upload_file for now."
        )

    def upload_file_stream(self, *args, **kwargs) -> None:
        raise NotImplementedError(
            "arker.daytona: fs.upload_file_stream is not implemented."
        )

    def download_file_stream(self, *args, **kwargs):
        raise NotImplementedError(
            "arker.daytona: fs.download_file_stream is not implemented."
        )

    def download_files(self, *args, **kwargs):
        raise NotImplementedError(
            "arker.daytona: fs.download_files (batch) is not implemented."
        )

    # ---- Internals ----

    def _shell(self, cmd: str) -> tuple[str, str, int]:
        try:
            result = self._sandbox._computer.run(cmd)
        except ArkerError as error:
            raise translate_arker_error(error) from error
        if not isinstance(result, CompletedRunResult):
            raise FileSystemError(f"unexpected run result type {type(result).__name__}")
        return (
            result.stdout.decode("utf-8", errors="replace"),
            result.stderr.decode("utf-8", errors="replace"),
            result.exit_code,
        )
