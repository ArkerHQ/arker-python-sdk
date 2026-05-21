<div align="center">

<img src="./assets/banner.png" alt="Arker" width="480" />

<br/>

[![PyPI](https://img.shields.io/pypi/v/arker.svg?style=flat-square&label=pypi)](https://pypi.org/project/arker/)
[![npm](https://img.shields.io/npm/v/@arker-ai/sdk.svg?style=flat-square&label=npm)](https://www.npmjs.com/package/@arker-ai/sdk)
[![License](https://img.shields.io/badge/license-Apache%202.0-blue.svg?style=flat-square)](./LICENSE)

[Docs](https://arker.ai/docs) · [Benchmarks](https://arker.ai/benchmarks) · [Console](https://arker.ai/console)

</div>


### Authentication

Get your API key at [arker.ai/console](https://arker.ai/console).

### Python

```bash
pip install arker
```

```python
from arker import Arker

arker = Arker(api_key="ark_live_...")
vm = arker.vm("ubuntu").fork(name="hello")
result = vm.run("python3 -c 'print(2+2)'")
print(result.stdout.decode())
```

### TypeScript

```bash
npm install @arker-ai/sdk
```

```ts
import { Arker } from "@arker-ai/sdk";

const arker = new Arker({ apiKey: "ark_live_..." });
const vm = await arker.vm("ubuntu").fork({ name: "hello" });
const result = await vm.run("node -e 'console.log(2+2)'");
console.log(new TextDecoder().decode(result.stdout));
```
