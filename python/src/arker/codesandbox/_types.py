"""codesandbox-shaped types for the `arker.codesandbox` drop-in shim.

Field naming mirrors `@codesandbox/sdk` so existing destructuring works.
"""

from __future__ import annotations

import dataclasses
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
    """Wire-format SandboxInfo returned by `sandboxes.list()`."""
    id: str
    title: str | None = None
    description: str | None = None
    tags: list[str] = dataclasses.field(default_factory=list)
    privacy: str = "public-hosts"
    created_at: str | None = None
    updated_at: str | None = None


@dataclasses.dataclass(frozen=True)
class PaginationInfo:
    current_page: int
    next_page: int | None
    page_size: int


@dataclasses.dataclass(frozen=True)
class SandboxListResponse:
    """Returned by `sandboxes.list()`."""
    sandboxes: list[SandboxInfo]
    total_count: int
    pagination: PaginationInfo | None = None

    def __iter__(self):
        return iter(self.sandboxes)


@dataclasses.dataclass(frozen=True)
class ReaddirEntry:
    """Mirrors `@codesandbox/sdk` ReaddirEntry."""
    name: str
    type: str   # "file" | "directory" | "symlink"
    is_symlink: bool = False


@dataclasses.dataclass(frozen=True)
class FSStatResult:
    """Mirrors `@codesandbox/sdk` FSStatResult."""
    type: str  # "file" | "directory" | "symlink"
    size: int = 0
    atime: float = 0.0
    mtime: float = 0.0
    ctime: float = 0.0


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
        cls.Pico = cls("Pico", cpu=1, memory_gib=1)
        cls.Nano = cls("Nano", cpu=2, memory_gib=4)
        cls.Micro = cls("Micro", cpu=4, memory_gib=8)
        cls.Small = cls("Small", cpu=8, memory_gib=16)
        cls.Medium = cls("Medium", cpu=16, memory_gib=32)
        cls.Large = cls("Large", cpu=32, memory_gib=64)
        cls.XLarge = cls("XLarge", cpu=64, memory_gib=128)


VMTier._init_tiers()
