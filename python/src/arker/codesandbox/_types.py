"""codesandbox-shaped types for the `arker.codesandbox` drop-in shim.

Field naming mirrors `@codesandbox/sdk` so existing destructuring works.
"""

from __future__ import annotations

import dataclasses
import datetime as _dt
import enum
from typing import Any


class BootupType(str, enum.Enum):
    """Mirrors `@codesandbox/sdk` bootupType.

    - RUNNING: VM already running
    - RESUME:  resumed from hibernation
    - CLEAN:   clean bootup (no hibernation snapshot)
    - FORK:    created from a template
    """
    RUNNING = "RUNNING"
    RESUME = "RESUME"
    CLEAN = "CLEAN"
    FORK = "FORK"


class CommandStatus(str, enum.Enum):
    RUNNING = "RUNNING"
    FINISHED = "FINISHED"
    ERROR = "ERROR"
    KILLED = "KILLED"
    RESTARTING = "RESTARTING"


@dataclasses.dataclass(frozen=True)
class SandboxInfo:
    """Wire-format SandboxInfo returned by `sandboxes.get()` and `list()`.

    `created_at` / `updated_at` are stored as `datetime` objects (matches
    `@codesandbox/sdk` returning `Date`). Snake_case attribute access is
    canonical; `.createdAt` / `.updatedAt` etc. are camelCase aliases so
    TS-shaped destructuring works.
    """
    id: str
    title: str | None = None
    description: str | None = None
    tags: list[str] = dataclasses.field(default_factory=list)
    privacy: str = "public-hosts"
    created_at: _dt.datetime | None = None
    updated_at: _dt.datetime | None = None

    @property
    def createdAt(self) -> _dt.datetime | None:  # noqa: N802
        return self.created_at

    @property
    def updatedAt(self) -> _dt.datetime | None:  # noqa: N802
        return self.updated_at


@dataclasses.dataclass(frozen=True)
class PaginationInfo:
    current_page: int
    next_page: int | None
    page_size: int

    @property
    def currentPage(self) -> int:  # noqa: N802
        return self.current_page

    @property
    def nextPage(self) -> int | None:  # noqa: N802
        return self.next_page

    @property
    def pageSize(self) -> int:  # noqa: N802
        return self.page_size


@dataclasses.dataclass(frozen=True)
class SandboxListResponse:
    """Returned by `sandboxes.list()`. Always carries `pagination` — matches
    codesandbox's invariant. `has_more` is the canonical "is there more"
    flag (codesandbox exposes it as `hasMore`)."""
    sandboxes: list[SandboxInfo]
    total_count: int
    pagination: PaginationInfo
    has_more: bool = False

    @property
    def hasMore(self) -> bool:  # noqa: N802
        return self.has_more

    @property
    def totalCount(self) -> int:  # noqa: N802
        return self.total_count

    def __iter__(self):
        return iter(self.sandboxes)


@dataclasses.dataclass(frozen=True)
class ReaddirEntry:
    """Mirrors `@codesandbox/sdk` ReaddirEntry. `type` is the resolved kind
    (`"file"` / `"directory"`); symlinks are flagged via `is_symlink` /
    `isSymlink` and `type` is set to whatever they point at."""
    name: str
    type: str   # "file" | "directory"
    is_symlink: bool = False

    @property
    def isSymlink(self) -> bool:  # noqa: N802
        return self.is_symlink


@dataclasses.dataclass(frozen=True)
class FSStatResult:
    """Mirrors `@codesandbox/sdk` FSStatResult. Symlinks are flagged via
    `is_symlink` / `isSymlink`; `type` is the resolved kind."""
    type: str  # "file" | "directory"
    size: int = 0
    atime: float = 0.0
    mtime: float = 0.0
    ctime: float = 0.0
    is_symlink: bool = False

    @property
    def isSymlink(self) -> bool:  # noqa: N802
        return self.is_symlink


@dataclasses.dataclass
class Command:
    """Background-command handle returned by `commands.runBackground()`."""
    name: str
    status: CommandStatus = CommandStatus.RUNNING
    output: str = ""
    exit_code: int | None = None


# ---- Exceptions ----


class CodeSandboxError(Exception):
    """Base exception for the arker.codesandbox compat layer."""


class CommandError(CodeSandboxError):
    """Mirrors `@codesandbox/sdk` CommandError. Raised by `commands.run()`
    when the command exits non-zero."""

    def __init__(self, message: str, exit_code: int, output: str) -> None:
        super().__init__(message)
        self.exit_code = exit_code
        self.output = output


class SandboxNotFoundError(CodeSandboxError):
    pass


class AuthenticationError(CodeSandboxError):
    pass


class RateLimitError(CodeSandboxError):
    pass


def translate_arker_error(error: Exception) -> CodeSandboxError:
    """Map ArkerError to the right codesandbox exception."""
    if isinstance(error, CodeSandboxError):
        return error
    status = getattr(error, "status", 0)
    code = getattr(error, "code", "internal")
    message = getattr(error, "message", str(error))
    del code
    if status == 404:
        return SandboxNotFoundError(message)
    if status == 401:
        return AuthenticationError(message)
    if status == 429:
        return RateLimitError(message)
    return CodeSandboxError(message)


# ---- Opaque placeholders ----


class VMTier:
    """Opaque placeholder for `@codesandbox/sdk` VMTier. CodeSandbox
    pre-defines tiers (Pico, Nano, Micro, Small, Medium, Large, XLarge).
    Arker has no VM-tier concept — `Sandbox.updateTier()` throws."""

    def __init__(self, name: str, cpu: int | None = None, memory_gib: int | None = None) -> None:
        self.name = name
        self.cpu = cpu
        self.memory_gib = memory_gib

    # Pre-defined tiers, matching codesandbox's catalog.
    Pico: "VMTier"
    Nano: "VMTier"
    Micro: "VMTier"
    Small: "VMTier"
    Medium: "VMTier"
    Large: "VMTier"
    XLarge: "VMTier"

    @classmethod
    def _init_tiers(cls) -> None:
        # Sizing matches @codesandbox/sdk VMTier.ts catalog.
        cls.Pico = cls("Pico", cpu=1, memory_gib=2)
        cls.Nano = cls("Nano", cpu=2, memory_gib=4)
        cls.Micro = cls("Micro", cpu=4, memory_gib=8)
        cls.Small = cls("Small", cpu=8, memory_gib=16)
        cls.Medium = cls("Medium", cpu=16, memory_gib=32)
        cls.Large = cls("Large", cpu=32, memory_gib=64)
        cls.XLarge = cls("XLarge", cpu=64, memory_gib=128)


VMTier._init_tiers()
