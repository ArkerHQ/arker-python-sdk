# Arker — TypeScript SDK

TypeScript client for the [Arker](https://arker.ai) virtual computer
platform. Spawn isolated Linux sandboxes, run shell / Python / Node
code in them, read and write files. Zero runtime dependencies (uses
the platform's built-in `fetch` and `crypto`).

## Install

```bash
npm install @arker-ai/sdk
```

Works in Node ≥ 18. ESM + CJS + types all included.

## Quickstart

```ts
import { Arker, ArkerError } from "@arker-ai/sdk";

const arker = new Arker({ apiKey: "ark_live_..." });
const vm    = await arker.vm("arkuntu").fork({ name: "hello" });

const result = await vm.run("python3 -c 'print(2+2)'");
console.log(new TextDecoder().decode(result.stdout));   // → "4\n"

await vm.sync.writeFile("/home/user/data.csv", "a,b\n1,2\n");
const data = await vm.sync.readFile("/home/user/data.csv");

const child = await vm.fork({ name: "branch" });        // constant-time copy-on-write
await child.delete();
await vm.delete();
```

List your VMs:

```ts
const page = await arker.list({ limit: 10, sort: "-created_at" });
console.log(`${page.total} total`);
for (const summary of page.items) {
  console.log(summary.vm_id, summary.name, summary.region, summary.created_at);
}
```

## API

```
new Arker({ apiKey, baseUrl? })
    .vm(vmId) -> Computer                         // open handle (no network call)
    .list({ limit?, offset?, q?, sort? }) -> Promise<VmList>

Computer
    .id, .delete()
    .fork({ name?, isPublic?, region? }) -> Promise<Computer>
    .run(command, { sessionId?, timeout? }) -> Promise<RunResult>
    .sync.readFile(path) -> Promise<Uint8Array>
    .sync.writeFile(path, data: Uint8Array | string) -> Promise<void>

RunResult: stdout, stderr (Uint8Array), exitCode, durationMs, sessionId, cwd
VmSummary: vm_id, name, base_image, region, created_at (ISO 8601)
VmList:    items (VmSummary[]), total (number)

ArkerError(code, message, status) extends Error    // single error type
```

### Routing

`fork`, `run`, `sync`, and `delete` use the regional endpoint set on the
client (default `https://aws-us-west-2.burst.arker.ai`).

`list` always goes through `https://arker.ai` regardless of `baseUrl`,
because list data is served from a global host rather than a regional
one.

Public base-image names like `"arkuntu"` resolve to a ULID **client-side**
(see `SOURCE_ALIASES` in `src/index.ts`), so `arker.vm("arkuntu").fork()`
works on the default endpoint with no extra round-trip. Override
`baseUrl` or set `ARKER_BASE_URL` to point at a different region or a
self-hosted deployment.

### Errors

Every server-side error becomes an `ArkerError`:

```ts
try {
  await vm.sync.readFile("/home/user/missing");
} catch (err) {
  if (err instanceof ArkerError) {
    console.log(err.code);      // "not_found"
    console.log(err.message);   // "not_found: file not found: ..."
    console.log(err.status);    // 404
  }
}
```

`code` is a stable enum: `bad_request`, `unauthorized`, `payment_required`,
`forbidden`, `not_found`, `conflict`, `payload_too_large`, `internal`,
`not_implemented`, `vm_busy`, `unsupported_*`, `command_not_found`.

### What the SDK does for you

Hidden behind these six methods:

- **Write strategy**: files up to 100 MB. Small payloads go in one call;
  larger ones use a direct upload path so the bytes don't traverse the
  API layer. `writeFile` resolves once the bytes are durably stored.
- **Read coalescing**: `readFile` always resolves to a `Uint8Array`,
  regardless of whether the server inlined the content or returned a
  signed URL.
- **Idempotent retry**: transient errors are retried with exponential
  backoff. Writes are server-side idempotent on `upload_id`, so retries
  never produce duplicates.
- **Path validation**: only `/home/user/...` paths accepted; `..` rejected.

## Demo / smoke test

Run the full surface against a live deployment:

```bash
ARKER_API_KEY=ark_live_... npx tsx tests/demo.ts
```

It exercises every method (`list`, `vm`, `fork`, `run`, `sync.writeFile`,
`sync.readFile`, error path, child fork, `delete`) and prints what each
call hits on the wire — useful as living documentation.

To fork from a specific source VM instead of the default `arkuntu`:

```bash
ARKER_API_KEY=ark_live_... ARKER_SOURCE_VM=01KQ... npx tsx tests/demo.ts
```

## License

Apache-2.0.
