"""`sandbox.files` namespace — Phase A: read/write only."""

from __future__ import annotations

import os
from typing import TYPE_CHECKING, Any, Literal, overload

from ._types import EntryInfo, FileType

if TYPE_CHECKING:
    from ._sandbox import Sandbox


class Filesystem:
    def __init__(self, sandbox: "Sandbox") -> None:
        self._sandbox = sandbox

    @overload
    def read(self, path: str, *, format: Literal["text"] = "text", user: str = "user", request_timeout: float | None = None) -> str: ...
    @overload
    def read(self, path: str, *, format: Literal["bytes"], user: str = "user", request_timeout: float | None = None) -> bytearray: ...

    def read(
        self,
        path: str,
        *,
        format: str = "text",
        user: str = "user",
        request_timeout: float | None = None,
    ) -> Any:
        data = self._sandbox._computer.sync.read_file(path)
        if format == "bytes":
            return bytearray(data)
        if format == "text":
            return data.decode("utf-8", errors="replace")
        # `stream` is a Phase C feature; fall through to text rather than crash
        # so existing e2b code that passes format="stream" doesn't break.
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
