# Arker TypeScript SDK

Small TypeScript wrapper for the Arker VM API. The SDK keeps API keys,
region routing, retries, output decoding, and file sync ergonomics in one place.

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
  region: process.env.ARKER_REGION ?? "aws-us-west-2",
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

`region` selects the regional Arker endpoints. The SDK routes `arkuntu` and
burst VM ids to the burst endpoint for that region; other golden names and VM
ids use the normal regional endpoint. There is no cross-region VM replication.

```bash
export ARKER_REGION=aws-us-west-2
```

For internal or dev targets, pass `baseUrl` directly. If an endpoint mounts the
API under `/api`, include that prefix.

## API

```ts
new Arker({ apiKey?, region?, baseUrl?, burstBaseUrl?, retry? })
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
`region` falls back to `ARKER_REGION`; `baseUrl` falls back to
`ARKER_BASE_URL`. There is no built-in default region.

Retries are configured on the client:

```ts
const arker = new Arker({
  apiKey: "ark_live_...",
  region: "aws-us-west-2",
  retry: { attempts: 4, baseDelayMs: 200, maxDelayMs: 2000 },
});
```

Pass `retry: false` to disable SDK retries.

## Durability

For long-running or non-idempotent work, request a durable VM at fork
time and pass an idempotency key when retrying `run`:

```ts
const vm = await arker.vm("ubuntu").fork({ name: "job", durable: true });

const run = await vm.run("python3 train.py", {
  background: true,
  idempotencyKey: "550e8400-e29b-41d4-a716-446655440000",
});
```

- If the underlying host fails mid-run, the run resumes on a healthy
  host with the VM's filesystem state preserved.
- A `run` retried with the same `idempotencyKey` and the same request
  returns the original `run_id`. A different request under the same key
  returns `ArkerError` code `conflict`.
- `runStatus().retry_count` is the number of automatic retries the run
  has gone through — `0` for runs that completed without interruption.

Forked children default to non-durable. Backends without durability
support return `ArkerError` code `unsupported_operation` when
`durable: true` is requested.

## API Contract

The SDK request and response types are generated from
`../contract/openapi.json`. The client itself is handwritten.

After updating the vendored contract:

```bash
npm run generate:api-types
npm run check:api-types
```

## Routing

With `region: "aws-us-west-2"`, the SDK uses
`https://aws-us-west-2.arker.ai` for normal VMs and
`https://aws-burst-us-west-2.arker.ai/api` for `arkuntu` and burst VM ids.
The returned `Computer` stays pinned to the endpoint that created it.

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
ARKER_REGION=aws-us-west-2 \
ARKER_SOURCE_VM=ubuntu \
npm run demo
```

## License

Apache-2.0
