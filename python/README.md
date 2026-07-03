# Arker Python SDK

A small wrapper around the Arker VM API: fork a machine, run commands, sync files.

## Install

```bash
pip install arker
```

Python 3.10+, no runtime dependencies. The client reads your key from `ARKER_API_KEY` — get one in the [console](https://arker.ai/console).

## Quickstart

```python
from arker import Arker

ar = Arker(region="us-west-2")

# Fork a public golden, run a command, read/write a file.
vm = ar.fork("ubuntu-full")  # public golden — org inferred

print(vm.run("python3 -c 'print(2 + 2)'").stdout.decode())

vm.sync("/tmp/data.txt", "hello\n")   # write
data = vm.sync("/tmp/data.txt")       # read -> bytes

vm.delete()
```

## Core API

```python
ar = Arker(region=..., api_key=None, base_url=None, retry=None)

# VMs
ar.fork("ubuntu-full")                        # public golden by name (org inferred)
ar.fork(vm, name="child")                     # an existing VM (uses its id)
ar.fork(source_vm_name=..., source_org_id=..., name=None, durable=False)
ar.list_vms(state=None)
ar.vm(vm_id)                                  # bare handle
ar.vm(vm_id).run(command, **options)
ar.vm(vm_id).update(vcpu_count=..., memory_mib=...)   # PATCH resources / network
ar.vm(vm_id).update_policies({"policies": [...]})     # PUT outbound policy doc
ar.vm(vm_id).delete()

# Files inside a VM
vm.sync(path)                                 # read  -> bytes
vm.sync(path, data)                           # write

# Filesystems — standalone, persistent volumes
ar.create_filesystem(name=...)
ar.list_filesystems()
ar.delete_filesystem(filesystem_id)

# Syncs — mount a filesystem into a VM at a path
vm.create_sync(filesystem_id=..., path=...)
vm.list_syncs()
vm.delete_sync(sync_id)
```

`api_key` falls back to `ARKER_API_KEY`; `region` to `ARKER_REGION`. Pass `base_url` for dev targets. Configure retries with `RetryOptions(...)`, or `retry=False` to disable.

## Interactive terminal (PTY)

Open a real pseudo-terminal in a VM and drive it interactively — stream raw
terminal bytes out, send keystrokes in (incl. control chars like Ctrl-C),
resize, and kill. `isatty()` is true inside, so an interactive shell, `vim`,
`htop`, a REPL, and `claude` all work. Transport is a TLS WebSocket; a key can
only attach to its own org's VMs.

Install the optional WebSocket dependency: `pip install 'arker[pty]'`.

```python
import sys

vm = ar.fork("ubuntu-full")

# on_data is called from a background reader thread with raw output bytes.
pty = vm.connect_pty(
    cols=80,
    rows=24,
    on_data=lambda b: sys.stdout.buffer.write(b) or sys.stdout.flush(),
    # command defaults to the login shell; it is a single executable path
    # (no shell-splitting) — launch a shell and send_input() it.
)

pty.send_input(b"ls -la\n")
pty.resize(cols=120, rows=40)   # a full-screen app reflows
pty.wait()                       # block until the shell exits, or:
pty.kill()                       # tear it down
```

`b"\x03"` (Ctrl-C) interrupts the running program, exactly like a local
terminal. To embed in a browser terminal, forward the same bytes to/from
`xterm.js`.

## Durability

For long-running or non-idempotent work, fork with `durable=True` and pass an idempotency key when retrying a run:

```python
import uuid

vm = ar.fork("ubuntu-full", durable=True)
vm.run("python3 train.py", background=True, idempotency_key=str(uuid.uuid4()))
```

If the host fails mid-run, the run resumes on a healthy host with the VM's filesystem state preserved. Backends without durability raise `ArkerError(code="unsupported_operation")`.

## Compatibility imports

The Python package includes limited compatibility modules for common Daytona, E2B, and Modal sandbox workflows. For the supported surface below, migration is a one-line import change:

| SDK | Replace | With |
| --- | --- | --- |
| Daytona | `from daytona import Daytona` | `from arker.daytona import Daytona` |
| E2B | `from e2b import Sandbox` | `from arker.e2b import Sandbox` |
| Modal | provider-specific imports | `from arker.modal import Sandbox` |

### Daytona

```python
from arker.daytona import Daytona

daytona = Daytona()
sandbox = daytona.create()
try:
    response = sandbox.process.exec("echo 'Hello, World!'")
    print(response.result)
finally:
    sandbox.delete()
```

Supported Daytona surface:

- `Daytona()`
- `daytona.create()`
- `daytona.get(id)`
- `daytona.delete(id_or_sandbox)`
- `sandbox.id`
- `sandbox.process.exec(command)`
- `sandbox.process.execute_command(command)`
- `sandbox.delete()`

### E2B

```python
from arker.e2b import Sandbox

sandbox = Sandbox.create()
try:
    result = sandbox.commands.run('echo "Hello from E2B Sandbox!"')
    print(result.stdout)
finally:
    sandbox.kill()
```

Supported E2B surface:

- `Sandbox.create()`
- `Sandbox.create(template_id)`
- `Sandbox.connect(id)`
- `sandbox.sandbox_id` / `sandbox.sandboxId`
- `sandbox.commands.run(command)`
- `sandbox.files.read/write/make_dir/makeDir/list/exists/remove`
- `sandbox.kill()`

### Modal

```python
from arker.modal import Sandbox

sandbox = Sandbox.create()
try:
    process = sandbox.exec("echo", "hello")
    print(process.stdout.read())
finally:
    sandbox.terminate()
```

Supported Modal surface:

- `Sandbox.create()`
- `Sandbox.from_id(id)` / `Sandbox.fromId(id)`
- `sandbox.sandbox_id` / `sandbox.sandboxId`
- `sandbox.exec(*command)`
- `process.stdout.read()`
- `process.stderr.read()`
- `process.wait()`
- `sandbox.terminate()`

Unsupported provider-specific methods and options throw explicit errors instead of being silently ignored. Arker credentials come from `ARKER_API_KEY` and optional `ARKER_REGION` / `ARKER_BASE_URL`.

## License

Apache-2.0
