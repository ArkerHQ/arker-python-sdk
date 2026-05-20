"""modal-shaped types for the `arker.modal` drop-in shim.

Field naming mirrors `modal.Sandbox` so existing destructuring works.
"""

from __future__ import annotations

import dataclasses
import enum
from typing import Any


class StreamType(str, enum.Enum):
    """Mirrors `modal.StreamType`. The `STDOUT` / `STDERR` values are used to
    redirect a stream's output (e.g. `stdout=StreamType.STDOUT` prints to the
    parent process's stdout). `PIPE` is the default."""
    PIPE = "pipe"
    STDOUT = "stdout"
    STDERR = "stderr"
    DEVNULL = "devnull"


@dataclasses.dataclass(frozen=True)
class FileInfo:
    """Mirrors `modal.FileInfo` returned by `filesystem.list_files()` / `.stat()`."""
    path: str
    is_dir: bool
    size: int = 0
    mode: int = 0
    mtime: float = 0.0


@dataclasses.dataclass(frozen=True)
class Tunnel:
    """Mirrors `modal.Tunnel`. `host` and `port` are the canonical fields;
    `url` is a convenience constructor."""
    host: str
    port: int
    unencrypted_host: str | None = None
    unencrypted_port: int | None = None

    @property
    def url(self) -> str:
        return f"https://{self.host}:{self.port}"

    @property
    def tls_socket(self) -> tuple[str, int]:
        return (self.host, self.port)


@dataclasses.dataclass(frozen=True)
class SandboxConnectCredentials:
    """Mirrors `modal.SandboxConnectCredentials` — placeholder; we don't
    issue connect tokens. `create_connect_token` raises NotImplementedError."""
    url: str
    token: str


# ---- Exceptions ----


class SandboxError(Exception):
    """Base exception for the arker.modal compat layer."""


class SandboxTimeoutError(SandboxError):
    pass


class NotFoundError(SandboxError):
    pass


class FilesystemExecutionError(SandboxError):
    """Mirrors `modal.exception.FilesystemExecutionError` raised by filesystem ops."""


def translate_arker_error(error: Exception) -> SandboxError:
    """Map an `ArkerError` (or other low-level error) into the right
    modal-typed exception. Idempotent."""
    if isinstance(error, SandboxError):
        return error
    status = getattr(error, "status", 0)
    code = getattr(error, "code", "internal")
    message = getattr(error, "message", str(error))
    del code  # modal exceptions don't carry an error code
    if status == 404:
        return NotFoundError(message)
    if status in (408, 504):
        return SandboxTimeoutError(message)
    return SandboxError(message)


# ---- Opaque placeholders for modal primitives we accept but don't model ----


class _ModalOpaque:
    """Placeholder for modal types (App, Image, Secret, Volume, NetworkFileSystem)
    that we accept as kwargs but don't otherwise model. Subclassed for type
    parity; instances are inert."""
    def __init__(self, *args: Any, **kwargs: Any) -> None:
        self._args = args
        self._kwargs = kwargs


class App(_ModalOpaque):
    """Opaque placeholder for `modal.App`. Accepts the same constructor args."""


class Image(_ModalOpaque):
    """Opaque placeholder for `modal.Image`. Standard recipe methods are
    no-op class methods that return another Image — see __init__.py."""

    @classmethod
    def debian_slim(cls, python_version: str | None = None) -> "Image":
        return cls(_recipe="debian_slim", python_version=python_version)

    @classmethod
    def from_registry(cls, tag: str, *args: Any, **kwargs: Any) -> "Image":
        return cls(_recipe="from_registry", tag=tag, **kwargs)

    @classmethod
    def from_dockerfile(cls, path: str, *args: Any, **kwargs: Any) -> "Image":
        return cls(_recipe="from_dockerfile", path=path, **kwargs)

    def apt_install(self, *packages: str) -> "Image":
        # Returns self to keep chained-recipe syntax working.
        return self

    def pip_install(self, *packages: str, **kwargs: Any) -> "Image":
        return self

    def run_commands(self, *commands: str) -> "Image":
        return self

    def env(self, env_vars: dict[str, str]) -> "Image":
        return self

    def workdir(self, path: str) -> "Image":
        return self


class Secret(_ModalOpaque):
    @classmethod
    def from_dict(cls, env_dict: dict[str, str]) -> "Secret":
        return cls(_recipe="from_dict", env=env_dict)

    @classmethod
    def from_name(cls, name: str, *args: Any, **kwargs: Any) -> "Secret":
        return cls(_recipe="from_name", name=name)


class Volume(_ModalOpaque):
    @classmethod
    def from_name(cls, name: str, *args: Any, **kwargs: Any) -> "Volume":
        return cls(_recipe="from_name", name=name)


class NetworkFileSystem(_ModalOpaque):
    @classmethod
    def from_name(cls, name: str, *args: Any, **kwargs: Any) -> "NetworkFileSystem":
        return cls(_recipe="from_name", name=name)
