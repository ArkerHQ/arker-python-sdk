"""e2b-shaped types — mirror the public dataclasses that `e2b.Sandbox` exposes.

These are intentionally e2b-shaped (str stdout, FileType enum, etc.) rather than
Arker-shaped (bytes stdout) so user code that destructures the result keeps
working unchanged.
"""

from __future__ import annotations

import dataclasses
import datetime as _dt
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
    size: int = 0
    mode: int = 0
    permissions: str = ""
    owner: str = ""
    group: str = ""
    modified_time: _dt.datetime | None = None
    symlink_target: str | None = None


@dataclasses.dataclass(frozen=True)
class ProcessInfo:
    pid: int
    tag: str
    cmd: str
    args: list[str] = dataclasses.field(default_factory=list)
    envs: dict[str, str] = dataclasses.field(default_factory=dict)
    cwd: str | None = None


@dataclasses.dataclass(frozen=True)
class SandboxInfo:
    sandbox_id: str
    template_id: str | None
    name: str | None
    metadata: dict[str, str]
    started_at: _dt.datetime
    end_at: _dt.datetime | None = None


class SandboxException(Exception):
    """Base exception for the arker.e2b compat layer."""


# e2b's typed-exception hierarchy. These are empty subclasses so existing
# `except TimeoutException:` patterns match; we don't (yet) translate every
# ArkerError to the right subclass — that's a follow-up. At minimum, callers
# can catch the base SandboxException and types-check accurately.
class TimeoutException(SandboxException):
    pass


class InvalidArgumentException(SandboxException):
    pass


class NotEnoughSpaceException(SandboxException):
    pass


class NotFoundException(SandboxException):
    pass


class FileNotFoundException(NotFoundException):
    pass


class SandboxNotFoundException(NotFoundException):
    pass


class AuthenticationException(SandboxException):
    pass


class RateLimitException(SandboxException):
    pass


class TemplateException(SandboxException):
    pass


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
