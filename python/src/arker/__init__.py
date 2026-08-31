"""Python client for the Arker VM API."""
from .computer import (
    ARKER_ORG_ID,
    Arker,
    ArkerError,
    BackgroundRunResult,
    CancelRunResponse,
    CompletedRunResult,
    ComputeProvider,
    discover_regions,
    VM,
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
    ListVmsResponse,
    Pty,
    RegionPlacement,
    RetryOptions,
    Run,
    RunRecord,
    OrgRunListRow,
    RunResult,
    RunSummary,
    Session,
    Sync,
    SyncDirResult,
    Vm,
    VmList,
    WhoamiResponse,
)

from . import daytona, e2b, modal

__all__ = [
    "ARKER_ORG_ID",
    "Arker",
    "ArkerError",
    "BackgroundRunResult",
    "CancelRunResponse",
    "CompletedRunResult",
    "ComputeProvider",
    "discover_regions",
    "VM",
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
    "Pty",
    "RegionPlacement",
    "RetryOptions",
    "Run",
    "RunRecord",
    "OrgRunListRow",
    "RunResult",
    "RunSummary",
    "Session",
    "Sync",
    "SyncDirResult",
    "Vm",
    "VmList",
    "WhoamiResponse",
    "daytona",
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
