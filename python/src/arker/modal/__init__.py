"""Drop-in compatibility shim for the modal Python SDK's Sandbox API,
backed by Arker VMs.

Usage:

    from arker.modal import Sandbox

    with Sandbox.create() as sbx:
        p = sbx.exec("echo", "hello")
        print(p.stdout.read())
        sbx.filesystem.write_text("data", "/tmp/x.txt")

Pending work (each item has a scoped `TODO(arker-modal)` near the call
site; nothing in this list is automatically actionable yet):

  1. Most `Sandbox.create` ctor kwargs are accepted but ignored: `app`,
     `secrets`, `network_file_systems`, `gpu`, `cloud`, `region`, `cpu`,
     `memory`, `volumes`, `block_network`, `outbound_cidr_allowlist`,
     `inbound_cidr_allowlist`, `encrypted_ports` / `h2_ports` /
     `unencrypted_ports`, `custom_domain`, `proxy`,
     `include_oidc_identity_token`, `readiness_probe`, `verbose`,
     `experimental_options`, `environment_name`, `idle_timeout`,
     `workdir` (applied per-exec only). The Sandbox forks anyway with
     the default golden + name + env.

  2. `App`, `Image`, `Secret`, `Volume`, `NetworkFileSystem` are opaque
     placeholders. `Image.debian_slim()` / `.from_registry()` / `.pip_install()`
     chain works syntactically; they don't actually build images.

  3. `Sandbox.from_name(app_name, name)` raises — Arker has no App or
     named-sandbox concept.

  4. `Sandbox.tunnels()` raises — Arker exposes tunnels per-exec via
     `run(network=...)` but we don't bind them to the Sandbox lifetime.

  5. `snapshot_filesystem`, `snapshot_directory`, `mount_image`,
     `unmount_image`, `reload_volumes`, `create_connect_token` raise.

  6. `Sandbox.stdin` / `.stdout` / `.stderr` raise — those streams
     correspond to modal's entrypoint command; use the `ContainerProcess`
     returned by `sbx.exec()` instead.

  7. `Sandbox.open(path, mode)` raises — modal deprecated it in favor of
     `filesystem.read_text` / `write_text`.

  8. `Sandbox.watch` and `filesystem.watch` raise — no fs-event API.

  9. `ContainerProcess.stdin.write` raises — Arker has no non-PTY stdin
     primitive. Use a PTY (also not yet shipped) for interactive input.

 10. `exec(pty=True)` raises — needs WS PTY client.

 11. `Sandbox.list(app_id=, tags=)` ignores both filters — Arker has
     no App/tags concepts server-side. Returns all sandboxes for the API key.

 12. `Sandbox.wait()` is a no-op — Arker VMs don't auto-terminate based
     on an entrypoint; this is a meaningful semantic divergence.

 13. `idle_timeout` is accepted but not enforced — same gap as our other
     shims: Arker has no SDK-level VM TTL yet.

 14. Sandbox stream readers are poll-based, not real-time. `for line in
     proc.stdout:` yields lines per poll cycle, not as the kernel emits
     them. Live streaming needs WS support.

 15. `filesystem.list_files` / `stat` returns daytona-style integer mode
     (`0o755`), matching modal's documented FileInfo. Owner/group not
     populated (modal doesn't expose them on FileInfo).
"""

from ._filesystem import SandboxFilesystem
from ._process import ContainerProcess, StreamReader, StreamWriter
from ._sandbox import Sandbox
from ._types import (
    App,
    FileInfo,
    FileType,
    FilesystemExecutionError,
    Image,
    InvalidError,
    NetworkFileSystem,
    NotFoundError,
    SandboxConnectCredentials,
    SandboxError,
    SandboxTimeoutError,
    Secret,
    StreamType,
    Tunnel,
    Volume,
)

__all__ = [
    "App",
    "ContainerProcess",
    "FileInfo",
    "FileType",
    "FilesystemExecutionError",
    "Image",
    "InvalidError",
    "NetworkFileSystem",
    "NotFoundError",
    "Sandbox",
    "SandboxConnectCredentials",
    "SandboxError",
    "SandboxFilesystem",
    "SandboxTimeoutError",
    "Secret",
    "StreamReader",
    "StreamType",
    "StreamWriter",
    "Tunnel",
    "Volume",
]
