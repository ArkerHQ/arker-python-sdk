from __future__ import annotations

from typing import Any

from ._compat import (
    CommandResult,
    UnsupportedMixin,
    arker_create,
    arker_get,
    format_not_found,
    import_optional,
    run_command,
)
from .computer import VM


class ExecuteResponse:
    def __init__(self, result: CommandResult) -> None:
        self.exit_code = result.exit_code
        self.exitCode = result.exit_code
        self.result = result.stdout
        self.stdout = result.stdout
        self.stderr = result.stderr


class Process:
    def __init__(self, vm: VM) -> None:
        self._vm = vm

    def exec(self, command: str) -> ExecuteResponse:
        return ExecuteResponse(run_command(self._vm, command))

    def execute_command(self, command: str) -> ExecuteResponse:
        return self.exec(command)

    def executeCommand(self, command: str) -> ExecuteResponse:
        return self.exec(command)


class Sandbox(UnsupportedMixin):
    _compat_name = "daytona"

    def __init__(self, vm: VM | None = None, native: Any | None = None) -> None:
        self._vm = vm
        self._native = native
        self.id = vm.id if vm is not None else getattr(native, "id", getattr(native, "sandbox_id", None))
        if vm is not None:
            self.process = Process(vm)
        else:
            self.process = native.process

    def delete(self) -> None:
        if self._vm is not None:
            self._vm.delete()
            return
        if hasattr(self._native, "delete"):
            self._native.delete()
            return
        raise AttributeError("Native Daytona sandbox does not expose delete().")


class Daytona(UnsupportedMixin):
    _compat_name = "daytona"

    def __init__(self, *args: Any, **kwargs: Any) -> None:
        self._native_args = args
        self._native_kwargs = dict(kwargs)
        self._arker_config = self._native_kwargs.pop("arker", None)
        self._native = None

    def _native_client(self) -> Any | None:
        if self._native is not None:
            return self._native
        module = import_optional("daytona")
        if module is None or not hasattr(module, "Daytona"):
            return None
        self._native = module.Daytona(*self._native_args, **self._native_kwargs)
        return self._native

    def create(self, *args: Any, **kwargs: Any) -> Sandbox:
        if args or kwargs:
            raise TypeError("Daytona.create only supports create() in the Arker compatibility layer.")
        try:
            return Sandbox(vm=arker_create(self._arker_config))
        except Exception:
            native = self._native_client()
            if native is None:
                raise
            return Sandbox(native=native.create())

    def get(self, sandbox_id: str) -> Sandbox:
        vm = arker_get(sandbox_id, self._arker_config)
        if vm is not None:
            return Sandbox(vm=vm)

        native = self._native_client()
        if native is not None and hasattr(native, "get"):
            return Sandbox(native=native.get(sandbox_id))
        raise format_not_found("Sandbox", sandbox_id)

    def delete(self, sandbox: str | Sandbox) -> None:
        if not isinstance(sandbox, str):
            sandbox.delete()
            return

        vm = arker_get(sandbox, self._arker_config)
        if vm is not None:
            Sandbox(vm=vm).delete()
            return

        native = self._native_client()
        if native is not None and hasattr(native, "delete"):
            native.delete(sandbox)
            return
        if native is not None and hasattr(native, "get"):
            Sandbox(native=native.get(sandbox)).delete()
            return
        raise format_not_found("Sandbox", sandbox)
