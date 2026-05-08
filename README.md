<div align="center">

# Arker SDKs

**Spawn isolated Linux VMs in milliseconds. Run code. Sync files.**

Three primitives. Zero infrastructure.

[![PyPI](https://img.shields.io/pypi/v/arker.svg?style=flat-square&label=pypi)](https://pypi.org/project/arker/)
[![npm](https://img.shields.io/npm/v/@arker-ai/sdk.svg?style=flat-square&label=npm)](https://www.npmjs.com/package/@arker-ai/sdk)
[![License](https://img.shields.io/badge/license-Apache%202.0-blue.svg?style=flat-square)](./LICENSE)

[Quickstart](#quickstart) · [Primitives](#the-three-primitives) · [Python](./python) · [TypeScript](./typescript) · [arker.ai](https://arker.ai)

</div>

---

## Quickstart

### Python

```bash
pip install arker
```

```python
from arker import Arker

arker = Arker(
    api_key="ark_live_...",
    region="aws-us-west-2",
)
vm = arker.vm("ubuntu").fork(name="hello")
result = vm.run("python3 -c 'print(2+2)'")
if result.type == "completed":
    print(result.stdout.decode())   # -> "4\n"
vm.delete()
```

### TypeScript

```bash
npm install @arker-ai/sdk
```

```ts
import { Arker } from "@arker-ai/sdk";

const arker = new Arker({
  apiKey: "ark_live_...",
  region: "aws-us-west-2",
});
const vm = await arker.vm("ubuntu").fork({ name: "hello" });
const result = await vm.run("node -e 'console.log(2+2)'");
if (result.type === "completed") {
  console.log(new TextDecoder().decode(result.stdout));  // -> "4\n"
}
await vm.delete();
```

---

## The three primitives

> Examples below use Python. See [`typescript/README.md`](./typescript/README.md) for the TypeScript surface.

### `fork` &nbsp;·&nbsp; instant VMs

```python
vm    = arker.vm("ubuntu").fork()        # fresh VM from a base image
child = vm.fork(name="branch")           # branch an existing VM
```

Constant-time. The child is bit-identical to its parent at the moment
of fork — same files, same last-known process state, same everything —
and from that moment on, writes to either side don't affect the other.
Fork to spin up a clean environment, branch a known-good state to try
a risky operation, or run *N* variants in parallel from a single
configured VM.

### `run` &nbsp;·&nbsp; execute anything

```python
result = vm.run("python3 -c 'print(2+2)'")
print(result.stdout.decode())            # → "4\n"
print(result.exit_code)
```

Shell, Python, Node — anything installed inside the VM. State persists
across calls in a session, so a `cd /tmp` sticks for the next `ls`,
and Python globals defined in one `vm.run(...)` are still there in the
next. Completed runs return structured output with `stdout`, `stderr`,
and `exit_code` — no parsing required.

### `sync` &nbsp;·&nbsp; file I/O up to 100 MB

```python
vm.sync.write_file("/home/user/data.bin", b"...")
back = vm.sync.read_file("/home/user/data.bin")    # → bytes
```

Read and write raw bytes — files up to 100 MB. Small payloads go in
one round-trip; larger ones take a direct upload path the SDK manages
transparently. Files written from the SDK are immediately visible to
shell commands inside the VM, and files the VM writes are readable
from the SDK — same filesystem, same view, both directions.

---

## Languages

| Language   | Package                                                | Source                        | Status |
|------------|--------------------------------------------------------|-------------------------------|--------|
| Python     | [`arker`](https://pypi.org/project/arker/)             | [`python/`](./python)         | alpha  |
| TypeScript | [`@arker-ai/sdk`](https://www.npmjs.com/package/@arker-ai/sdk) | [`typescript/`](./typescript) | alpha  |

Each SDK lives in its own subdirectory with a dedicated README and tests.
See [`python/README.md`](./python/README.md) for the full Python API
reference.

## Releasing

Each SDK is versioned independently via tag-prefixed releases:

- **Python** — push `python-vX.Y.Z` (must match `python/pyproject.toml`).
  GitHub Actions builds and publishes to PyPI via Trusted Publishing.
- **TypeScript** — push `typescript-vX.Y.Z` (must match
  `typescript/package.json`). GitHub Actions builds (ESM + CJS + types)
  and publishes to npm via Trusted Publishing with provenance.

## License

Apache-2.0. See [LICENSE](./LICENSE).
