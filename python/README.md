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
ar.vm(vm_id).resize(vcpu_count=..., memory_mib=...)
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
pty = vm.create_pty(
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

## License

Apache-2.0
