# Arker TypeScript SDK

A small, typed wrapper around the Arker VM API: fork a machine, run commands, sync files.

## Install

```bash
npm install @arker-ai/sdk
```

Node 18+. The client reads your key from `ARKER_API_KEY` — get one in the [console](https://arker.ai/console).

## Quickstart

```ts
import { Arker } from "@arker-ai/sdk";

const ar = new Arker({ region: "us-west-2" });

// Fork a public golden, run a command, read/write a file.
const vm = await ar.fork("ubuntu-full"); // public golden — org inferred

const run = await vm.run("python3 -c 'print(2 + 2)'");
if (run.type === "completed") console.log(new TextDecoder().decode(run.stdout));

await vm.sync("/tmp/data.txt", "hello\n");   // write
const data = await vm.sync("/tmp/data.txt"); // read -> Uint8Array

await vm.delete();
```

## Core API

```ts
const ar = new Arker({ region, apiKey?, baseUrl?, retry? });

// VMs
await ar.fork("ubuntu-full");                 // public golden by name (org inferred)
await ar.fork(vm, { name: "child" });         // an existing VM (uses its id)
await ar.fork({ sourceVmName, sourceOrgId, name?, durable? });
await ar.listVms({ state? });
ar.vm(vmId);                                  // bare handle
await ar.vm(vmId).run(command, options?);
await ar.vm(vmId).resize({ vcpu_count, memory_mib });
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

`apiKey` falls back to `ARKER_API_KEY`; `region` to `ARKER_REGION`. Pass `baseUrl` for dev targets. Configure retries with `retry: { attempts, baseDelayMs, maxDelayMs }`, or `retry: false` to disable.

## Durability

For long-running or non-idempotent work, fork with `durable: true` and pass an idempotency key when retrying a run:

```ts
const vm = await ar.fork("ubuntu-full", { durable: true });
await vm.run("python3 train.py", { background: true, idempotencyKey: crypto.randomUUID() });
```

If the host fails mid-run, the run resumes on a healthy host with the VM's filesystem state preserved. Backends without durability return `ArkerError` code `unsupported_operation`.

## License

Apache-2.0
