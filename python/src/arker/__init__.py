"""Python client for the Arker VM API."""

from . import daytona, e2b, modal
from .computer import (
    ARKER_ORG_ID,
    VM,
    Arker,
    ArkerError,
    BackgroundRunResult,
    CancelRunResponse,
    CompletedRunResult,
    ComputeProvider,
    DeleteFilesystemResponse,
    DeleteSessionResponse,
    DeleteSyncResponse,
    DeleteVmResponse,
    Filesystem,
    ListFilesystemsResponse,
    ListOrgRunsResponse,
    ListRegionsResponse,
    ListRunsResponse,
    ListSessionsResponse,
    ListSyncsResponse,
    Pty,
    RetryOptions,
    Run,
    RunRecord,
    RunResult,
    Session,
    Sync,
    SyncDirResult,
    Vm,
    VmList,
    WhoamiResponse,
    discover_regions,
)
from .generated.api_models import (
    ListVmsResponse,
    OrgRunListRow,
    RegionPlacement,
    RunSummary,
    SyncPresignedWriteCommit,
    SyncPresignedWriteRequest,
    SyncPresignedWriteRequestResult,
)

__all__ = [
    "ARKER_ORG_ID",
    "VM",
    "Arker",
    "ArkerError",
    "BackgroundRunResult",
    "CancelRunResponse",
    "CompletedRunResult",
    "ComputeProvider",
    "DeleteFilesystemResponse",
    "DeleteSessionResponse",
    "DeleteSyncResponse",
    "DeleteVmResponse",
    "Filesystem",
    "ListFilesystemsResponse",
    "ListOrgRunsResponse",
    "ListRegionsResponse",
    "ListRunsResponse",
    "ListSessionsResponse",
    "ListSyncsResponse",
    "ListVmsResponse",
    "OrgRunListRow",
    "Pty",
    "RegionPlacement",
    "RetryOptions",
    "Run",
    "RunRecord",
    "RunResult",
    "RunSummary",
    "Session",
    "Sync",
    "SyncDirResult",
    "SyncPresignedWriteCommit",
    "SyncPresignedWriteRequest",
    "SyncPresignedWriteRequestResult",
    "Vm",
    "VmList",
    "WhoamiResponse",
    "daytona",
    "discover_regions",
    "e2b",
    "modal",
]
# Derived from installed package metadata rather than hardcoded: the literal
# drifted from pyproject.toml (reported 0.8.2 while the 0.8.3 distribution was
# live), and a hardcoded copy re-drifts on any release that forgets to bump it.
# pyproject.toml stays the single source of truth.
from importlib.metadata import PackageNotFoundError as _PackageNotFoundError
from importlib.metadata import version as _pkg_version

try:
    __version__ = _pkg_version("arker")
except _PackageNotFoundError:  # source tree, not installed
    __version__ = "0.0.0.dev0"
