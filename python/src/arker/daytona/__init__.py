"""Drop-in compatibility shim for the daytona Python SDK, backed by Arker VMs.

Usage:

    from arker.daytona import Daytona, DaytonaConfig

    daytona = Daytona(DaytonaConfig(api_key="ark_live_..."))
    sandbox = daytona.create()
    resp = sandbox.process.code_run("print(2+2)")
    print(resp.result)        # -> "4\n"
    sandbox.delete()

Or with the context-manager idiom:

    with daytona.create() as sbx:
        sbx.fs.upload_file(b"hello", "/tmp/x.txt")

Pending work (each item also has a scoped `TODO(arker-daytona)` at the call
site):

  1. Server-side env vars. `Daytona().create(env=...)` stores env locally
     and inlines it into `process.exec` calls; Arker doesn't persist VM env
     vars. See `_sandbox.py:env`.

  2. Server-side labels / set_labels. Local-only, not queryable.
     See `_sandbox.py:set_labels`.

  3. start / stop / archive lifecycle is a no-op — Arker VMs don't have a
     distinct stopped state. See `_sandbox.py:start/stop/archive`.

  4. SSH access (`create_ssh_access` / `revoke_ssh_access`) and preview
     links (`get_preview_link`) are not implemented for Phase A. Calls
     raise NotImplementedError.

  5. Jupyter-style state across `process.code_run` calls — we shell out
     to `python3 /tmp/<rand>.py` each call. State doesn't carry; chart
     capture not implemented (artifacts.charts is always None).
     See `_process.py:code_run`.

  6. `process.create_session` + friends ship in Phase C (sync via
     `Computer.run(session_id=...)`, async via background runs). Caveats:
     - `delete_session` is local-only (Arker SDK doesn't expose
       `DELETE /v1/vms/{id}/sessions/{sid}` yet)
     - `get_entrypoint_session` / `get_entrypoint_logs` raise — Arker
       has no entrypoint-session concept
     - `get_session_command_logs_async` raises — needs WS streaming
     - `send_session_command_input` raises — no non-PTY stdin primitive
     - PTY-session methods (`create_pty_session`, etc.) all raise — same
       WS dependency as e2b's pty namespace

  7. Some `fs` ops still raise NotImplementedError:
       - `search_files` — needs filename-vs-content semantics pinned
       - `replace_in_files` — needs daytona regex flavor pinned vs sed -E
       - `upload_files` / `download_files` batch — loop the single-file ops
       - `upload_file_stream` / `download_file_stream` — Arker's sync API
         chunks internally; exposing chunk callbacks is a follow-up
     `list_files`, `delete_file`, `create_folder`, `find_files`,
     `get_file_info`, `move_files`, `set_file_permissions` work (Phase B).

  8. `git`, `lsp`, `computer_use`, `code_interpreter` sub-namespaces
     aren't implemented at all (Phase A scope). Accessing them raises
     AttributeError.

  9. `resize`, `set_autostop_interval`, `set_auto_archive_interval`,
     `set_auto_delete_interval`, `update_network_settings` — local
     no-ops; Arker has no equivalents.

 10. `AsyncDaytona` (async client) ships in Phase D via `asyncio.to_thread`
     around the sync `Daytona` — equivalent behavior, slight cold-start
     latency from the thread hop. Native async HTTP would close the gap.
"""

from ._async import AsyncDaytona, AsyncSandbox
from ._client import Daytona
from ._files import FileSystem
from ._process import Process
from ._sandbox import Sandbox
from ._types import (
    Chart,
    CodeRunParams,
    Command,
    CreateSandboxFromImageParams,
    CreateSandboxFromSnapshotParams,
    DaytonaAuthenticationError,
    DaytonaAuthorizationError,
    DaytonaConfig,
    DaytonaConflictError,
    DaytonaConnectionError,
    DaytonaError,
    DaytonaNotFoundError,
    DaytonaRateLimitError,
    DaytonaTimeoutError,
    DaytonaValidationError,
    Resources,
    ExecuteResponse,
    ExecutionArtifacts,
    FileInfo,
    FileSystemError,
    Match,
    PaginatedSandboxes,
    ProcessError,
    ReplaceResult,
    SandboxNotFoundError,
    SandboxState,
    SearchFilesResponse,
    Session,
    SessionCommandLogsResponse,
    SessionExecuteRequest,
    SessionExecuteResponse,
    SessionNotFoundError,
)

__all__ = [
    "AsyncDaytona",
    "AsyncSandbox",
    "Chart",
    "CodeRunParams",
    "Command",
    "CreateSandboxFromImageParams",
    "CreateSandboxFromSnapshotParams",
    "Daytona",
    "DaytonaAuthenticationError",
    "DaytonaAuthorizationError",
    "DaytonaConfig",
    "DaytonaConflictError",
    "DaytonaConnectionError",
    "DaytonaError",
    "DaytonaNotFoundError",
    "DaytonaRateLimitError",
    "DaytonaTimeoutError",
    "DaytonaValidationError",
    "ExecuteResponse",
    "ExecutionArtifacts",
    "FileInfo",
    "FileSystem",
    "FileSystemError",
    "Match",
    "PaginatedSandboxes",
    "Process",
    "ProcessError",
    "ReplaceResult",
    "Resources",
    "Sandbox",
    "SandboxNotFoundError",
    "SandboxState",
    "SearchFilesResponse",
    "Session",
    "SessionCommandLogsResponse",
    "SessionExecuteRequest",
    "SessionExecuteResponse",
    "SessionNotFoundError",
]
