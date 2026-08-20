# Arker TypeScript SDK

A small, typed wrapper around the Arker VM API: fork a machine, run commands, sync files.

## Install

```bash
bun add @arker-ai/sdk
```

Node 18+. The client reads your key from `ARKER_API_KEY` — get one in the [console](https://arker.ai/console).

## Quickstart

```ts
import { Arker } from "@arker-ai/sdk";

const ar = new Arker({ provider: "aws", region: "us-west-2" });

// Fork a source returned by the API, then run a command and read or write a file.
const vm = await ar.fork(process.env.ARKER_SOURCE_VM!);

const run = await vm.run("python3 -c 'print(2 + 2)'");
if (run.type === "completed") console.log(new TextDecoder().decode(run.stdout));

await vm.sync("/tmp/data.txt", "hello\n");   // write
const data = await vm.sync("/tmp/data.txt"); // read -> Uint8Array

await vm.delete();
```

## Interactive PTY

`arker shell` opens a native PTY session over WebSocket. It does not use SSH and
does not call `/runs` for each line:

```bash
arker shell vm_123
arker shell vm_123 --session-id sess_123
```

The SDK exposes the same transport:

```ts
const pty = await vm.connectPty({ cols: 120, rows: 32 });
pty.onData((chunk) => process.stdout.write(chunk));
await pty.ready;
pty.send("echo hello\n");
pty.resize(100, 30);
pty.close(); // detach; the session is not deleted
```

## Core API

```ts
import { Arker, discoverRegions } from "@arker-ai/sdk";

const catalog = await discoverRegions();     // public; no API key or placement required
const ar = new Arker({ provider: "aws", region, apiKey?, baseUrl?, retry? });

// VMs
await ar.fork(sourceVmName);                  // source ownership is resolved by the service
await ar.fork(vm, { name: "child" });         // an existing VM (uses its id)
await ar.fork({ sourceVmName, sourceOrgId, name?, durable? });
await ar.listVms({ state? });
await ar.listRegions();                       // available public placements
ar.vm(vmId, { provider, region });            // placement-aware bare handle
await ar.vm(vmId).run(command, options?);
await ar.vm(vmId).connectPty({ sessionId?, cols?, rows?, command?, persist? });
await ar.vm(vmId).update({ resources: { vcpu, memory_mib, disk_mib } });
await ar.vm(vmId).delete();

// Files inside a VM
await vm.sync(path);                          // read  -> Uint8Array
await vm.sync(path, data);                    // write

// Filesystems — standalone, persistent volumes
await ar.createFilesystem({ name });
await ar.listFilesystems();
await ar.deleteFilesystem(filesystemId);

// Syncs — mount a filesystem into a VM at a path
await vm.createSync({ filesystemId, path });
await vm.listSyncs();
await vm.deleteSync(syncId);
```

`apiKey` falls back to `ARKER_API_KEY`; `provider` to `ARKER_PROVIDER`; and `region` to `ARKER_REGION`. Set both `provider` and `region`, or pass `baseUrl`. The SDK accepts any provider and region that form valid DNS labels and resolves compute calls to `https://{provider}-{region}.arker.ai/api`. The region catalog is optional and contains only `provider` and `region`. The CLI equivalent is `arker regions`. Configure retries with `retry: { attempts, baseDelayMs, maxDelayMs }`, or `retry: false` to disable.

## Durability

For long-running or non-idempotent work, fork with `durable: true` and pass an idempotency key when retrying a run:

```ts
const vm = await ar.fork(process.env.ARKER_SOURCE_VM!, { durable: true });
await vm.run("python3 train.py", { time_to_background: 0, idempotencyKey: crypto.randomUUID() });
```

If the host fails mid-run, the run resumes on a healthy host with the VM's filesystem state preserved. Backends without durability return `ArkerError` code `unsupported_operation`.

## Compatibility imports

The SDK includes limited compatibility layers for common Daytona, E2B, and Modal sandbox workflows. These entrypoints keep the original SDK-shaped calls, route through ComputeSDK, use Arker as the first provider, and fall back to the original provider when resolving an existing non-Arker sandbox ID.

For the supported surface below, migration is a one-line import change:

| SDK | Replace | With |
| --- | --- | --- |
| Daytona | `import { Daytona } from "@daytonaio/sdk";` | `import { Daytona } from "@arker-ai/sdk/daytona";` |
| E2B | `import { Sandbox } from "e2b";` | `import { Sandbox } from "@arker-ai/sdk/e2b";` |
| Modal | `import { ModalClient } from "modal";` | `import { ModalClient } from "@arker-ai/sdk/modal";` |

### Daytona

```ts
import { Daytona } from "@arker-ai/sdk/daytona";

const daytona = new Daytona({ apiKey: process.env.DAYTONA_API_KEY });
const sandbox = await daytona.create();
const result = await sandbox.process.exec("echo hello");

console.log(result.result);
await daytona.delete(sandbox);
```

Supported Daytona surface:

- `new Daytona({ apiKey?, arker? })`
- `daytona.create()`
- `daytona.get(id)`
- `daytona.delete(idOrSandbox)`
- `sandbox.id`
- `sandbox.process.exec(command)`
- `sandbox.process.executeCommand(command)`
- `sandbox.delete()`

### E2B

```ts
import { Sandbox } from "@arker-ai/sdk/e2b";

const sandbox = await Sandbox.create();
const result = await sandbox.commands.run("echo hello");

console.log(result.stdout);
await sandbox.kill();
```

Supported E2B surface:

- `Sandbox.create()`
- `Sandbox.create(templateId, { timeoutMs? })`
- `Sandbox.connect(id)`
- `sandbox.sandboxId`
- `sandbox.commands.run(command)`
- `sandbox.files.read/write/makeDir/list/exists/remove`
- `sandbox.kill()`

### Modal

```ts
import { ModalClient } from "@arker-ai/sdk/modal";

const client = new ModalClient({
  tokenId: process.env.MODAL_TOKEN_ID,
  tokenSecret: process.env.MODAL_TOKEN_SECRET,
});
const sandbox = await client.sandboxes.create();
const proc = await sandbox.exec(["sh", "-c", "echo hello"]);

console.log(await proc.stdout.readText());
await sandbox.terminate();
```

Supported Modal surface:

- `new ModalClient({ tokenId?, tokenSecret?, arker? })`
- `client.sandboxes.create()`
- `client.sandboxes.fromId(id)`
- `sandbox.sandboxId`
- `sandbox.exec(commandOrArgv, { workdir?, env?, timeoutMs?, stdout?: "pipe", stderr?: "pipe", mode?: "text" })`
- `process.stdout.readText()`
- `process.stderr.readText()`
- `process.wait()`
- `sandbox.terminate()`

Unsupported provider-specific methods and options throw explicit errors instead of being silently ignored. Arker credentials come from `ARKER_API_KEY` and optional `ARKER_REGION` / `ARKER_BASE_URL`; original provider credentials are only used for fallback.

Compatibility test commands:

```bash
bun run test:compat
ARKER_API_KEY=... bun run test:compat-live
ARKER_API_KEY=... DAYTONA_API_KEY=... E2B_API_KEY=... MODAL_TOKEN_ID=... MODAL_TOKEN_SECRET=... bun run test:compat-fallback-live
```

## License

Apache-2.0
