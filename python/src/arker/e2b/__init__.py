"""Drop-in compatibility shim for the e2b Python SDK, backed by Arker VMs.

Usage:

    from arker.e2b import Sandbox

    with Sandbox() as sbx:               # forks from $ARKER_E2B_DEFAULT_TEMPLATE or "base"
        result = sbx.commands.run("echo hi")
        sbx.files.write("/tmp/x", "data")

Pending work (tracked here so the gaps are discoverable in one place;
each item also has a scoped `TODO(arker-e2b)` marker at the call site):

  1. Server-side VM TTL — `Sandbox(timeout=N)` / `set_timeout(N)` only store
     the value locally and emit a UserWarning. VMs live until killed.
     Blocked on core Arker SDK exposing a mutable TTL endpoint.
     See `_sandbox.py:_warn_timeout_noop`.

  2. ArkerError → typed-exception mapping. The subclass hierarchy is in
     place (`TimeoutException`, `NotFoundException`, etc.) but the shim
     still lets `ArkerError` bubble unchanged. Needs an HTTP-status
     discriminator in the request path. See `_types.py` exception block.

  3. Live per-line `on_stdout` / `on_stderr` streaming. Today we poll
     `run_status` and emit deltas per poll cycle. Real per-line streaming
     needs a WebSocket client (Arker's run already returns a `ws_url`).
     See `_handle.py:wait` and `_handle.py:__iter__`.

  4. Interactive PTY (`pty.create / send_stdin / resize / kill`) — same
     WS dependency as #3. Currently all raise NotImplementedError.
     See `_pty.py`.

  5. Jupyter-style stateful `run_code`. e2b persists variables across
     successive `run_code` calls via a kernel; we shell out to
     `python3 /tmp/<rand>.py` each time, so state never carries.
     `Execution.results[]` is also always empty (no rich-output capture).
     See `code_interpreter/_sandbox.py:run_code`.

  6. `commands.send_stdin` (non-PTY stdin to a background run) — Arker
     has no equivalent primitive. Raises NotImplementedError.
     See `_commands.py:send_stdin`.

  7. `files.read(format="stream")` and `files.watch_dir` — Arker's sync
     API returns whole files, and there's no fs-event endpoint. Both
     raise NotImplementedError. See `_files.py`.

  8. `Sandbox.list()` metadata filter — Arker doesn't store metadata
     server-side, so list filters by metadata can't be honored. Returns
     `metadata={}` for every row. See `_sandbox.py:list`.

  9. e2b-desktop (mouse / keyboard / screenshot) — separate package,
     out of scope for this shim. No stubs.

 10. sandbox_id format differs (Arker ULIDs vs e2b's `sb_xxx`). Users who
     regex-validate or persist these IDs need to update their patterns.
     Cannot be fixed in this shim.
"""

from ._async_sandbox import AsyncSandbox
from ._commands import Commands
from ._files import Filesystem
from ._handle import CommandHandle
from ._pty import Pty, PtySize
from ._sandbox import Sandbox
from ._types import (
    AuthenticationException,
    CommandExitException,
    CommandResult,
    EntryInfo,
    FileNotFoundException,
    FileType,
    InvalidArgumentException,
    NotEnoughSpaceException,
    NotFoundException,
    ProcessInfo,
    RateLimitException,
    SandboxException,
    SandboxInfo,
    SandboxNotFoundException,
    TemplateException,
    TimeoutException,
)

__all__ = [
    "AsyncSandbox",
    "AuthenticationException",
    "CommandExitException",
    "CommandHandle",
    "CommandResult",
    "Commands",
    "EntryInfo",
    "FileNotFoundException",
    "FileType",
    "Filesystem",
    "InvalidArgumentException",
    "NotEnoughSpaceException",
    "NotFoundException",
    "ProcessInfo",
    "Pty",
    "PtySize",
    "RateLimitException",
    "Sandbox",
    "SandboxException",
    "SandboxInfo",
    "SandboxNotFoundException",
    "TemplateException",
    "TimeoutException",
]
