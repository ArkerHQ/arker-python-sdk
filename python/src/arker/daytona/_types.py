"""daytona-shaped types for the `arker.daytona` drop-in shim.

These mirror `daytonaio/daytona`'s public dataclasses field-for-field so
existing application code that destructures the result keeps working
unchanged.
"""

from __future__ import annotations

import dataclasses
import enum
from typing import Any


class SandboxState(str, enum.Enum):
    """Mirrors `daytonaio/daytona`'s SandboxState enum."""
    CREATING = "creating"
    STARTING = "starting"
    STARTED = "started"
    STOPPING = "stopping"
    STOPPED = "stopped"
    DESTROYING = "destroying"
    DESTROYED = "destroyed"
    ARCHIVING = "archiving"
    ARCHIVED = "archived"
    ERROR = "error"
    BUILD_FAILED = "build_failed"
    PENDING_BUILD = "pending_build"
    BUILDING_SNAPSHOT = "building_snapshot"
    PULLING_SNAPSHOT = "pulling_snapshot"
    RESIZING = "resizing"
    SNAPSHOTTING = "snapshotting"
    FORKING = "forking"
    RESTORING = "restoring"
    UNKNOWN = "unknown"


@dataclasses.dataclass(frozen=True)
class DaytonaConfig:
    api_key: str | None = None
    api_url: str = "https://app.daytona.io/api"
    target: str = "us"
    jwt_token: str | None = None
    organization_id: str | None = None
    # `server_url` is daytona's deprecated alias for `api_url`. Accept it for
    # back-compat; ignore if both set.
    server_url: str | None = None


@dataclasses.dataclass(frozen=True)
class CreateSandboxFromSnapshotParams:
    """Canonical daytona create-params. Use with `Daytona.create(params=...)`."""
    snapshot: str | None = None
    env_vars: dict[str, str] | None = None
    labels: dict[str, str] | None = None
    public: bool | None = None
    auto_stop_interval: int | None = None
    auto_archive_interval: int | None = None
    auto_delete_interval: int | None = None
    name: str | None = None
    volumes: list[Any] | None = None
    network_block_all: bool | None = None
    network_allow_list: str | None = None
    user: str | None = None


@dataclasses.dataclass(frozen=True)
class CreateSandboxFromImageParams:
    image: str
    env_vars: dict[str, str] | None = None
    labels: dict[str, str] | None = None
    public: bool | None = None
    auto_stop_interval: int | None = None
    auto_archive_interval: int | None = None
    auto_delete_interval: int | None = None
    name: str | None = None
    cpu: int | None = None
    gpu: int | None = None
    memory: int | None = None
    disk: int | None = None
    volumes: list[Any] | None = None
    network_block_all: bool | None = None
    network_allow_list: str | None = None
    user: str | None = None


@dataclasses.dataclass(frozen=True)
class CodeRunParams:
    argv: list[str] | None = None
    env: dict[str, str] | None = None


@dataclasses.dataclass(frozen=True)
class Chart:
    type: str = "unknown"
    title: str | None = None


@dataclasses.dataclass(frozen=True)
class ExecutionArtifacts:
    stdout: str = ""
    # daytona returns `[]` when no charts, not None. Match it.
    charts: list[Chart] = dataclasses.field(default_factory=list)


@dataclasses.dataclass(frozen=True)
class ExecuteResponse:
    exit_code: int
    result: str
    artifacts: ExecutionArtifacts | None = None


@dataclasses.dataclass(frozen=True)
class FileInfo:
    """Mirrors daytona's FileInfo. `mode` is the octal string ("0644"),
    `permissions` is the same string per the daytona toolbox API."""
    name: str
    is_dir: bool
    size: int = 0
    mode: str = ""
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


@dataclasses.dataclass
class SessionExecuteRequest:
    """daytona's SessionExecuteRequest. `var_async` is the deprecated alias
    for `run_async`. We accept both."""
    command: str
    run_async: bool = False
    var_async: bool | None = None  # deprecated alias

    def __post_init__(self) -> None:
        if self.var_async is not None and not self.run_async:
            import warnings
            warnings.warn(
                "SessionExecuteRequest.var_async is deprecated; use run_async",
                DeprecationWarning,
                stacklevel=3,
            )
            # Set without triggering frozen dataclass restriction
            object.__setattr__(self, "run_async", bool(self.var_async))


@dataclasses.dataclass(frozen=True)
class SessionExecuteResponse:
    cmd_id: str
    exit_code: int | None = None
    output: str | None = None
    stdout: str | None = None
    stderr: str | None = None


@dataclasses.dataclass(frozen=True)
class Command:
    id: str
    command: str
    exit_code: int | None = None


@dataclasses.dataclass(frozen=True)
class Session:
    """daytona's Session — just `session_id` and `commands`."""
    session_id: str
    commands: list[Command] = dataclasses.field(default_factory=list)


@dataclasses.dataclass(frozen=True)
class SessionCommandLogsResponse:
    """daytona returns `output` as the combined stream, plus separate
    `stdout` and `stderr`. No `exit_code` here (that's on `Command`)."""
    output: str
    stdout: str
    stderr: str


@dataclasses.dataclass(frozen=True)
class PaginatedSandboxes:
    """Wrapper returned by `Daytona.list()`, with daytona's pagination fields."""
    items: list[Any]
    total: int
    page: int
    total_pages: int

    def __iter__(self):
        return iter(self.items)

    def __len__(self) -> int:
        return len(self.items)


# ---- Exception hierarchy ----


class DaytonaError(Exception):
    """Base exception for the arker.daytona compat layer.

    Mirrors `daytonaio/daytona`'s DaytonaError — carries `status_code`,
    `error_code`, and `headers` so consumers can branch on the wire-level
    failure.
    """

    def __init__(
        self,
        message: str,
        status_code: int | None = None,
        error_code: str | None = None,
        headers: dict[str, str] | None = None,
    ) -> None:
        super().__init__(message)
        self.status_code = status_code
        self.error_code = error_code
        self.headers = headers or {}


class DaytonaNotFoundError(DaytonaError):
    pass


class DaytonaAuthenticationError(DaytonaError):
    pass


class DaytonaAuthorizationError(DaytonaError):
    pass


class DaytonaConflictError(DaytonaError):
    pass


class DaytonaRateLimitError(DaytonaError):
    pass


class DaytonaValidationError(DaytonaError):
    pass


class DaytonaTimeoutError(DaytonaError):
    pass


class DaytonaConnectionError(DaytonaError):
    pass


class FileSystemError(DaytonaError):
    pass


class ProcessError(DaytonaError):
    pass


# Existing aliases kept for backward-compat with shim code; canonical names are
# the daytona-prefixed versions above.
SandboxNotFoundError = DaytonaNotFoundError
SessionNotFoundError = DaytonaNotFoundError


def translate_arker_error(error: Exception) -> DaytonaError:
    """Map an `ArkerError` (or other low-level error) into the right
    daytona-typed exception by HTTP status code.

    Idempotent: passing in a DaytonaError returns it unchanged.
    """
    if isinstance(error, DaytonaError):
        return error

    # ArkerError shape: code, message, status.
    status = getattr(error, "status", 0)
    code = getattr(error, "code", "internal")
    message = getattr(error, "message", str(error))

    kwargs = {"status_code": status, "error_code": code}
    if status == 401:
        return DaytonaAuthenticationError(message, **kwargs)
    if status == 403:
        return DaytonaAuthorizationError(message, **kwargs)
    if status == 404:
        return DaytonaNotFoundError(message, **kwargs)
    if status == 409:
        return DaytonaConflictError(message, **kwargs)
    if status == 422 or status == 400:
        return DaytonaValidationError(message, **kwargs)
    if status == 429:
        return DaytonaRateLimitError(message, **kwargs)
    if status == 408 or status == 504:
        return DaytonaTimeoutError(message, **kwargs)
    if status == 0:
        return DaytonaConnectionError(message, **kwargs)
    return DaytonaError(message, **kwargs)
