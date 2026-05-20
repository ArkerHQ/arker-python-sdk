"""`sandbox.fs` namespace — Phase A: upload_file, download_file, basic listing."""

from __future__ import annotations

import os
from typing import TYPE_CHECKING, Union

from ._types import FileSystemError

if TYPE_CHECKING:
    from ._sandbox import Sandbox

FileSource = Union[bytes, bytearray, str]


class FileSystem:
    def __init__(self, sandbox: "Sandbox") -> None:
        self._sandbox = sandbox

    def upload_file(
        self,
        file: FileSource,
        remote_path: str,
        timeout: int = 30 * 60,
    ) -> None:
        """Upload bytes or a local file path. The daytona SDK accepts both
        shapes in a single overloaded method; we sniff at runtime."""
        if isinstance(file, (bytes, bytearray)):
            self._sandbox._computer.sync.write_file(remote_path, bytes(file))
            return
        if isinstance(file, str):
            # `file` is a local path when treated as a filesystem reference,
            # but daytona also lets you pass a string literal as content.
            # We disambiguate by whether the string exists as a local file.
            if os.path.exists(file) and os.path.isfile(file):
                with open(file, "rb") as fh:
                    self._sandbox._computer.sync.write_file(remote_path, fh.read())
                return
            # Treat as inline string content.
            self._sandbox._computer.sync.write_file(remote_path, file)
            return
        raise FileSystemError(f"unsupported file argument type: {type(file).__name__}")

    def download_file(
        self,
        remote_path: str,
        local_path: str | None = None,
        timeout: int = 30 * 60,
    ) -> bytes | None:
        """Read a remote file. With `local_path` set, write it to disk and
        return None (mirrors daytona's two-overload signature)."""
        data = self._sandbox._computer.sync.read_file(remote_path)
        if local_path is None:
            return data
        with open(local_path, "wb") as fh:
            fh.write(data)
        return None
