# Arker TypeScript SDK

Small TypeScript wrapper for the Arker VM API. The SDK keeps API keys,
base URLs, retries, output decoding, and file sync ergonomics in one place.
It does not hardcode VM names, resolve golden aliases, or choose endpoints.

## Install

```bash
npm install @arker-ai/sdk
```

Node 18 or newer is required.

## Quickstart

```ts
import { Arker } from "@arker-ai/sdk";

const arker = new Arker({
  apiKey: process.env.ARKER_API_KEY,
  baseUrl: process.env.ARKER_BASE_URL,
});

const vm = await arker.vm("ubuntu").fork({ name: "hello" });
const result = await vm.run("printf 'hello\\n'");

if (result.type === "completed") {
  console.log(new TextDecoder().decode(result.stdout));
}

await vm.sync.writeFile("/home/user/data.txt", "hello\n");
const data = await vm.sync.readFile("/home/user/data.txt");

await vm.delete();
```

`baseUrl` is the endpoint this client talks to. If an endpoint mounts the API
under `/api`, include that prefix:

```bash
export ARKER_BASE_URL=https://aws-us-west-2.arker.ai
```

## API

```ts
new Arker({ apiKey?, baseUrl?, retry? })
  .vm(vmId)
  .goldens()
  .list()
  .get(vmId)

Computer
  .fork(request)
  .run(command, options)
  .runStatus(runId)
  .cancelRun(runId)
  .delete()
  .sync.readFile(path)
  .sync.writeFile(path, data)
```

`apiKey` falls back to `ARKER_API_KEY` or `AUTH_KEY`.
`baseUrl` falls back to `ARKER_BASE_URL`; there is no built-in default endpoint.

Retries are configured on the client:

```ts
const arker = new Arker({
  apiKey: "ark_live_...",
  baseUrl: "https://aws-us-west-2.arker.ai",
  retry: { attempts: 4, baseDelayMs: 200, maxDelayMs: 2000 },
});
```

Pass `retry: false` to disable SDK retries.

## API Contract

The SDK request and response types are generated from
`../contract/openapi.json`. The client itself is handwritten.

After updating the vendored contract:

```bash
npm run generate:api-types
npm run check:api-types
```

## Routing

Golden availability is owned by the backend behind `baseUrl`. For example,
if `ubuntu` is not available on a burst endpoint, `arker.vm("ubuntu").fork()`
will fail with the backend error. The SDK does not special-case that.

## Smoke Test

The conformance smoke test uses raw HTTP and checks the fork/run/sync wire
shape without going through the SDK:

```bash
ARKER_API_KEY=ark_live_... \
ARKER_BASE_URL=https://aws-us-west-2.arker.ai \
ARKER_SOURCE_VM=ubuntu \
npm run smoke
```

To compare two backends:

```bash
ARKER_API_KEY=ark_live_... \
ARKER_SMOKE_TARGETS='[
  {"name":"burst","baseUrl":"https://aws-burst-us-west-2.arker.ai/api","source":"01KQH2ADR3DCAJF06N4R453WPJ_uswe"},
  {"name":"ubuntu","baseUrl":"https://aws-us-west-2.arker.ai","source":"ubuntu"}
]' \
npm run smoke
```

## Demo

```bash
ARKER_API_KEY=ark_live_... \
ARKER_BASE_URL=https://aws-us-west-2.arker.ai \
ARKER_SOURCE_VM=ubuntu \
npm run demo
```

## License

Apache-2.0
