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

## Interactive terminal (PTY)

Open a real pseudo-terminal in a VM and drive it interactively — stream raw
terminal bytes out, send keystrokes in (incl. control chars like Ctrl-C),
resize, and kill. `isatty()` is true inside, so an interactive shell, `vim`,
`htop`, a language REPL, and `claude` all work. Transport is a TLS WebSocket;
a key can only attach to its own org's VMs.

```ts
const vm = await ar.fork("ubuntu-full");

const pty = await vm.createPty({
  cols: 80,
  rows: 24,
  // command defaults to the login shell. It is a single executable path —
  // the guest does not shell-split, so launch a shell and `sendInput` it.
  onData: (bytes) => process.stdout.write(bytes), // raw output (ANSI/colors)
});

await pty.sendInput(new TextEncoder().encode("ls -la\n"));
await pty.resize({ cols: 120, rows: 40 });        // a full-screen app reflows
await pty.kill();                                  // tears down the shell
```

Wire it into `xterm.js` in a browser (`term.onData → pty.sendInput`,
`pty onData → term.write`, `term.onResize → pty.resize`), or pipe it to a local
TTY in a script. Node needs the optional `ws` package (installed by default).

The CLI exposes the same thing — `arker pty <vm>` (and `arker shell` on a TTY)
drop you into a live terminal you can run `claude` in:

```bash
arker pty <vm_id>                 # login shell in a fresh/!existing VM
arker pty --command /usr/bin/htop # launch a program directly
```

## Durability

For long-running or non-idempotent work, fork with `durable: true` and pass an idempotency key when retrying a run:

```ts
const vm = await ar.fork("ubuntu-full", { durable: true });
await vm.run("python3 train.py", { background: true, idempotencyKey: crypto.randomUUID() });
```

If the host fails mid-run, the run resumes on a healthy host with the VM's filesystem state preserved. Backends without durability return `ArkerError` code `unsupported_operation`.

## License

Apache-2.0
