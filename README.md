<div align="center">

<img src="./assets/banner.png" alt="Arker" width="480" />


</div>

###

<div align="center">

[Docs](https://arker.ai/docs) / [Benchmarks](https://arker.ai/benchmarks) / [Console](https://arker.ai/console)


</div>

### Authentication

Get your API key at [arker.ai/console](https://arker.ai/console).

### Packages

[![PyPI](https://img.shields.io/pypi/v/arker.svg?style=flat-square&label=pypi)](https://pypi.org/project/arker/)
[![npm](https://img.shields.io/npm/v/@arker-ai/sdk.svg?style=flat-square&label=npm)](https://www.npmjs.com/package/@arker-ai/sdk)

### License

[![License](https://img.shields.io/badge/license-Apache%202.0-blue.svg?style=flat-square)](./LICENSE)

### Python Client

```bash
pip install arker
```

```python
import os

from arker import Arker

ar = Arker(provider="aws", region="us-west-2")  # key from ARKER_API_KEY
vm = ar.fork(os.environ["ARKER_SOURCE_VM"])
print(vm.run("python3 -c 'print(2 + 2)'").stdout.decode())
```

### TypeScript Client

```bash
bun add @arker-ai/sdk
```

```ts
import { Arker } from "@arker-ai/sdk";

const ar = new Arker({ provider: "aws", region: "us-west-2" }); // key from ARKER_API_KEY
const vm = await ar.fork(process.env.ARKER_SOURCE_VM!);
const run = await vm.run("node -e 'console.log(2 + 2)'");
if (run.type === "completed") console.log(new TextDecoder().decode(run.stdout));
```

### GCP

You can read the public placement catalog before you configure a client. Discovery does not require an API key:

```python
from arker import discover_regions

catalog = discover_regions()
```

```ts
import { discoverRegions } from "@arker-ai/sdk";

const catalog = await discoverRegions();
```

VM listings accept exact raw-platform and creation-time filters in both SDKs:

```python
ar.list_vms(platform="graviton2", created_after="2026-08-20T00:00:00Z")
```

```ts
await ar.listVms({ platform: "graviton2", created_after: "2026-08-20T00:00:00Z" });
```

```bash
arker regions
```

Then select GCP with both the provider and region:

```python
ar = Arker(provider="gcp", region="us-central1")
```

```ts
const ar = new Arker({ provider: "gcp", region: "us-central1" });
```

```bash
arker fork "$ARKER_SOURCE_VM" --provider gcp --region us-central1
```

### CLI

```bash
bun add --global @arker-ai/sdk
```

```bash
export ARKER_API_KEY=ark_live_...
export ARKER_PROVIDER=aws
export ARKER_REGION=us-west-2
: "${ARKER_SOURCE_VM:?set ARKER_SOURCE_VM to a source name returned by the API}"
VM=$(arker fork "$ARKER_SOURCE_VM" | jq -r .vm_id)
arker run "$VM" "python3 -c 'print(2 + 2)'"
arker rm "$VM"
```

### Examples

Runnable quick-starts in [`examples/`](./examples):

- [`browser/`](./examples/browser) — open two Wikipedia pages and fork a live checkpoint at each
- [`coding-agent/`](./examples/coding-agent) — background coding agents (Claude Code, Codex, Cursor)
- [`firmware/`](./examples/firmware) — a coding agent edits firmware and runs it on QEMU
- [`policies/`](./examples/policies) — host-enforced egress policy as code

### Get Started

Read the [docs](https://arker.ai/docs) and browse the [examples](./examples).
