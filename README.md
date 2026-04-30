# Arker SDKs

Official client libraries for the [Arker](https://arker.ai) virtual
computer platform. Spawn isolated Linux sandboxes, run shell / Python /
Node code in them, sync files in and out.

| Language   | Package                                            | Path                       | Status |
|------------|----------------------------------------------------|----------------------------|--------|
| Python     | [`arker`](https://pypi.org/project/arker/)         | [`python/`](./python)      | alpha  |
| TypeScript | (coming soon)                                      | —                          | —      |

## Quickstart (Python)

```bash
pip install arker
```

```python
from arker import Arker

arker = Arker(api_key="ark_live_...")
vm    = arker.vm("arkuntu").fork(name="hello")     # fresh VM from base image
result = vm.run("python3 -c 'print(2+2)'")
print(result.stdout.decode())                       # → "4\n"
vm.delete()
```

See [`python/README.md`](./python/README.md) for the full Python API.

## Repo layout

```
arker-sdks/
├── python/                 — Python SDK (published as `arker` on PyPI)
│   ├── src/arker/
│   ├── tests/demo.py       — live end-to-end demo, doubles as docs
│   ├── pyproject.toml
│   └── README.md
└── .github/workflows/
    └── publish-python.yml  — tag `python-vX.Y.Z` to publish to PyPI
```

## Releasing

Each SDK uses tag-prefixed releases so they version independently:

- Python: tag `python-v0.1.0` → workflow builds and publishes to PyPI
  via Trusted Publishing (no token needed).

## License

Apache-2.0. See [LICENSE](./LICENSE).
