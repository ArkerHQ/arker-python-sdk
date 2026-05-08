# Arker Python SDK

Small Python wrapper for the Arker VM API. The SDK keeps API keys,
base URLs, retries, output decoding, and file sync ergonomics in one place.
It does not hardcode VM names, resolve golden aliases, or choose endpoints.

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
    base_url="https://aws-us-west-2.arker.ai",
)

vm = arker.vm("ubuntu").fork(name="hello")
result = vm.run("printf 'hello\\n'")

if isinstance(result, CompletedRunResult):
    print(result.stdout.decode())

vm.sync.write_file("/home/user/data.txt", "hello\n")
data = vm.sync.read_file("/home/user/data.txt")

vm.delete()
```

`base_url` is the endpoint this client talks to. If an endpoint mounts the API
under `/api`, include that prefix:

```bash
export ARKER_BASE_URL=https://aws-us-west-2.arker.ai
```

## API

```python
Arker(api_key=None, base_url=None, retry=None)
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
`base_url` falls back to `ARKER_BASE_URL`; there is no built-in default endpoint.

Retries are configured on the client:

```python
from arker import Arker, RetryOptions

arker = Arker(
    api_key="ark_live_...",
    base_url="https://aws-us-west-2.arker.ai",
    retry=RetryOptions(attempts=4, base_delay_s=0.2, max_delay_s=2.0),
)
```

Pass `retry=False` to disable SDK retries.

## Routing

Golden availability is owned by the backend behind `base_url`. For example,
if `ubuntu` is not available on a burst endpoint, `arker.vm("ubuntu").fork()`
will fail with the backend error. The SDK does not special-case that.

## Demo

```bash
ARKER_API_KEY=ark_live_... \
ARKER_BASE_URL=https://aws-us-west-2.arker.ai \
ARKER_SOURCE_VM=ubuntu \
python tests/demo.py
```

## License

Apache-2.0
