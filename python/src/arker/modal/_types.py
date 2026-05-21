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


class FileType(enum.Enum):
    """Mirrors `modal.sandbox_fs.FileType` — exactly three members. Plain
    `Enum` (not `str, Enum`) so `entry.type == "file"` doesn't accidentally
    pass like it would with a str-mixed enum."""
    FILE = "file"
    DIRECTORY = "directory"
    SYMLINK = "symlink"


@dataclasses.dataclass(frozen=True)
class FileInfo:
    """Mirrors `modal.FileInfo`. `is_dir()` is a METHOD (modal); the dataclass
    field is `_kind` so we can keep the method name canonical.

    Field set matches modal: name, path, type, size, mode, permissions, owner,
    group, modified_time, symlink_target.
    """
    name: str
    path: str
    type: FileType
    size: int = 0
    mode: int = 0
    permissions: str = ""
    owner: str = ""
    group: str = ""
    modified_time: float = 0.0
    symlink_target: str | None = None

    def is_file(self) -> bool:
        return self.type is FileType.FILE

    def is_dir(self) -> bool:
        return self.type is FileType.DIRECTORY

    def is_symlink(self) -> bool:
        return self.type is FileType.SYMLINK


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
        # Matches modal: omit `:443` since that's the implicit HTTPS port.
        if self.port == 443:
            return f"https://{self.host}"
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
#
# Best-effort: subclass `modal.exception.*` when modal is installed so
# `except modal.exception.NotFoundError:` blocks in customer code catch
# our errors. When modal isn't installed, fall back to plain hierarchy.
try:  # pragma: no cover — depends on whether `modal` is importable
    from modal import exception as _modal_exception  # type: ignore[import-not-found]
    _ModalErrorBase = _modal_exception.Error  # type: ignore[attr-defined]
    _ModalNotFound = _modal_exception.NotFoundError  # type: ignore[attr-defined]
    _ModalTimeout = _modal_exception.SandboxTimeoutError  # type: ignore[attr-defined]
    _ModalFsExec = _modal_exception.FilesystemExecutionError  # type: ignore[attr-defined]
    _ModalInvalid = _modal_exception.InvalidError  # type: ignore[attr-defined]
except Exception:
    _ModalErrorBase = Exception
    _ModalNotFound = Exception
    _ModalTimeout = Exception
    _ModalFsExec = Exception
    _ModalInvalid = Exception


class SandboxError(_ModalErrorBase):  # type: ignore[misc, valid-type]
    """Base exception for the arker.modal compat layer.

    Subclasses `modal.exception.Error` when modal is installed so existing
    `except modal.exception.Error:` blocks catch our exceptions.
    """


class SandboxTimeoutError(SandboxError, _ModalTimeout):  # type: ignore[misc, valid-type]
    pass


class NotFoundError(SandboxError, _ModalNotFound):  # type: ignore[misc, valid-type]
    pass


class FilesystemExecutionError(SandboxError, _ModalFsExec):  # type: ignore[misc, valid-type]
    """Mirrors `modal.exception.FilesystemExecutionError`."""


# Specific filesystem error subclasses. Modal raises these for granular
# cases; customer code commonly catches them individually.
try:  # pragma: no cover
    _ModalFsNotFound = _modal_exception.SandboxFilesystemNotFoundError  # type: ignore[attr-defined]
    _ModalFsPerm = _modal_exception.SandboxFilesystemPermissionError  # type: ignore[attr-defined]
    _ModalFsIsDir = _modal_exception.SandboxFilesystemIsADirectoryError  # type: ignore[attr-defined]
    _ModalFsNotDir = _modal_exception.SandboxFilesystemNotADirectoryError  # type: ignore[attr-defined]
    _ModalFsDirNotEmpty = _modal_exception.SandboxFilesystemDirectoryNotEmptyError  # type: ignore[attr-defined]
    _ModalFsExists = _modal_exception.SandboxFilesystemPathAlreadyExistsError  # type: ignore[attr-defined]
    _ModalFsTooLarge = _modal_exception.SandboxFilesystemFileTooLargeError  # type: ignore[attr-defined]
except Exception:
    _ModalFsNotFound = _ModalFsPerm = _ModalFsIsDir = _ModalFsNotDir = Exception
    _ModalFsDirNotEmpty = _ModalFsExists = _ModalFsTooLarge = Exception


class SandboxFilesystemNotFoundError(FilesystemExecutionError, _ModalFsNotFound):  # type: ignore[misc, valid-type]
    pass


class SandboxFilesystemPermissionError(FilesystemExecutionError, _ModalFsPerm):  # type: ignore[misc, valid-type]
    pass


class SandboxFilesystemIsADirectoryError(FilesystemExecutionError, _ModalFsIsDir):  # type: ignore[misc, valid-type]
    pass


class SandboxFilesystemNotADirectoryError(FilesystemExecutionError, _ModalFsNotDir):  # type: ignore[misc, valid-type]
    pass


class SandboxFilesystemDirectoryNotEmptyError(FilesystemExecutionError, _ModalFsDirNotEmpty):  # type: ignore[misc, valid-type]
    pass


class SandboxFilesystemPathAlreadyExistsError(FilesystemExecutionError, _ModalFsExists):  # type: ignore[misc, valid-type]
    pass


class SandboxFilesystemFileTooLargeError(FilesystemExecutionError, _ModalFsTooLarge):  # type: ignore[misc, valid-type]
    pass


def classify_fs_error(stderr: str, default_message: str = "") -> FilesystemExecutionError:
    """Map a shell-stderr string to the right SandboxFilesystem* subclass.
    Matches modal's daemon-side error categorization."""
    s = stderr or default_message
    msg = s.strip() or default_message or "filesystem error"
    sl = s.lower()
    if "no such" in sl or "cannot access" in sl:
        return SandboxFilesystemNotFoundError(msg)
    if "permission denied" in sl:
        return SandboxFilesystemPermissionError(msg)
    if "is a directory" in sl:
        return SandboxFilesystemIsADirectoryError(msg)
    if "not a directory" in sl:
        return SandboxFilesystemNotADirectoryError(msg)
    if "directory not empty" in sl:
        return SandboxFilesystemDirectoryNotEmptyError(msg)
    if "file exists" in sl or "already exists" in sl:
        return SandboxFilesystemPathAlreadyExistsError(msg)
    if "file too large" in sl or "no space" in sl:
        return SandboxFilesystemFileTooLargeError(msg)
    return FilesystemExecutionError(msg)


class InvalidError(SandboxError, _ModalInvalid):  # type: ignore[misc, valid-type]
    """Mirrors `modal.exception.InvalidError` — raised by `ContainerProcess.returncode`
    pre-wait and by filesystem ops on relative paths."""


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

    # Each builder returns a NEW Image — matches modal's immutability so
    # `base = Image.debian_slim(); a = base.pip_install("x"); b = base.pip_install("y")`
    # produces three distinct objects.
    def _spawn(self, **kwargs: Any) -> "Image":
        return Image(_base=self, **kwargs)

    def apt_install(self, *packages: str) -> "Image":
        return self._spawn(_op="apt_install", packages=packages)

    def pip_install(self, *packages: str, **kwargs: Any) -> "Image":
        return self._spawn(_op="pip_install", packages=packages, **kwargs)

    def run_commands(self, *commands: str) -> "Image":
        return self._spawn(_op="run_commands", commands=commands)

    def env(self, vars: dict[str, str]) -> "Image":  # noqa: A002 — matches modal's param name
        return self._spawn(_op="env", env_vars=vars)

    def workdir(self, path: str) -> "Image":
        return self._spawn(_op="workdir", path=path)


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
