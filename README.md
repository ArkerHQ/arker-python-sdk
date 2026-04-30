# Arker SDKs

Official client libraries for [Arker](https://arker.ai) — spawn isolated
Linux VMs, run code in them, sync files in and out. Three primitives.

```bash
pip install arker
```

```python
from arker import Arker

arker = Arker(api_key="ark_live_...")
vm    = arker.vm("arkuntu").fork(name="hello")
```

## fork — instant VMs

```python
vm    = arker.vm("arkuntu").fork()       # fresh VM from a base image
child = vm.fork(name="branch")           # branch an existing VM
```

Constant-time. The child is bit-identical to its parent at the moment
of fork — same files, same processes' last state, same everything —
and from that moment on, writes to either side don't affect the other.
Fork to spin up a clean environment, branch off a known-good state to
try a risky operation, or run N variants in parallel from one
configured VM.

## run — execute anything

```python
result = vm.run("python3 -c 'print(2+2)'")
print(result.stdout.decode())            # → "4\n"
print(result.exit_code, result.duration_ms)
```

Run shell, Python, or Node — anything installed inside the VM. State
persists across calls in a session, so a `cd /tmp` sticks for the next
`ls`, and Python globals defined in one `vm.run(...)` are still there
in the next. Every call returns a structured `RunResult` with
`stdout`, `stderr`, `exit_code`, `duration_ms`, and `cwd` — no parsing
required.

## sync — file I/O without size limits

```python
vm.sync.write_file("/home/user/data.bin", b"...")
back = vm.sync.read_file("/home/user/data.bin")    # → bytes
```

Read and write raw bytes. No encoding to think about, no chunking, no
practical size cap — small payloads go in one round-trip, larger ones
take a direct upload path the SDK manages for you. Files written from
the SDK are immediately visible to shell commands inside the VM, and
files the VM writes are readable from the SDK — same filesystem, same
view, both directions.

---

## Languages

| Language   | Package                                    | Path                  | Status |
|------------|--------------------------------------------|-----------------------|--------|
| Python     | [`arker`](https://pypi.org/project/arker/) | [`python/`](./python) | alpha  |
| TypeScript | (coming soon)                              | —                     | —      |

Each language SDK lives in its own subdirectory, with its own README
and tests. See [`python/README.md`](./python/README.md) for the full
Python API.

## Releasing

Each SDK uses tag-prefixed releases so they version independently:

- **Python** — push tag `python-vX.Y.Z` (must match `python/pyproject.toml`).
  GitHub Actions builds a wheel and publishes to PyPI via Trusted
  Publishing — no token to manage.

## License

Apache-2.0. See [LICENSE](./LICENSE).
