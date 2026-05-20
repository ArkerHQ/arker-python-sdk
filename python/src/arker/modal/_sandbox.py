"""`modal.Sandbox` — backed by an Arker `Computer`.

Drop-in for `modal.Sandbox`. Construct via `Sandbox.create(...)` or attach
to an existing Arker VM via `Sandbox.from_id(...)`. Most modal-specific
constructor params (`app`, `image`, `secrets`, `network_file_systems`,
`volumes`, …) are accepted but ignored — see pending notes in __init__.py.
"""

from __future__ import annotations

import logging
import os
import secrets as _secrets
import shlex
from typing import Any

from ..computer import Arker, ArkerError, BackgroundRunResult, Computer
from ._filesystem import SandboxFilesystem
from ._process import ContainerProcess
from ._types import (
    NotFoundError,
    SandboxError,
    StreamType,
    Tunnel,
    translate_arker_error,
)

logger = logging.getLogger("arker.modal")

DEFAULT_TEMPLATE_ENV = "ARKER_MODAL_DEFAULT_TEMPLATE"
DEFAULT_TEMPLATE = "base"


def _resolve_template(image: Any) -> str:
    """Resolve a modal Image / template name / None to an Arker golden."""
    if image is None:
        return os.environ.get(DEFAULT_TEMPLATE_ENV, DEFAULT_TEMPLATE)
    if isinstance(image, str):
        return image
    # Opaque modal Image: try to pull a name out, else default.
    name = getattr(image, "_kwargs", {}).get("tag")
    if isinstance(name, str):
        return name
    return os.environ.get(DEFAULT_TEMPLATE_ENV, DEFAULT_TEMPLATE)


def _build_arker(client: Any) -> Arker:
    """`client=` would be a modal.Client in real modal; we ignore it and use
    standard Arker env-var resolution."""
    del client
    return Arker()


class Sandbox:
    """Drop-in for `modal.Sandbox`. Many ctor kwargs are no-ops here — see
    `__init__.py` for the catalogue."""

    def __init__(
        self,
        arker: Arker,
        computer: Computer,
        *,
        env: dict[str, str] | None = None,
        tags: dict[str, str] | None = None,
    ) -> None:
        self._arker = arker
        self._computer = computer
        self._env: dict[str, str] = dict(env or {})
        self._tags: dict[str, str] = dict(tags or {})
        self._returncode: int | None = None
        self.filesystem = SandboxFilesystem(self)

    # ---- Properties ----

    @property
    def object_id(self) -> str:
        return self._computer.id

    @property
    def returncode(self) -> int | None:
        return self._returncode

    # ---- Factory classmethods ----

    @classmethod
    def create(
        cls,
        *args: Any,
        app: Any = None,
        name: str | None = None,
        tags: dict[str, str] | None = None,
        image: Any = None,
        env: dict[str, str] | None = None,
        secrets: Any = None,
        network_file_systems: Any = None,
        timeout: int = 300,
        idle_timeout: int | None = None,
        workdir: str | None = None,
        gpu: Any = None,
        cloud: str | None = None,
        region: str | None = None,
        cpu: float | None = None,
        memory: int | None = None,
        block_network: bool = False,
        outbound_cidr_allowlist: list[str] | None = None,
        inbound_cidr_allowlist: list[str] | None = None,
        volumes: Any = None,
        pty: bool = False,
        encrypted_ports: list[int] | None = None,
        h2_ports: list[int] | None = None,
        unencrypted_ports: list[int] | None = None,
        custom_domain: str | None = None,
        proxy: Any = None,
        include_oidc_identity_token: bool = False,
        readiness_probe: Any = None,
        verbose: bool = False,
        experimental_options: Any = None,
        client: Any = None,
        environment_name: str | None = None,
        **_kwargs: Any,
    ) -> "Sandbox":
        """Fork an Arker VM and return a Sandbox.

        Most kwargs are accepted but ignored. `image` resolves to an Arker
        golden (modal's `Image.debian_slim()` etc. opaque-pass; we use the
        image's tag if present, else the default template).
        """
        # The variadic `*args` slot in real modal is the entrypoint command;
        # if provided, store it for an initial exec. We don't auto-spawn.
        del args, secrets, network_file_systems, gpu, cloud, region, cpu, memory
        del block_network, outbound_cidr_allowlist, inbound_cidr_allowlist, volumes
        del pty, encrypted_ports, h2_ports, unencrypted_ports, custom_domain, proxy
        del include_oidc_identity_token, readiness_probe, verbose, experimental_options
        del environment_name, idle_timeout, workdir, app, timeout

        arker = _build_arker(client)
        source = _resolve_template(image)
        try:
            computer = arker.vm(source).fork(name=name)
        except ArkerError as error:
            raise translate_arker_error(error) from error
        return cls(arker, computer, env=env, tags=tags)

    @classmethod
    def from_id(cls, sandbox_id: str, client: Any = None) -> "Sandbox":
        if not sandbox_id:
            raise SandboxError("sandbox_id is required")
        arker = _build_arker(client)
        return cls(arker, arker.vm(sandbox_id))

    @classmethod
    def from_name(cls, app_name: str, name: str, environment_name: str | None = None, client: Any = None) -> "Sandbox":
        raise NotImplementedError(
            "arker.modal: Sandbox.from_name is not implemented — Arker has no "
            "App / named-sandbox concept. Use Sandbox.from_id(vm_id) or "
            "Sandbox.list() to find a VM."
        )

    # ---- Execution ----

    def exec(
        self,
        *args: str,
        stdout: StreamType | int = StreamType.PIPE,
        stderr: StreamType | int = StreamType.PIPE,
        timeout: int | None = None,
        workdir: str | None = None,
        env: dict[str, str] | None = None,
        secrets: Any = None,
        text: bool = True,
        bufsize: int = -1,
        pty: bool = False,
        **_kwargs: Any,
    ) -> ContainerProcess:
        """Execute a command in the sandbox. `args` are joined into a single
        shell command (matching modal's variadic API).

        Returns a `ContainerProcess` — use `.wait()` to block, `.stdout.read()`
        to read the output, `.returncode` for the exit code.
        """
        del stdout, stderr, bufsize, secrets
        if pty:
            raise NotImplementedError(
                "arker.modal: exec(pty=True) is not supported yet — Arker PTY "
                "needs a WebSocket client we haven't shipped."
            )
        if not args:
            raise ValueError("exec() requires at least one argument")

        cmd = " ".join(shlex.quote(arg) for arg in args)
        merged_env = {**self._env, **(env or {})}
        if merged_env:
            env_parts = " ".join(f"{shlex.quote(k)}={shlex.quote(v)}" for k, v in merged_env.items())
            cmd = f"env {env_parts} {cmd}"
        if workdir:
            cmd = f"cd {shlex.quote(workdir)} && {cmd}"

        try:
            result = self._computer.run(cmd, background=True, timeout=timeout)
        except ArkerError as error:
            raise translate_arker_error(error) from error
        if not isinstance(result, BackgroundRunResult):
            raise SandboxError(f"exec expected BackgroundRunResult, got {type(result).__name__}")
        return ContainerProcess(self, result.run_id, text=text)

    # ---- Lifecycle ----

    def terminate(self, wait: bool = False) -> int | None:
        """Terminate the sandbox. Mirrors modal's `terminate(wait=False)`.
        Returns the returncode (or None if non-blocking and not known)."""
        del wait
        try:
            self._computer.delete()
        except ArkerError as error:
            raise translate_arker_error(error) from error
        if self._returncode is None:
            self._returncode = 0
        return self._returncode

    def wait(self, raise_on_termination: bool = True) -> None:
        """Block until the sandbox finishes. For our shim, this returns
        immediately because Arker VMs don't have a "finished" state —
        a real `wait()` would track the sandbox's primary process.
        We document this in pending notes."""
        del raise_on_termination
        logger.debug("arker.modal: Sandbox.wait() — no-op; Arker VMs don't auto-terminate")

    def poll(self) -> int | None:
        """Return the exit code or None if running. Mirrors modal."""
        return self._returncode

    def hydrate(self, client: Any = None) -> "Sandbox":
        """Refresh the local object from the server. For our shim, no-op
        since we don't cache server state on the Sandbox itself."""
        del client
        return self

    def detach(self) -> None:
        """Disconnect without terminating. Local-only — we don't hold any
        connection state."""
        return None

    # ---- Tags ----

    def get_tags(self) -> dict[str, str]:
        """Local-only — Arker doesn't store tags server-side. Returns a copy."""
        return dict(self._tags)

    def set_tags(self, tags: dict[str, str], client: Any = None) -> None:
        del client
        self._tags = dict(tags)

    # ---- Tunnels (Phase D) ----

    def tunnels(self, timeout: int = 50) -> dict[int, Tunnel]:
        """Return a mapping of container_port → Tunnel. Modal exposes the
        ports declared via `encrypted_ports`/`h2_ports`/`unencrypted_ports`
        at create time; we don't model those yet."""
        del timeout
        raise NotImplementedError(
            "arker.modal: Sandbox.tunnels() is not implemented — Arker has "
            "tunnels via run(network=...) but we don't bind them to the "
            "Sandbox lifetime. Use sbx.exec(..., network=...) directly."
        )

    # ---- Not implemented (loud) ----

    def snapshot_filesystem(self, timeout: int = 55) -> Any:
        raise NotImplementedError("arker.modal: Sandbox.snapshot_filesystem is not supported — Arker has no VM snapshot API.")

    def snapshot_directory(self, path: Any) -> Any:
        raise NotImplementedError("arker.modal: Sandbox.snapshot_directory is not supported.")

    def mount_image(self, path: Any, image: Any) -> None:
        raise NotImplementedError("arker.modal: Sandbox.mount_image is not supported.")

    def unmount_image(self, path: Any) -> None:
        raise NotImplementedError("arker.modal: Sandbox.unmount_image is not supported.")

    def create_connect_token(self, user_metadata: Any = None) -> Any:
        raise NotImplementedError(
            "arker.modal: Sandbox.create_connect_token is not supported — "
            "Arker has no HTTP-connect token concept."
        )

    def reload_volumes(self) -> None:
        raise NotImplementedError("arker.modal: Sandbox.reload_volumes is not supported — Arker has no Volume primitive.")

    def open(self, path: str, mode: str = "r") -> Any:
        # Modal deprecated this in favor of filesystem.{read,write}_*; we
        # never implemented it. Loud is better than silent.
        raise NotImplementedError(
            "arker.modal: Sandbox.open is not supported — modal deprecated it. "
            "Use sbx.filesystem.read_text / write_text instead."
        )

    def watch(self, *args, **kwargs):
        raise NotImplementedError(
            "arker.modal: Sandbox.watch is not supported — no fs-event API. "
            "Poll sbx.filesystem.list_files if needed."
        )

    def wait_until_ready(self, timeout: int = 300) -> None:
        # Arker VMs are ready when fork() returns. No-op.
        del timeout
        return None

    # ---- Streams (stub for parity) ----

    @property
    def stdout(self) -> Any:
        raise NotImplementedError(
            "arker.modal: Sandbox.stdout is not supported — modal's Sandbox "
            "streams correspond to the entrypoint command; Arker has none. "
            "Use the ContainerProcess returned by sbx.exec()."
        )

    @property
    def stderr(self) -> Any:
        raise NotImplementedError(
            "arker.modal: Sandbox.stderr is not supported. Use sbx.exec()."
        )

    @property
    def stdin(self) -> Any:
        raise NotImplementedError(
            "arker.modal: Sandbox.stdin is not supported. Use sbx.exec()."
        )

    # ---- Listing ----

    @classmethod
    def list(
        cls,
        app_id: str | None = None,
        tags: dict[str, str] | None = None,
        client: Any = None,
    ) -> list["Sandbox"]:
        """Modal's `list()` returns an `AsyncGenerator[Sandbox]`; ours returns
        a plain list since we're sync-first. Iterating works the same.

        `app_id` and `tags` are ignored — Arker has neither concept.
        """
        del app_id, tags
        arker = _build_arker(client)
        try:
            vms = arker.list().vms
        except ArkerError:
            return []
        return [cls(arker, arker.vm(vm.vm_id)) for vm in vms]

    def __enter__(self) -> "Sandbox":
        return self

    def __exit__(self, *_exc: Any) -> None:
        try:
            self.terminate()
        except Exception:
            pass

    # ---- For Process / Filesystem helpers ----

    @property
    def _bg_runs(self) -> dict:
        # Compatibility shim if any internal code (e.g. shared helpers) inspects this.
        return {}
