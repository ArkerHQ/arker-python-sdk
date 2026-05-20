"""daytona-shaped types for the `arker.daytona` drop-in shim."""

from __future__ import annotations

import dataclasses
import enum
from typing import Any


class SandboxState(str, enum.Enum):
    CREATING = "creating"
    STARTED = "started"
    STOPPED = "stopped"
    DELETING = "deleting"
    ERROR = "error"
    ARCHIVED = "archived"


@dataclasses.dataclass(frozen=True)
class DaytonaConfig:
    api_key: str | None = None
    api_url: str = "https://app.daytona.io/api"
    target: str = "us"


@dataclasses.dataclass(frozen=True)
class CodeRunParams:
    argv: list[str] | None = None
    env: dict[str, str] | None = None


@dataclasses.dataclass(frozen=True)
class Chart:
    """Placeholder — matplotlib chart capture not implemented (see pending #5)."""
    type: str = "unknown"
    title: str | None = None


@dataclasses.dataclass(frozen=True)
class ExecutionArtifacts:
    stdout: str = ""
    charts: list[Chart] | None = None


@dataclasses.dataclass(frozen=True)
class ExecuteResponse:
    exit_code: int
    result: str
    artifacts: ExecutionArtifacts | None = None


@dataclasses.dataclass(frozen=True)
class FileInfo:
    name: str
    is_dir: bool
    size: int = 0
    mode: int = 0
    owner: str = ""
    group: str = ""
    mod_time: str = ""
    permissions: str = ""


@dataclasses.dataclass(frozen=True)
class Match:
    file: str
    line: int
    content: str


@dataclasses.dataclass(frozen=True)
class SearchFilesResponse:
    files: list[str]


@dataclasses.dataclass(frozen=True)
class ReplaceResult:
    file: str
    success: bool
    error: str | None = None


@dataclasses.dataclass(frozen=True)
class SessionExecuteRequest:
    command: str
    runAsync: bool = False  # daytona's field is `async` — reserved word in py
    cwd: str | None = None
    env: dict[str, str] | None = None


@dataclasses.dataclass(frozen=True)
class SessionExecuteResponse:
    cmd_id: str
    output: str | None = None
    exit_code: int | None = None


@dataclasses.dataclass(frozen=True)
class Command:
    id: str
    command: str
    exit_code: int | None = None


@dataclasses.dataclass(frozen=True)
class Session:
    session_id: str
    state: str
    cwd: str
    commands: list[Command] = dataclasses.field(default_factory=list)


@dataclasses.dataclass(frozen=True)
class SessionCommandLogsResponse:
    stdout: str
    stderr: str
    exit_code: int | None = None


class DaytonaError(Exception):
    """Base error for the arker.daytona compat layer."""


class FileSystemError(DaytonaError):
    pass


class ProcessError(DaytonaError):
    pass


class SandboxNotFoundError(DaytonaError):
    pass


class SessionNotFoundError(DaytonaError):
    pass


def _coerce(value: Any, default: Any = None) -> Any:
    return value if value is not None else default
