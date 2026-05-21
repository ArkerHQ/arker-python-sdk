"""Drop-in compatibility shim for the @codesandbox/sdk CodeSandbox API,
backed by Arker VMs.

Usage:

    from arker.codesandbox import CodeSandbox

    csb = CodeSandbox(api_token="ark_live_...")
    sandbox = csb.sandboxes.create()
    client = sandbox.connect()
    output = client.commands.run("echo hello")
    client.fs.writeTextFile("/sandbox/data.txt", "hi")
    csb.sandboxes.delete(sandbox.id)

Pending work (each gap also has a `TODO(arker-codesandbox)` near the call
site; nothing here is automatically actionable yet):

  1. `Sandbox.updateTier(VMTier)` raises — Arker has no live VM-tier
     rescale primitive.
  2. `sandboxes.hibernate(id)` / `shutdown(id)` are no-op + warning —
     Arker has no hibernate/stop-without-delete primitive. VMs keep
     running until `delete()`. Use `delete()` to actually destroy.
  3. `Sandbox.updateHibernationTimeout(secs)` stores locally and warns —
     Arker has no server-side hibernation.
  4. `SandboxClient.shells`, `.tasks`, `.ports`, `.interpreters`, `.hosts`
     all throw NotImplementedError on attribute access — they need WS /
     persistent connection plumbing we haven't shipped.
  5. `sandboxes.list({tags: ...})` raises — Arker doesn't store sandbox
     tags server-side.
  6. `fs.watch` and `fs.download` raise — no fs-event API, no signed
     download URL in our shim.
  7. `commands.runBackground` returns a Command handle but we don't yet
     poll its status/output back into the Command object — `Command.status`
     stays `RUNNING` forever. (Fix: wire `commands.get(name).status` to
     poll `run_status` via the stashed `_run_id`.)
  8. `bootupType` is set heuristically: FORK on create, RESUME on resume,
     RUNNING on get-running-vm, CLEAN on restart. Modal-canonical
     interpretation (matches codesandbox conceptually but Arker has no
     hibernation snapshot, so RESUME never reflects a real snapshot).
  9. `Sandbox.cluster` is `Arker.region` if set, else `""`. Codesandbox
     returns its internal cluster name; ours is a region string. Code
     branching on the literal cluster name will differ.
 10. Sandbox IDs are Arker ULIDs, not codesandbox short IDs. Code that
     regex-validates IDs needs updating.
"""

from ._client import CodeSandbox, Sandboxes
from ._commands import Commands
from ._filesystem import Filesystem
from ._sandbox import Sandbox
from ._sandbox_client import SandboxClient
from ._types import (
    AuthenticationError,
    BootupType,
    CodeSandboxError,
    Command,
    CommandError,
    CommandStatus,
    FSStatResult,
    PaginationInfo,
    RateLimitError,
    ReaddirEntry,
    SandboxInfo,
    SandboxListResponse,
    SandboxNotFoundError,
    VMTier,
)

__all__ = [
    "AuthenticationError",
    "BootupType",
    "CodeSandbox",
    "CodeSandboxError",
    "Command",
    "CommandError",
    "CommandStatus",
    "Commands",
    "FSStatResult",
    "Filesystem",
    "PaginationInfo",
    "RateLimitError",
    "ReaddirEntry",
    "Sandbox",
    "SandboxClient",
    "SandboxInfo",
    "SandboxListResponse",
    "SandboxNotFoundError",
    "Sandboxes",
    "VMTier",
]
