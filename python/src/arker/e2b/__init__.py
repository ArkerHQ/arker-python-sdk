"""Drop-in compatibility shim for the e2b Python SDK, backed by Arker VMs.

Usage:

    from arker.e2b import Sandbox

    sbx = Sandbox()                       # forks from $ARKER_E2B_DEFAULT_TEMPLATE or "ubuntu"
    sbx = Sandbox(template="my-image")    # forks from a specific Arker golden
    sbx = Sandbox(sandbox_id="vm_...")    # attaches to an existing Arker VM

    result = sbx.commands.run("echo hi")
    sbx.files.write("/tmp/x", "data")
    sbx.kill()

Phase A surface: lifecycle (construct / kill / connect), foreground
`commands.run`, and `files.read`/`files.write`. Background runs, PTY,
`files.list`/`files.exists`/`files.remove`, code interpreter, and the
async variant arrive in later phases.
"""

from ._commands import Commands
from ._files import Filesystem
from ._sandbox import Sandbox
from ._types import (
    CommandExitException,
    CommandResult,
    EntryInfo,
    FileType,
    SandboxException,
)

__all__ = [
    "CommandExitException",
    "CommandResult",
    "Commands",
    "EntryInfo",
    "FileType",
    "Filesystem",
    "Sandbox",
    "SandboxException",
]
