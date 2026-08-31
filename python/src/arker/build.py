"""Drive a parsed Dockerfile against a VM.

``FROM`` is not executed here — the caller forks from it, through the ordinary
server-side ``fork(image=…)`` path, which owns the registry pull, the OCI→ext4
conversion and the template cache. Everything after it is walked by
:func:`apply_steps` against the resulting VM.

## Shell state

``ENV``, ``WORKDIR`` and ``ARG``-with-a-default are applied by running real
``export``/``cd`` commands rather than by prefixing every later command. A VM
session keeps its exported environment and working directory between runs, so
one ``export`` sticks for every subsequent ``RUN`` — and, importantly, for the
customer's own ``run()`` calls on the VM they get back. Prefixing would have
made the state vanish the moment the build ended.

``USER`` is different: there is no per-session "become this user", so each
subsequent ``RUN`` is wrapped in ``su -p``. That means USER affects the build
but does NOT carry onto the delivered VM's later runs — documented here rather
than silently differing from Docker.

## COPY

Sources resolve against the build context root and are transferred with the
VM's own file APIs: a directory through ``sync_dir`` (manifest-diffed, so a
rebuild ships only what changed), a single file through ``sync``. No shell is
involved in the transfer, so there is nothing to quote or escape — the paths
never reach a command line.

``COPY`` deliberately runs unwrapped, outside any ``USER`` shell: Docker writes
copied files as root unless ``--chown`` says otherwise, and the transfer APIs
write as the guest agent rather than as a session user. ``--chown`` is applied
afterwards as an explicit ``chown -R``.
"""

from __future__ import annotations

import glob as _glob
import os
import hashlib
import shlex
import urllib.request
from typing import Protocol

from .dockerignore import load_dockerignore
from .build_spec import (
    Add,
    Arg,
    Cmd,
    Copy,
    Entrypoint,
    Env,
    Expose,
    Label,
    Run,
    Step,
    User,
    Workdir,
)

__all__ = ["BuildError", "apply_steps"]


class BuildError(ValueError):
    """A Dockerfile that parsed but cannot be built, with the reason named."""


class _VM(Protocol):
    """The slice of ``VM`` this module uses."""

    def run(self, command: str, **kwargs): ...
    def sync(self, path: str, data: bytes | str | None = None): ...
    def sync_dir(self, local_dir: str, remote_dir: str, **kwargs): ...


def _env_value(value: str) -> str:
    """Quote an `ENV`/`ARG` value for `export`.

    A value containing `$` is DOUBLE-quoted so the guest shell expands it.
    `ENV PATH=/opt/bin:$PATH` is one of the most common lines in any
    Dockerfile, and single-quoting it sets the literal string `$PATH` — which
    then breaks every later `RUN` and every `run()` the customer makes, with a
    "command not found" three steps away from the cause.

    The trade-off is deliberate: double quotes make the value an expansion
    context, so `$(...)` would also run. That is guest-side, where `RUN`
    already grants arbitrary execution, so it costs nothing that was not
    already spent. Backslash, backtick and `"` are escaped so the value cannot
    break out of the quoting itself.
    """
    if "$" not in value:
        return shlex.quote(value)
    escaped = value.replace("\\", "\\\\").replace('"', '\\"').replace("`", "\\`")
    return f'"{escaped}"'


def _resolve_sources(source: str, context_root: str) -> list[str]:
    """Resolve one COPY source against the context, expanding globs.

    Globs are expanded HERE, by Python, against the local filesystem — never by
    a shell. That removes the whole class of quoting and metacharacter problems
    a shell-side expansion would carry, and it means an unmatched glob is a
    clear error rather than a literal path that fails later.
    """
    root = os.path.realpath(context_root)
    pattern = os.path.join(root, source)
    matches = sorted(_glob.glob(pattern)) if _glob.has_magic(pattern) else [pattern]

    if not matches:
        raise BuildError(
            f"COPY {source}: no such file or directory in the build context"
        )

    resolved = []
    for match in matches:
        real = os.path.realpath(match)
        # The context root is the boundary, exactly as `docker build` treats
        # it. `..` in the source, or a symlink pointing out of the tree, both
        # land here — realpath is what makes the symlink case caught too.
        if real != root and not real.startswith(root + os.sep):
            raise BuildError(
                f"COPY {source} names a path outside the build context; everything "
                f"COPY reads must live under {context_root}"
            )
        if not os.path.exists(real):
            raise BuildError(
                f"COPY {source}: no such file or directory in the build context"
            )
        resolved.append(real)
    return resolved


def _copy_destination(dest: str, source_path: str, multiple: bool) -> str:
    """Where one resolved source lands in the guest.

    Docker's rule: a destination ending in `/`, or one receiving several
    sources, is a directory and each source keeps its basename. Otherwise the
    destination names the file itself.
    """
    if dest.endswith("/") or multiple:
        return dest.rstrip("/") + "/" + os.path.basename(source_path)
    return dest


def _verify_checksum(step: Add, payload: bytes) -> None:
    if not step.checksum:
        return
    algorithm, _, expected = step.checksum.partition(":")
    if not expected:
        raise BuildError(
            f"ADD {step.url}: --checksum must be <algorithm>:<hex>, got {step.checksum!r}"
        )
    try:
        digest = hashlib.new(algorithm, payload).hexdigest()
    except ValueError as error:
        raise BuildError(f"ADD {step.url}: unknown checksum algorithm {algorithm!r}") from error
    if digest != expected.lower():
        raise BuildError(
            f"ADD {step.url}: checksum mismatch, expected {algorithm}:{expected.lower()} "
            f"but the downloaded bytes are {algorithm}:{digest}"
        )


def _apply_copy(vm: _VM, step: Copy, context_root: str) -> None:
    resolved: list[str] = []
    for source in step.sources:
        resolved.extend(_resolve_sources(source, context_root))

    # realpath BOTH sides: where the context sits under a symlink (macOS /tmp
    # -> /private/tmp) an unresolved root yields `../../private/tmp/...`, which
    # matches no pattern and silently disables every rule.
    root = os.path.realpath(context_root)
    ignore = load_dockerignore(root)

    def rel(path: str) -> str:
        return os.path.relpath(os.path.realpath(path), root).replace(os.sep, "/")

    # A named source that is itself ignored is dropped, the same as Docker
    # dropping it from the context before COPY ever looks.
    resolved = [p for p in resolved if not ignore.ignores(rel(p))]

    multiple = len(resolved) > 1
    for path in resolved:
        if os.path.isdir(path):
            # A directory source copies its CONTENTS into the destination,
            # which is what sync_dir does — `COPY src /app/src` puts src's
            # files at /app/src, not at /app/src/src.
            target = step.dest.rstrip("/")
            # Patterns are context-relative but sync_dir reports paths
            # relative to the synced directory: `COPY src /app` hands us
            # `index.js`, which must be tested as `src/index.js`.
            prefix = "" if rel(path) == "." else rel(path) + "/"
            vm.sync_dir(path, target, ignore=lambda r, p=prefix: ignore.ignores(p + r))
        else:
            target = _copy_destination(step.dest, path, multiple)
            with open(path, "rb") as handle:
                vm.sync(target, handle.read())
            if os.stat(path).st_mode & 0o111:
                _run_checked(
                    vm,
                    f"chmod +x {shlex.quote(target)}",
                    f"COPY {os.path.basename(path)}",
                )

    if step.chown:
        _run_checked(
            vm,
            f"chown -R {shlex.quote(step.chown)} {shlex.quote(step.dest)}",
            f"COPY --chown={step.chown}",
        )


def _run_checked(vm: _VM, command: str, what: str) -> None:
    """Run `command` and abort the build unless it succeeded.

    Docker fails a build on a non-zero `RUN`, and the reason is not tidiness: a
    build that continues past a failure applies every later instruction on top
    of it and hands back a VM that looks built and is not. `RUN npm install`
    failing must not produce a "successful" image with no node_modules.

    `exit_code is None` is also a failure. It means a prompt ended the command
    rather than its completion marker — an interpreter left running by an
    earlier step swallowed it — so the command never ran at all. Folding that
    to success would be the same lie in a quieter form.
    """
    result = vm.run(command)
    code = getattr(result, "exit_code", 0)
    if code == 0:
        return
    detail = ""
    for stream in ("stderr", "stdout"):
        text = (getattr(result, stream, "") or "").strip()
        if text:
            detail = f": {text[:400]}"
            break
    if code is None:
        raise BuildError(
            f"{what} never reached the shell (an interpreter started by an earlier "
            f"instruction is holding the session){detail}"
        )
    raise BuildError(f"{what} failed with exit code {code}{detail}")


def _run_checked(vm: _VM, command: str, what: str) -> None:
    """Run `command` and abort the build unless it succeeded.

    Docker fails a build on a non-zero `RUN`, and the reason is not tidiness: a
    build that continues past a failure applies every later instruction on top
    of it and hands back a VM that looks built and is not. `RUN npm install`
    failing must not produce a "successful" image with no node_modules.

    `exit_code is None` is also a failure. It means a prompt ended the command
    rather than its completion marker — an interpreter left running by an
    earlier step swallowed it — so the command never ran at all. Folding that
    to success would be the same lie in a quieter form.
    """
    result = vm.run(command)
    code = getattr(result, "exit_code", 0)
    if code == 0:
        return
    detail = ""
    for stream in ("stderr", "stdout"):
        text = (getattr(result, stream, "") or "").strip()
        if text:
            detail = f": {text[:400]}"
            break
    if code is None:
        raise BuildError(
            f"{what} never reached the shell (an interpreter started by an earlier "
            f"instruction is holding the session){detail}"
        )
    raise BuildError(f"{what} failed with exit code {code}{detail}")


def apply_steps(vm: _VM, steps: list[Step], context_root: str) -> None:
    """Execute every step after ``FROM`` against ``vm``, in file order."""
    current_user: str | None = None

    for step in steps:
        if isinstance(step, Run):
            command = step.command
        elif isinstance(step, Env):
            command = "export " + " ".join(
                f"{key}={_env_value(value)}" for key, value in step.pairs
            )
        elif isinstance(step, Arg):
            if step.default is None:
                # No --build-arg channel exists, so an ARG with no default can
                # only ever be unset — same as Docker leaves it.
                continue
            command = f"export {step.name}={_env_value(step.default)}"
        elif isinstance(step, Workdir):
            quoted = shlex.quote(step.path)
            # Docker creates a WORKDIR that doesn't exist; a bare `cd` would
            # fail on the first build of a fresh image.
            command = f"mkdir -p {quoted} && cd {quoted}"
        elif isinstance(step, User):
            current_user = step.name
            continue
        elif isinstance(step, Add):
            # Fetched here, then written like a COPY: the guest needs no
            # network tooling and no shell for this at all.
            try:
                with urllib.request.urlopen(step.url, timeout=30) as response:
                    payload = response.read()
            except Exception as error:  # noqa: BLE001 - any fetch failure is a build failure
                raise BuildError(f"ADD {step.url}: {error}") from error
            _verify_checksum(step, payload)
            vm.sync(step.dest, payload)
            continue
        elif isinstance(step, Copy):
            # Unwrapped by design — see the module docstring.
            _apply_copy(vm, step, context_root)
            continue
        elif isinstance(step, (Label, Expose, Entrypoint, Cmd)):
            # Recorded by the parser, no effect on a VM: nothing invokes a VM
            # the way `docker run` invokes an entrypoint, and there is no
            # `docker inspect` surface for LABEL/EXPOSE to configure.
            continue
        else:  # pragma: no cover - every step type is handled above
            raise BuildError(f"unhandled instruction: {step!r}")

        # Only a RUN (or an ADD's fetch) needs to become the USER. Wrapping
        # `export`/`cd` would run them in a `su -c` subshell that exits
        # immediately, throwing the state away — so `ENV` after `USER` silently
        # did nothing at all. Docker treats ENV/WORKDIR as metadata that USER
        # does not affect, and this matches that.
        if current_user is not None and isinstance(step, (Run, Add)):
            command = f"su -p {shlex.quote(current_user)} -c {shlex.quote(command)}"
        _run_checked(vm, command, f"{step.__class__.__name__.upper()} step")
