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

  6. `process.create_session` and friends (stateful shell sessions, PTY
     sessions) aren't implemented in Phase A. Use `process.exec` for now.

  7. `fs` advanced ops (find_files, replace_in_files, search_files,
     set_file_permissions, upload_files batch, download_files batch,
     upload_file_stream, download_file_stream) aren't implemented in
     Phase A. Use upload_file / download_file.

  8. `git`, `lsp`, `computer_use`, `code_interpreter` sub-namespaces
     aren't implemented at all (Phase A scope). Accessing them raises
     AttributeError.

  9. `resize`, `set_autostop_interval`, `set_auto_archive_interval`,
     `set_auto_delete_interval`, `update_network_settings` — local
     no-ops; Arker has no equivalents.

 10. `AsyncDaytona` (async client) not yet shipped in Phase A.
"""

from ._client import Daytona
from ._files import FileSystem
from ._process import Process
from ._sandbox import Sandbox
from ._types import (
    Chart,
    CodeRunParams,
    DaytonaConfig,
    DaytonaError,
    ExecuteResponse,
    ExecutionArtifacts,
    FileSystemError,
    ProcessError,
    SandboxNotFoundError,
    SandboxState,
)

__all__ = [
    "Chart",
    "CodeRunParams",
    "Daytona",
    "DaytonaConfig",
    "DaytonaError",
    "ExecuteResponse",
    "ExecutionArtifacts",
    "FileSystem",
    "FileSystemError",
    "Process",
    "ProcessError",
    "Sandbox",
    "SandboxNotFoundError",
    "SandboxState",
]
