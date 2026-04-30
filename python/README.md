# Arker — Python SDK

Single-file Python client for the [Arker](https://arker.ai) virtual computer
platform. Spawn isolated Linux sandboxes, run shell / Python / Node code in
them, read and write files. Zero runtime dependencies (stdlib `urllib`).

## Install

```bash
pip install arker
```

Or, while in alpha:

```bash
pip install git+https://github.com/ArkerHQ/arker-python-sdk@v0.1.0
```

## Quickstart

```python
from arker import Arker, ArkerError

arker  = Arker(api_key="ark_live_...")
vm     = arker.vm("arkuntu").fork(name="hello")     # fresh VM from base image
result = vm.run("python3 -c 'print(2+2)'")
print(result.stdout.decode())                        # → "4\n"

vm.sync.write_file("/home/user/data.csv", b"a,b\n1,2\n")
data = vm.sync.read_file("/home/user/data.csv")      # → b"a,b\n1,2\n"

child = vm.fork(name="branch")                       # constant-time copy-on-write
child.delete()
vm.delete()
```

List your VMs:

```python
page = arker.list(limit=10, sort="-created_at")
print(f"{page.total} total")
for summary in page:                                 # iterable; also page.items
    print(summary.vm_id, summary.name, summary.region, summary.created_at)
```

## API

```
Arker(api_key, base_url=None)
    .vm(vm_id) -> Computer                          # open handle (no network call)
    .list(*, limit=25, offset=0, q=None, sort=None) -> VmList

Computer
    .id, .delete()
    .fork(*, name=, is_public=, region=) -> Computer
    .run(command, *, session_id=, timeout=) -> RunResult
    .sync.read_file(path) -> bytes
    .sync.write_file(path, data: bytes | str)

RunResult: stdout, stderr (bytes), exit_code, duration_ms, session_id, cwd
VmSummary: vm_id, name, base_image, region, created_at (ISO 8601)
VmList: items (list[VmSummary]), total (int);  iterable, len()-able

ArkerError(code, message, status)                   # one exception type for everything
```

### Routing

`fork`, `run`, `sync`, and `delete` use the regional endpoint set on the
client (default `https://aws-us-west-2.burst.arker.ai`).

`list` always goes through `https://arker.ai` regardless of `base_url`,
because list data is served from a global host rather than a regional
one.

Public base-image names like `"arkuntu"` resolve to a ULID **client-side**
(see `SOURCE_ALIASES` in `computer.py`), so `arker.vm("arkuntu").fork()`
works on the default endpoint with no extra round-trip. Override
`base_url` or set `ARKER_BASE_URL` to point at a different region or a
self-hosted deployment.

### Errors

Every server-side error becomes an `ArkerError`:

```python
try:
    vm.sync.read_file("/home/user/missing")
except ArkerError as err:
    print(err.code)      # "not_found"
    print(err.message)   # "file not found: /home/user/missing"
    print(err.status)    # 404
```

`code` is a stable enum: `bad_request`, `unauthorized`, `payment_required`,
`forbidden`, `not_found`, `conflict`, `payload_too_large`, `internal`,
`not_implemented`, `vm_busy`, `unsupported_*`, `command_not_found`.

### What the SDK does for you

Hidden behind these six methods:

- **Write strategy**: small files go in one call; larger files use a
  direct upload bypass so the bytes don't traverse the API layer.
  `write_file` always returns once the bytes are durably stored.
- **Read coalescing**: `read_file` always returns raw `bytes`, regardless
  of whether the server inlined the content or returned a presigned URL.
- **Idempotent retry**: transient errors are retried with exponential
  backoff. Writes are server-side idempotent on `upload_id`, so retries
  never produce duplicate writes.
- **Path validation**: only `/home/user/...` paths accepted; `..` rejected.

## Demo / smoke test

Run the full surface against a live deployment:

```bash
ARKER_API_KEY=ark_live_... python tests/demo.py
```

It exercises every method (`list`, `vm`, `fork`, `run`, `sync.write_file`,
`sync.read_file`, error path, child fork, `delete`) and prints what each
call hits on the wire — useful as living documentation.

## License

Apache-2.0.
