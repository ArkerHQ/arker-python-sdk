"""e2b-shaped types — mirror the public dataclasses that `e2b.Sandbox` exposes.

These are intentionally e2b-shaped (str stdout, FileType enum, etc.) rather than
Arker-shaped (bytes stdout) so user code that destructures the result keeps
working unchanged.
"""

from __future__ import annotations

import dataclasses
import enum


class FileType(str, enum.Enum):
    FILE = "file"
    DIR = "dir"


@dataclasses.dataclass(frozen=True)
class CommandResult:
    stdout: str
    stderr: str
    exit_code: int
    error: str | None = None


@dataclasses.dataclass(frozen=True)
class EntryInfo:
    name: str
    type: FileType
    path: str


@dataclasses.dataclass(frozen=True)
class ProcessInfo:
    pid: int
    tag: str
    cmd: str
    cwd: str | None = None


class SandboxException(Exception):
    """Base exception for the arker.e2b compat layer."""


class CommandExitException(SandboxException):
    """Raised by commands.run when the command exits non-zero (matching e2b)."""

    def __init__(self, result: CommandResult) -> None:
        super().__init__(
            f"command exited with code {result.exit_code}: "
            f"{(result.stderr or result.stdout)[:200]}"
        )
        self.result = result
        self.exit_code = result.exit_code
        self.stdout = result.stdout
        self.stderr = result.stderr
