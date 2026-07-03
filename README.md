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
from arker import Arker

ar = Arker(region="us-west-2")  # key from ARKER_API_KEY
vm = ar.fork("ubuntu-full")     # public golden — org inferred
print(vm.run("python3 -c 'print(2 + 2)'").stdout.decode())
```

### TypeScript Client

```bash
npm install @arker-ai/sdk
```

```ts
import { Arker } from "@arker-ai/sdk";

const ar = new Arker({ region: "us-west-2" }); // key from ARKER_API_KEY
const vm = await ar.fork("ubuntu-full");        // public golden — org inferred
const run = await vm.run("node -e 'console.log(2 + 2)'");
if (run.type === "completed") console.log(new TextDecoder().decode(run.stdout));
```

### CLI

```bash
npm install -g @arker-ai/sdk
```

```bash
export ARKER_API_KEY=ark_live_...
VM=$(arker fork ubuntu-full | jq -r .vm_id)   # public golden — org inferred
arker run "$VM" "python3 -c 'print(2 + 2)'"
arker rm "$VM"
```

### Examples

Runnable quick-starts in [`examples/`](./examples):

- [`browser/`](./examples/browser) — fork a running Chromium and reopen the checkpoint live over VNC
- [`android/`](./examples/android) — a real Android device (redroid): install and drive an app
- [`ios/`](./examples/ios) — an iPhone simulator inside a macOS VM
- [`coding-agent/`](./examples/coding-agent) — background coding agents (Claude Code, Codex, Cursor, …)
- [`policies/`](./examples/policies) — host-enforced egress policy as code

### Get Started

Read the [docs](https://arker.ai/docs) and browse the [examples](./examples).
