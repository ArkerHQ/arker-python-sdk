from __future__ import annotations

import dataclasses
import importlib
import os
import shlex
from typing import Any

from .computer import Arker, ArkerError, CompletedRunResult, VM

ARKER_CLIENT_KEYS = {"api_key", "base_url", "control_base_url", "region", "provider", "retry"}


@dataclasses.dataclass(frozen=True)
class CommandResult:
    stdout: str
    stderr: str
    exit_code: int

    @property
    def exitCode(self) -> int:
        return self.exit_code


class UnsupportedMixin:
    _compat_name = "provider"

    def __getattr__(self, name: str) -> Any:
        raise AttributeError(
            f"'{name}' is not supported by the Arker compatibility layer for {self._compat_name}. "
            f"The compatibility layer covers create/connect/get, command execution, and core filesystem operations. "
            f"Use the native {self._compat_name} SDK directly for the full API."
        )


def arker_client(config: dict[str, Any] | None = None) -> Arker:
    cfg = {key: value for key, value in (config or {}).items() if key in ARKER_CLIENT_KEYS}
    return Arker(**cfg)


def arker_source(config: dict[str, Any] | None = None) -> str:
    cfg = config or {}
    source = cfg.get("source") or os.environ.get("ARKER_SOURCE") or os.environ.get("ARKER_SOURCE_VM")
    if not source:
        raise ValueError("Arker source is required; set source, ARKER_SOURCE, or ARKER_SOURCE_VM")
    return str(source)


def arker_create(config: dict[str, Any] | None = None, *, name: str | None = None, template_id: str | None = None) -> VM:
    cfg = config or {}
    source = template_id or arker_source(config)
    return arker_client(config).fork(source, name=name or cfg.get("name"))


def arker_get(vm_id: str, config: dict[str, Any] | None = None) -> VM | None:
    try:
        return arker_client(config).get_vm(vm_id)
    except ArkerError as error:
        if error.status == 404:
            return None
        raise


def decode(data: bytes, encoding: str = "utf-8") -> str:
    return data.decode(encoding, "replace")


def run_command(vm: VM, command: str, *, timeout: int | None = None) -> CommandResult:
    result = vm.run(command, timeout=timeout)
    if not isinstance(result, CompletedRunResult):
        raise RuntimeError(f"Arker run did not complete synchronously (type={result.type}).")
    return CommandResult(
        stdout=result.stdout,
        stderr=result.stderr,
        # CommandResult.exit_code is `int` in the shape we emulate, so "no
        # status" cannot be expressed and a prompt-ended run reports 0. That
        # ambiguity is confined to this compat surface; CompletedRunResult
        # keeps the None.
        exit_code=result.exit_code if result.exit_code is not None else 0,
    )


def shell_command(parts: tuple[Any, ...]) -> str:
    if len(parts) == 1:
        value = parts[0]
        if isinstance(value, (list, tuple)):
            return " ".join(shlex.quote(str(part)) for part in value)
        return str(value)
    return " ".join(shlex.quote(str(part)) for part in parts)


def import_optional(module_name: str) -> Any | None:
    try:
        return importlib.import_module(module_name)
    except ModuleNotFoundError as error:
        if error.name != module_name:
            raise
        return None


def format_not_found(kind: str, sandbox_id: str) -> RuntimeError:
    return RuntimeError(f"{kind} {sandbox_id} not found")
