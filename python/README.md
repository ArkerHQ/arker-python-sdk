# Arker Python SDK

Small Python wrapper for the Arker VM API. The SDK keeps API keys,
region routing, retries, output decoding, and file sync ergonomics in one place.

## Install

```bash
pip install arker
```

Python 3.10 or newer is required. The package has no runtime dependencies.

## Quickstart

```python
from arker import Arker, CompletedRunResult

arker = Arker(
    api_key="ark_live_...",
    region="aws-us-west-2",
)

vm = arker.vm("ubuntu").fork(name="hello")
result = vm.run("printf 'hello\\n'")

if isinstance(result, CompletedRunResult):
    print(result.stdout.decode())

vm.sync.write_file("/home/user/data.txt", "hello\n")
data = vm.sync.read_file("/home/user/data.txt")

vm.delete()
```

`region` selects the regional Arker endpoints. The SDK routes `arkuntu` and
burst VM ids to the burst endpoint for that region; other golden names and VM
ids use the normal regional endpoint. There is no cross-region VM replication.

```bash
export ARKER_REGION=aws-us-west-2
```

For internal or dev targets, pass `base_url` directly. If an endpoint mounts
the API under `/api`, include that prefix.

## API

```python
Arker(api_key=None, region=None, base_url=None, burst_base_url=None, retry=None)
    .vm(vm_id)
    .goldens()
    .list()
    .get(vm_id)

Computer
    .fork(...)
    .run(command, ...)
    .run_status(run_id)
    .cancel_run(run_id)
    .delete()
    .sync.read_file(path)
    .sync.write_file(path, data)
```

`api_key` falls back to `ARKER_API_KEY` or `AUTH_KEY`.
`region` falls back to `ARKER_REGION`; `base_url` falls back to
`ARKER_BASE_URL`. There is no built-in default region.

Retries are configured on the client:

```python
from arker import Arker, RetryOptions

arker = Arker(
    api_key="ark_live_...",
    region="aws-us-west-2",
    retry=RetryOptions(attempts=4, base_delay_s=0.2, max_delay_s=2.0),
)
```

Pass `retry=False` to disable SDK retries.

## Durability

For long-running or non-idempotent work, request a durable VM at fork
time and pass an idempotency key when retrying `run`:

```python
vm = arker.vm("ubuntu").fork(name="job", durable=True)

run = vm.run(
    "python3 train.py",
    background=True,
    idempotency_key="550e8400-e29b-41d4-a716-446655440000",
)
```

- If the underlying host fails mid-run, the run resumes on a healthy
  host with the VM's filesystem state preserved.
- A `run()` retried with the same `idempotency_key` and the same
  request returns the original `run_id`. A different request under
  the same key raises `ArkerError(code="conflict")`.
- `run_status().retry_count` is the number of automatic retries the run
  has gone through — `0` for runs that completed without interruption.

Forked children default to non-durable. Backends without durability
support raise `ArkerError(code="unsupported_operation")` when
`durable=True` is requested.

## Routing

With `region="aws-us-west-2"`, the SDK uses
`https://aws-us-west-2.arker.ai` for normal VMs and
`https://aws-burst-us-west-2.arker.ai/api` for `arkuntu` and burst VM ids.
The returned `Computer` stays pinned to the endpoint that created it.

## Migrating from e2b

`arker.e2b` is a drop-in for the `e2b` Python package. Most existing code only
needs an import change:

```python
# before
from e2b import Sandbox

# after
from arker.e2b import Sandbox

sbx = Sandbox()                         # forks $ARKER_E2B_DEFAULT_TEMPLATE (or "ubuntu")
sbx = Sandbox(template="ubuntu")        # forks a specific golden
sbx = Sandbox(sandbox_id="vm_…")        # attaches to an existing Arker VM

result = sbx.commands.run("echo hi", cwd="/tmp", envs={"K": "V"})
sbx.files.write("/tmp/x", "data")
sbx.kill()
```

Also shimmed: `from arker.e2b import AsyncSandbox` (async wrapper) and
`from arker.e2b.code_interpreter import Sandbox` for `run_code(code, language="python")`.

**What's faithfully supported**

- `Sandbox(...)` / `Sandbox.connect(sandbox_id)` / `.sandbox_id` / `.kill()` / `.is_running()`
- `commands.run` (foreground + background) → `CommandResult` / `CommandHandle`
- `commands.list / kill / connect`; `CommandHandle.wait / kill / __iter__`
- `files.read` (text/bytes/stream) and `files.write` (native Arker sync API)
- `files.list / exists / remove / rename / make_dir` (shell-shimmed via `find` / `test` / `rm` / `mv` / `mkdir`)
- `code_interpreter.Sandbox.run_code` for python/js/ts/bash/ruby

**What's a silent no-op (debug-logs, drop-in safe)**

- `set_timeout`, `commands.send_stdin`, `files.watch_dir`
- `pty.send_stdin` / `pty.resize` / `pty.kill` (server-side PTY is provisioned; live I/O needs WS — planned follow-up)
- e2b-desktop methods (mouse / keyboard / screenshot)

**What changes shape**

- `CommandResult.stdout` is a `str` (UTF-8 decoded), matching e2b.
- Live `on_stdout` / `on_stderr` callbacks fire once per polled chunk; true line-level streaming awaits WS support.

## Demo

```bash
ARKER_API_KEY=ark_live_... \
ARKER_REGION=aws-us-west-2 \
ARKER_SOURCE_VM=ubuntu \
python tests/demo.py
```

## License

Apache-2.0
