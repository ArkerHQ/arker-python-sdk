#!/usr/bin/env node
/**
 * Arker CLI — a small wrapper over `@arker-ai/sdk`.
 *
 * Conventions
 * -----------
 * Every resource follows the same shape:
 *     arker <resource> <ls|rm|get|create|...> [args]
 *
 * Top-level shortcuts collapse the most-common operations:
 *     arker ls                 → arker vms ls
 *     arker rm <vm>            → arker vms rm <vm>
 *     arker fork <source>      → arker vms fork --image|--vm-id <source>
 *     arker run  <vm> <cmd>    → arker vms run <vm> <cmd>
 *     arker sync <vm> ...      → arker syncs create/read/write on <vm>
 *     arker shell [vm]         → native PTY shell over WebSocket
 *
 * Resources: vms, runs, sessions, syncs, filesystems (alias `fs`).
 * Each supports `ls`, `get`, `rm`, and the resource-specific verbs.
 *
 * Auth: reads `ARKER_API_KEY` from the environment (or `~/.arker/config`).
 * Region: `ARKER_REGION` or the `--region` flag.
 */

import { readFileSync, existsSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { homedir } from "node:os";
import { join } from "node:path";
import { stdin as input, stdout as output } from "node:process";
import { Arker, ArkerError, ARKER_ORG_ID } from "./index.js";
import type {
  PtyConnection,
  VM,
  ResourceKind,
  RunResult,
  Vm,
} from "./index.js";

// Version string for `--version` and the help header. Read from the
// published package.json (dist/cli.js → ../package.json) so it never
// drifts from the release. Falls back to "unknown" if unreadable.
const VERSION: string = (() => {
  try {
    return (createRequire(import.meta.url)("../package.json") as { version: string })
      .version;
  } catch {
    return "unknown";
  }
})();

// ── Argv parsing ───────────────────────────────────────────────────

interface ParsedArgs {
  positional: string[];
  flags: Record<string, string | boolean>;
}

function parseArgs(argv: string[]): ParsedArgs {
  const positional: string[] = [];
  const flags: Record<string, string | boolean> = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg.startsWith("--")) {
      const eq = arg.indexOf("=");
      if (eq !== -1) {
        flags[arg.slice(2, eq)] = arg.slice(eq + 1);
      } else {
        const next = argv[i + 1];
        if (next !== undefined && !next.startsWith("--")) {
          flags[arg.slice(2)] = next;
          i++;
        } else {
          flags[arg.slice(2)] = true;
        }
      }
    } else if (arg.startsWith("-") && arg.length > 1) {
      flags[arg.slice(1)] = true;
    } else {
      positional.push(arg);
    }
  }
  return { positional, flags };
}

// ── Config + client ────────────────────────────────────────────────

interface CliConfig {
  apiKey?: string;
  baseUrl?: string;
  region?: string;
  provider?: "aws" | "aws-burst";
  controlBaseUrl?: string;
}

function readFileConfig(): CliConfig {
  for (const name of ["config.json", "config"]) {
    const path = join(homedir(), ".arker", name);
    if (!existsSync(path)) continue;
    try {
      return JSON.parse(readFileSync(path, "utf8")) as CliConfig;
    } catch {
      return {};
    }
  }
  return {};
}

// Region the CLI falls back to when none is given via flag, env, or config.
const DEFAULT_REGION = "us-west-2";

function clientFromArgs(args: ParsedArgs): Arker {
  const file = readFileConfig();
  const explicitBaseUrl =
    (args.flags["base-url"] as string | undefined) ??
    process.env.ARKER_BASE_URL;
  const explicitRegion =
    (args.flags.region as string | undefined) ??
    process.env.ARKER_REGION;
  const apiKey =
    (args.flags["api-key"] as string | undefined) ??
    process.env.ARKER_API_KEY ??
    file.apiKey;
  const baseUrl = explicitBaseUrl ?? (explicitRegion ? undefined : file.baseUrl);
  const controlBaseUrl =
    (args.flags["control-base-url"] as string | undefined) ??
    process.env.ARKER_CONTROL_BASE_URL;
  // Region: explicit flag/env, then the saved config, then a default of
  // us-west-2 so the CLI works out of the box. If a base URL is already
  // resolved (explicit or from config) it drives the endpoint and region
  // can stay unset.
  const region =
    explicitRegion ?? file.region ?? (baseUrl ? undefined : DEFAULT_REGION);
  const provider = (args.flags.provider as "aws" | "aws-burst" | undefined) ??
    (process.env.ARKER_PROVIDER as "aws" | "aws-burst" | undefined);
  if (!apiKey) {
    die("Missing API key. Set ARKER_API_KEY or pass --api-key.");
  }
  return new Arker({ apiKey, baseUrl, region, provider, controlBaseUrl });
}

// ── Output ─────────────────────────────────────────────────────────

function out(value: unknown): void {
  if (typeof value === "string") {
    output.write(value + "\n");
  } else {
    output.write(JSON.stringify(value, null, 2) + "\n");
  }
}

function err(msg: string): void {
  process.stderr.write(`arker: ${msg}\n`);
}

function die(msg: string): never {
  err(msg);
  process.exit(1);
}

function fmtVm(vm: VM | Vm): string {
  const provider = vm.provider ?? "?";
  const region = vm.region ?? "?";
  const name = vm.name ?? "—";
  const state = vm.state ?? "?";
  const id = vm.vm_id ?? (vm as VM).id;
  return `${id}\t${provider}-${region}\t${state}\t${name}`;
}

// ── Resources ──────────────────────────────────────────────────────

async function cmdVms(args: ParsedArgs, client: Arker): Promise<void> {
  const sub = args.positional[0];
  const rest = args.positional.slice(1);
  switch (sub) {
    case undefined:
    case "ls":
    case "list": {
      const res = await client.listVms({
        provider: args.flags.provider as "aws" | "aws-burst" | undefined,
        region: args.flags.region as string | undefined,
        state: args.flags.state as "idle" | "running" | undefined,
        cursor: args.flags.cursor as string | undefined,
        limit: numFlag(args, "limit"),
      });
      if (args.flags.json) return out({ vms: res.vms, next_cursor: res.nextCursor });
      for (const vm of res.vms) out(fmtVm(vm));
      if (res.nextCursor) out(`# next_cursor=${res.nextCursor}`);
      return;
    }
    case "get": {
      const id = rest[0] ?? die("usage: arker vms get <vm_id>");
      out(await client.getVm(id));
      return;
    }
    case "rm":
    case "delete": {
      const id = rest[0] ?? die("usage: arker vms rm <vm_id>");
      const r = await client.vm(id).delete();
      if (r.deleted) out(`deleted ${id}`); else { err("delete failed"); process.exitCode = 1; }
      return;
    }
    case "fork": {
      await cmdFork({ ...args, positional: rest }, client);
      return;
    }
    case "run": {
      await cmdRun({ ...args, positional: rest }, client);
      return;
    }
    case "update": {
      await cmdUpdate({ ...args, positional: rest }, client);
      return;
    }
    default:
      die(`unknown vms subcommand: ${sub}`);
  }
}

async function cmdFork(args: ParsedArgs, client: Arker): Promise<void> {
  // Source resolution is strict: exactly one of source-vm-id or
  // source-vm-name. A positional arg without flags is treated as a
  // source-vm-name in the Arker org (shortcut: `arker fork arkuntu`).
  const refPositional = args.positional[0];
  const srcVmIdFlag = args.flags["source-vm-id"] as string | undefined;
  const srcVmNameFlag = args.flags["source-vm-name"] as string | undefined;
  const srcOrgIdFlag = args.flags["source-org-id"] as string | undefined;
  const name = args.flags.name as string | undefined;
  const publicFlag = boolFlag(args, "public");

  let sourceVmId: string | undefined = srcVmIdFlag;
  let sourceVmName: string | undefined = srcVmNameFlag;
  let sourceOrgId: string | undefined = srcOrgIdFlag;

  if (!sourceVmId && !sourceVmName && refPositional) {
    // Shortcut: `arker fork ubuntu-full` → source-vm-name. Org defaulting
    // (known golden → Arker org, otherwise your own org) is handled by the
    // SDK's fork(); pass --source-org-id to override.
    sourceVmName = refPositional;
  }

  if (!sourceVmId && !sourceVmName) {
    die("usage: arker fork <vm_name> | --source-vm-id <id> | --source-vm-name <name> [--source-org-id <org>]\n" +
        "       [--vcpu N] [--memory-mib N] [--disk-mib N] [--no-disk]");
  }

  // Resource overrides — same flag names as `arker update` for consistency.
  // Folded into the contract's single `resources` object; unset fields stay
  // null so the source VM's defaults apply.
  const vcpu = numFlag(args, "vcpu");
  const memoryMib = numFlag(args, "memory-mib");
  const diskMib = numFlag(args, "disk-mib");
  const hasResources = vcpu !== undefined || memoryMib !== undefined || diskMib !== undefined;
  const resources = hasResources
    ? { vcpu: vcpu ?? null, memory_mib: memoryMib ?? null, disk_mib: diskMib ?? null }
    : undefined;

  // --no-disk forks a nodisk (memory-backed) VM; default leaves disk to the
  // SDK (which defaults disk=true). (Inbound reachability is intentionally not
  // exposed on the CLI yet — see the descoped SSH/reachability work.)
  const disk = boolFlag(args, "no-disk") ? false : undefined;

  const computer = await client.fork({
    sourceVmId,
    sourceVmName,
    sourceOrgId,
    name,
    public: publicFlag,
    ...(resources ? { resources } : {}),
    ...(disk !== undefined ? { disk } : {}),
  });
  out({ vm_id: computer.id });
}

async function cmdRun(args: ParsedArgs, client: Arker): Promise<void> {
  const vmId = args.positional[0] ?? die("usage: arker run <vm_id> <command...>");
  const command = args.positional.slice(1).join(" ");
  if (!command) die("missing command to run");
  const sessionIdx = numFlag(args, "session-idx");
  const result: RunResult = await client.vm(vmId).run(command, {
    background: boolFlag(args, "background"),
    timeout: numFlag(args, "timeout"),
    time_to_background: numFlag(args, "time-to-background"),
    acquire: args.flags.acquire as string | undefined,
    release: args.flags.release as string | undefined,
    session_id: args.flags["session-id"] as string | undefined,
    ...(sessionIdx !== undefined ? { session_idx: sessionIdx } : {}),
  });
  if (args.flags.json) {
    out(runResultForJson(result));
    if (result.type === "completed") process.exitCode = result.exitCode === 0 ? 0 : result.exitCode;
    return;
  }
  if (result.type === "completed") {
    if (result.memoryPartial) {
      err(`Memory target partially applied: requested ${formatMib(result.memoryRequestedMib)}, achieved ${formatMib(result.memoryAchievedMib)}.`);
    }
    process.stdout.write(new TextDecoder().decode(result.stdout));
    if (result.stderr.length) process.stderr.write(new TextDecoder().decode(result.stderr));
    process.exitCode = result.exitCode === 0 ? 0 : result.exitCode;
    return;
  }
  out({ run_id: result.runId, state: result.state });
}

function formatMib(value: number | null | undefined): string {
  return typeof value === "number" ? `${value} MiB` : "unknown";
}

function runResultForJson(result: RunResult): unknown {
  switch (result.type) {
    case "completed":
      return {
        type: result.type,
        runId: result.runId,
        state: result.state,
        stdout: new TextDecoder().decode(result.stdout),
        stdoutEncoding: result.stdoutEncoding,
        stderr: new TextDecoder().decode(result.stderr),
        stderrEncoding: result.stderrEncoding,
        exitCode: result.exitCode,
        failReason: result.failReason,
        memoryRequestedMib: result.memoryRequestedMib,
        memoryAchievedMib: result.memoryAchievedMib,
        memoryPartial: result.memoryPartial,
      };
    case "background":
      return result;
  }
}

async function cmdRuns(args: ParsedArgs, client: Arker): Promise<void> {
  const sub = args.positional[0];
  const rest = args.positional.slice(1);
  switch (sub) {
    case "ls":
    case "list": {
      const vm = rest[0] ?? die("usage: arker runs ls <vm_id>");
      const res = await client.vm(vm).listRuns({
        state: args.flags.state as "running" | "completed" | "cancelled" | undefined,
        cursor: args.flags.cursor as string | undefined,
        limit: numFlag(args, "limit"),
      });
      if (args.flags.json) return out(res);
      for (const r of res.runs) {
        out(`${r.run_id}\t${r.state}\t${r.exit_code ?? "-"}\t${r.command ?? ""}`);
      }
      if (res.next_cursor) out(`# next_cursor=${res.next_cursor}`);
      return;
    }
    case "get": {
      const [vm, runId] = rest;
      if (!vm || !runId) die("usage: arker runs get <vm_id> <run_id>");
      out(await client.vm(vm).getRun(runId));
      return;
    }
    case "rm":
    case "cancel": {
      const [vm, runId] = rest;
      if (!vm || !runId) die("usage: arker runs rm <vm_id> <run_id>");
      const r = await client.vm(vm).cancelRun(runId);
      out(r.cancelled ? `cancelled ${runId}` : "cancel failed");
      return;
    }
    default:
      die(`usage: arker runs <ls|get|rm> ...`);
  }
}

async function cmdSessions(args: ParsedArgs, client: Arker): Promise<void> {
  const sub = args.positional[0];
  const rest = args.positional.slice(1);
  const vm = rest[0];
  switch (sub) {
    case "ls":
    case "list": {
      if (!vm) die("usage: arker sessions ls <vm_id>");
      const res = await client.vm(vm).listSessions({
        state: args.flags.state as "idle" | "running" | undefined,
        cursor: args.flags.cursor as string | undefined,
        limit: numFlag(args, "limit"),
      });
      if (args.flags.json) return out(res);
      for (const s of res.sessions) {
        out(`${s.session_id}\t${s.state}\t${s.cwd}`);
      }
      if (res.next_cursor) out(`# next_cursor=${res.next_cursor}`);
      return;
    }
    case "get": {
      if (!vm) die("usage: arker sessions get <vm_id> <session_id>");
      const sid = rest[1] ?? die("missing session_id");
      out(await client.vm(vm).getSession(sid));
      return;
    }
    case "create": {
      if (!vm) die("usage: arker sessions create <vm_id>");
      out(await client.vm(vm).createSession({ cwd: args.flags.cwd as string | undefined }));
      return;
    }
    case "rm":
    case "delete": {
      if (!vm) die("usage: arker sessions rm <vm_id> <session_id>");
      const sid = rest[1] ?? die("missing session_id");
      const r = await client.vm(vm).deleteSession(sid);
      out(r.deleted ? `deleted ${sid}` : "delete failed");
      return;
    }
    default:
      die(`usage: arker sessions <ls|get|create|rm> ...`);
  }
}

async function cmdSyncs(args: ParsedArgs, client: Arker): Promise<void> {
  const sub = args.positional[0];
  const rest = args.positional.slice(1);
  const vm = rest[0];
  switch (sub) {
    case "ls":
    case "list": {
      if (!vm) die("usage: arker syncs ls <vm_id>");
      const res = await client.vm(vm).listSyncs({
        cursor: args.flags.cursor as string | undefined,
        limit: numFlag(args, "limit"),
        filesystemId: args.flags["filesystem-id"] as string | undefined,
      });
      if (args.flags.json) return out(res);
      for (const s of res.syncs) {
        out(`${s.sync_id}\t${s.filesystem_id}\t${s.path}`);
      }
      if (res.next_cursor) out(`# next_cursor=${res.next_cursor}`);
      return;
    }
    case "create": {
      if (!vm) die("usage: arker syncs create <vm_id> --filesystem-id <fs> [--path /mnt]");
      const filesystemId = args.flags["filesystem-id"] as string | undefined;
      if (!filesystemId) die("missing --filesystem-id");
      out(await client.vm(vm).createSync({
        filesystemId,
        path: args.flags.path as string | undefined,
      }));
      return;
    }
    case "rm":
    case "delete": {
      if (!vm) die("usage: arker syncs rm <vm_id> <sync_id>");
      const sid = rest[1] ?? die("missing sync_id");
      const r = await client.vm(vm).deleteSync(sid);
      out(r.deleted ? `deleted ${sid}` : "delete failed");
      return;
    }
    default:
      die(`usage: arker syncs <ls|create|rm> ...  (read/write files with: arker sync)`);
  }
}

// File I/O on a VM: read (no data) or write (inline arg or piped stdin).
async function cmdSync(args: ParsedArgs, client: Arker): Promise<void> {
  const vm = args.positional[0] ?? die("usage: arker sync <vm_id> <path> [data]   (omit data to read; or pipe stdin to write)");
  const path = args.positional[1] ?? die("missing path");
  const inline = args.positional[2];
  if (inline !== undefined) {
    await client.vm(vm).sync(path, inline);
    out(`wrote ${Buffer.byteLength(inline)} bytes to ${path}`);
    return;
  }
  if (!process.stdin.isTTY) {
    const buf = await readAllStdin();
    if (buf.length > 0) {
      await client.vm(vm).sync(path, buf);
      out(`wrote ${buf.length} bytes to ${path}`);
      return;
    }
  }
  output.write(await client.vm(vm).sync(path));
}

async function cmdUpdate(args: ParsedArgs, client: Arker): Promise<void> {
  const vm = args.positional[0];
  if (!vm) die("usage: arker update <vm_id> [--memory-mib N] [--vcpu N] [--disk-mib N]");
  const memoryMib = numFlag(args, "memory-mib");
  const vcpu = numFlag(args, "vcpu");
  const diskMib = numFlag(args, "disk-mib");
  if (memoryMib === undefined && vcpu === undefined && diskMib === undefined) {
    die("update: pass at least one of --memory-mib, --vcpu, --disk-mib");
  }
  const updated = await client.vm(vm).update({
    resources: {
      vcpu: vcpu ?? null,
      memory_mib: memoryMib ?? null,
      disk_mib: diskMib ?? null,
    },
  });
  if (args.flags.json) return out(updated);
  out(fmtVm(updated));
}

async function cmdFilesystems(args: ParsedArgs, client: Arker): Promise<void> {
  const sub = args.positional[0];
  const rest = args.positional.slice(1);
  switch (sub) {
    case undefined:
    case "ls":
    case "list": {
      const res = await client.listFilesystems({
        cursor: args.flags.cursor as string | undefined,
        limit: numFlag(args, "limit"),
        namePrefix: args.flags["name-prefix"] as string | undefined,
      });
      if (args.flags.json) return out(res);
      for (const f of res.filesystems) {
        out(`${f.filesystem_id}\t${f.name}\t${f.size_bytes ?? "-"}`);
      }
      if (res.next_cursor) out(`# next_cursor=${res.next_cursor}`);
      return;
    }
    case "create": {
      const name = (args.flags.name as string | undefined) ?? rest[0];
      if (!name) die("usage: arker fs create --name <name>  (or: arker fs create <name>)");
      out(await client.createFilesystem({ name }));
      return;
    }
    case "get": {
      const id = rest[0] ?? die("usage: arker fs get <filesystem_id>");
      out(await client.getFilesystem(id));
      return;
    }
    case "rm":
    case "delete": {
      const id = rest[0] ?? die("usage: arker fs rm <filesystem_id>");
      const r = await client.deleteFilesystem(id);
      out(r.deleted ? `deleted ${id}` : "delete failed");
      return;
    }
    default:
      die(`usage: arker fs <ls|create|get|rm> ...`);
  }
}

// ── Shell ──────────────────────────────────────────────────────────

async function cmdShell(args: ParsedArgs, client: Arker): Promise<void> {
  // Attach to an explicit VM by id (--vm-id or a positional vm id), otherwise
  // fork a fresh one from a source name in the Arker org (default: ubuntu-full).
  let computer: VM;
  const vmIdArg = (args.flags["vm-id"] as string | undefined) ?? args.positional[0];
  const explicitSessionId = args.flags["session-id"] as string | undefined;
  if (!vmIdArg && explicitSessionId) {
    die("usage: arker shell <vm_id> --session-id <session_id>");
  }
  if (vmIdArg) {
    computer = await client.vm(vmIdArg).refresh();
  } else {
    const sourceVmName =
      (args.flags["source-vm-name"] as string | undefined) ?? "ubuntu-full";
    computer = await client.fork({
      sourceVmName,
      sourceOrgId: ARKER_ORG_ID,
    });
    err(`forked ${computer.id}`);
  }

  let sessionId = explicitSessionId;
  if (!sessionId) {
    const session = await computer.createSession({
      cwd: args.flags.cwd as string | undefined,
    });
    sessionId = session.session_id ?? (session as { id?: string }).id;
    if (!sessionId) die("createSession response missing session_id");
  }

  const persist = args.flags["no-persist"] === true ? false : boolFlag(args, "persist");
  const colsFlag = numFlag(args, "cols");
  const rowsFlag = numFlag(args, "rows");
  const cols = colsFlag ?? output.columns ?? 80;
  const rows = rowsFlag ?? output.rows ?? 24;
  // Optional auto-cancel: the server destroys the shell after this many seconds
  // with no terminal I/O — `arker shell <vm> --cancel-ttl 600`.
  const cancelTtlSecs = numFlag(args, "cancel-ttl");
  const pty = await computer.connectPty({
    sessionId,
    cols,
    rows,
    command: args.flags.command as string | undefined,
    persist,
    cancelTtlSecs,
  });

  err(`connected ${computer.id} session ${sessionId}`);
  const exitCode = await bridgePty(pty, {
    fallbackCols: cols,
    fallbackRows: rows,
    autoResize: colsFlag === undefined && rowsFlag === undefined && Boolean(output.isTTY),
  });
  if (exitCode !== 0) process.exit(exitCode);
}

interface BridgePtyOptions {
  fallbackCols: number;
  fallbackRows: number;
  autoResize: boolean;
}

function bridgePty(pty: PtyConnection, options: BridgePtyOptions): Promise<number> {
  return new Promise((resolve) => {
    let settled = false;
    let rawEnabled = false;
    const wasRaw = Boolean(input.isTTY && input.isRaw);
    const restoreTerminal = () => {
      if (rawEnabled && input.isTTY && typeof input.setRawMode === "function") {
        input.setRawMode(wasRaw);
      }
      rawEnabled = false;
    };
    const finish = (code: number) => {
      if (settled) return;
      settled = true;
      restoreTerminal();
      input.off("data", onInput);
      input.off("end", onInputEnd);
      process.off("SIGWINCH", onResize);
      process.off("SIGINT", onSigint);
      process.off("SIGTERM", onSigterm);
      process.off("SIGHUP", onSighup);
      process.off("exit", restoreTerminal);
      offData();
      offClose();
      offError();
      resolve(code);
    };
    const onInput = (chunk: Buffer) => {
      pty.send(chunk);
    };
    const onInputEnd = () => {
      pty.close();
    };
    const onResize = () => {
      pty.resize(output.columns ?? options.fallbackCols, output.rows ?? options.fallbackRows);
    };
    const onSigint = () => {
      pty.send(new Uint8Array([0x03]));
    };
    const onSigterm = () => {
      pty.close();
      finish(143);
    };
    const onSighup = () => {
      pty.close();
      finish(129);
    };
    const offData = pty.onData((data) => {
      output.write(data);
    });
    const offClose = pty.onClose(() => finish(0));
    const offError = pty.onError((error) => {
      const message = error instanceof Error ? error.message : String(error);
      err(`pty error: ${message}`);
    });

    process.once("exit", restoreTerminal);
    pty.ready
      .then(() => {
        if (settled) return;
        if (input.isTTY && typeof input.setRawMode === "function") {
          input.setRawMode(true);
          rawEnabled = true;
        }
        input.resume();
        input.on("data", onInput);
        input.on("end", onInputEnd);
        if (options.autoResize) process.on("SIGWINCH", onResize);
        process.on("SIGINT", onSigint);
        process.on("SIGTERM", onSigterm);
        process.on("SIGHUP", onSighup);
        if (options.autoResize) onResize();
      })
      .catch((error) => {
        const message = error instanceof Error ? error.message : String(error);
        err(`pty failed to open: ${message}`);
        finish(1);
      });
  });
}

// ── SSH ────────────────────────────────────────────────────────────
//
// Onboarding flow: a user runs `arker ssh <vm_id>` and is dropped into a
// shell over real OpenSSH. To make that turnkey the CLI:
//   1. Resolves (or generates) a local SSH key pair.
//   2. Registers the public key against the account via the authed API
//      (POST /v1/account/ssh-keys). The key is account-scoped, so this
//      runs once and is a no-op (idempotent) on subsequent calls.
//   3. Prints — or with --connect/-c, execs — the ready-to-run
//      `ssh <vm_id>@<host>` command. The username IS the VM id; arkerd's
//      SSH server (aws/arkerd/src/ssh/server.rs) parses it as the target.
//
// The public SSH endpoint is fronted by AWS Global Accelerator on port 22
// in regions with enableGlobalAccelerator. The default host below
// (aws-<region>.arker.ai) matches the value arkerd bakes into ARKER_SSH_HOST
// (infra/region/index.ts sshHostname); override with --host / ARKER_SSH_HOST
// when the regional DNS does not point at the accelerator's port-22 IPs.

interface AccountSshKeyInfo {
  id: string;
  fingerprint: string;
  label?: string | null;
  public_key?: string | null;
  created_at?: string;
  last_used_at?: string | null;
}

const SSH_PORT_DEFAULT = 22;

function defaultIdentityBase(): string {
  return join(homedir(), ".ssh", "id_ed25519");
}

// Resolve the local SSH key pair, generating an ed25519 pair if asked and
// none exists. Returns the public key text and the private key path (for the
// printed `ssh -i` command).
function resolveLocalSshKey(
  args: ParsedArgs,
): { publicKey: string; privateKeyPath: string; publicKeyPath: string } {
  const explicit = args.flags.identity as string | undefined;
  // --identity may point at either the private or the .pub; normalise.
  const privateKeyPath = explicit
    ? explicit.replace(/\.pub$/, "")
    : defaultIdentityBase();
  const publicKeyPath = `${privateKeyPath}.pub`;

  if (!existsSync(publicKeyPath)) {
    if (!boolFlag(args, "generate")) {
      die(
        `no SSH public key at ${publicKeyPath}. ` +
          `Pass --identity <path>, or --generate to create an ed25519 key pair.`,
      );
    }
    err(`generating ed25519 key pair at ${privateKeyPath}`);
    const gen = spawnSync(
      "ssh-keygen",
      ["-t", "ed25519", "-N", "", "-f", privateKeyPath, "-C", "arker-cli"],
      { stdio: "inherit" },
    );
    if (gen.status !== 0) die("ssh-keygen failed to generate a key pair");
  }

  const publicKey = readFileSync(publicKeyPath, "utf8").trim();
  if (!publicKey) die(`SSH public key at ${publicKeyPath} is empty`);
  return { publicKey, privateKeyPath, publicKeyPath };
}

// Register a public key against the account. Idempotent: arkerd returns the
// existing row (200) when the same key is already registered for this org,
// and a flat {code,message} 409 only when the key belongs to a *different*
// account — surfaced as a clear error.
async function registerAccountSshKey(
  client: Arker,
  publicKey: string,
  label: string | undefined,
): Promise<AccountSshKeyInfo> {
  return client._request<AccountSshKeyInfo>(
    "POST",
    "/v1/account/ssh-keys",
    { public_key: publicKey, label: label ?? null },
    client.baseUrl,
  );
}

// Derive the customer-facing SSH host. Precedence: --host, ARKER_SSH_HOST,
// then aws-<region>.arker.ai (the value arkerd bakes into config for the
// regional accelerator). Falls back to the compute base hostname.
function resolveSshHost(args: ParsedArgs, client: Arker): string {
  const explicit =
    (args.flags.host as string | undefined) ?? process.env.ARKER_SSH_HOST;
  if (explicit) return explicit;
  if (client.region) return `aws-${client.region}.arker.ai`;
  try {
    return new URL(client.baseUrl).hostname;
  } catch {
    die("could not determine SSH host; pass --host <hostname>");
  }
}

async function cmdSsh(args: ParsedArgs, client: Arker): Promise<void> {
  const vmId =
    (args.flags["vm-id"] as string | undefined) ?? args.positional[0];
  if (!vmId) {
    die(
      "usage: arker ssh <vm_id> [--identity <path>] [--generate] " +
        "[--host <h>] [--port <n>] [--connect|-c] [--skip-register]",
    );
  }

  const { publicKey, privateKeyPath } = resolveLocalSshKey(args);

  if (!boolFlag(args, "skip-register")) {
    const label =
      (args.flags.label as string | undefined) ?? `arker-cli ${homedir().split("/").pop() ?? ""}`.trim();
    try {
      const key = await registerAccountSshKey(client, publicKey, label);
      err(`registered SSH key ${key.fingerprint}${key.label ? ` (${key.label})` : ""}`);
    } catch (e) {
      if (e instanceof ArkerError && e.status === 409) {
        die(`this SSH key is already registered to a different account: ${e.message}`);
      }
      if (e instanceof ArkerError && e.status === 403) {
        die(
          "your API key lacks the developer role required to register SSH keys. " +
            "Register the key in the console, then re-run with --skip-register.",
        );
      }
      throw e;
    }
  }

  const host = resolveSshHost(args, client);
  const port = numFlag(args, "port") ?? SSH_PORT_DEFAULT;
  const sshArgs = [
    "-i",
    privateKeyPath,
    ...(port !== 22 ? ["-p", String(port)] : []),
    `${vmId}@${host}`,
  ];
  const command = `ssh ${sshArgs.join(" ")}`;

  if (boolFlag(args, "connect") || boolFlag(args, "c")) {
    err(`connecting: ${command}`);
    const r = spawnSync("ssh", sshArgs, { stdio: "inherit" });
    process.exit(r.status ?? 1);
  }

  // Default: print the ready-to-paste command. stdout-only so it can be
  // captured (`eval "$(arker ssh <vm> --print)"` style).
  out(command);
}

async function cmdSshKeys(args: ParsedArgs, client: Arker): Promise<void> {
  const sub = args.positional[0];
  const rest = args.positional.slice(1);
  switch (sub) {
    case undefined:
    case "ls":
    case "list": {
      const res = await client._request<{ keys: AccountSshKeyInfo[] }>(
        "GET",
        "/v1/account/ssh-keys",
        undefined,
        client.baseUrl,
      );
      if (args.flags.json) return out(res);
      for (const k of res.keys) {
        out(`${k.id}\t${k.fingerprint}\t${k.label ?? "—"}`);
      }
      return;
    }
    case "add": {
      const { publicKey } = resolveLocalSshKey(args);
      const label = args.flags.label as string | undefined;
      const key = await registerAccountSshKey(client, publicKey, label);
      if (args.flags.json) return out(key);
      out(`${key.id}\t${key.fingerprint}\t${key.label ?? "—"}`);
      return;
    }
    case "rm":
    case "delete": {
      const id = rest[0] ?? die("usage: arker ssh-keys rm <key_id>");
      const r = await client._request<{ deleted: boolean }>(
        "DELETE",
        `/v1/account/ssh-keys/${encodeURIComponent(id)}`,
        undefined,
        client.baseUrl,
      );
      out(r.deleted ? `deleted ${id}` : "delete failed");
      return;
    }
    default:
      die("usage: arker ssh-keys <ls|add|rm> ...");
  }
}

// ── Helpers ────────────────────────────────────────────────────────

function numFlag(args: ParsedArgs, name: string): number | undefined {
  const v = args.flags[name];
  if (typeof v === "string") return Number(v);
  return undefined;
}

function boolFlag(args: ParsedArgs, name: string): boolean | undefined {
  const v = args.flags[name];
  if (v === undefined) return undefined;
  if (typeof v === "boolean") return v;
  if (v === "false" || v === "0") return false;
  return true;
}

async function readAllStdin(): Promise<Uint8Array> {
  const chunks: Buffer[] = [];
  for await (const chunk of input) chunks.push(chunk as Buffer);
  return new Uint8Array(Buffer.concat(chunks));
}

function usage(): never {
  out(
    [
      `arker v${VERSION}`,
      "",
      "Usage:",
      "  arker <command> [args]",
      "",
      "Shortcuts:",
      "  arker ls                                       list VMs",
      "  arker rm <vm>                                  delete VM",
      "  arker fork <vm_name>                           fork the public golden (in Arker org)",
      "  arker fork --source-vm-id <id>                 fork by global id",
      "  arker fork --source-vm-name <n> --source-org-id <org>",
      "                                                 fork by name in another org",
      "  arker fork <vm> [--vcpu N] [--memory-mib N] [--disk-mib N] [--no-disk]",
      "                                                 fork with resource/network overrides",
      "  arker run <vm> <command> [--session-id <id>] [--session-idx N]   run a command",
      "  arker update <vm> [--memory-mib N] [--vcpu N] [--disk-mib N]   update a VM (PATCH)",
      "  arker shell [vm_id]                            native PTY shell (forks ubuntu-full if no vm)",
      "",
      "Resources:",
      "  arker vms         <ls|get|rm|fork|run> ...",
      "  arker runs        <ls|get|rm> <vm_id> ...",
      "  arker sessions    <ls|get|create|rm> <vm_id> ...",
      "  arker syncs       <ls|create|rm> <vm_id> ...",
      "  arker filesystems <ls|create|get|rm> ...   (alias: fs)",
      "",
      "Flags:",
      "  --api-key <key>            (or env ARKER_API_KEY)",
      "  --region <region>          (or env ARKER_REGION; e.g. us-west-2)",
      "  --provider <aws>           (or env ARKER_PROVIDER; default aws)",
      "  --base-url <url>           override compute URL (env ARKER_BASE_URL)",
      "  --control-base-url <url>   override CF Worker URL (env ARKER_CONTROL_BASE_URL)",
      "  --json                     emit JSON instead of tabular output",
      "",
      "Fork flags:",
      "  --vcpu <n>                 vCPU count for the new VM (capped by source max_vcpus)",
      "  --memory-mib <n>           memory (MiB) for the new VM",
      "  --disk-mib <n>             disk size (MiB) for the new VM",
      "  --no-disk                  fork a memory-backed (nodisk) VM",
      "",
      "Run flags:",
      "  --session-id <ulid>        run in a specific existing session",
      "  --session-idx <n>          run in the session at this index (default 0)",
      "  --background               return a run id instead of blocking",
      "  --timeout <secs>           exec/kill bound: max seconds the command runs before it is killed (0 = unbounded; server default 3600)",
      "  --time-to-background <secs> sync window: seconds the call blocks before returning a run id (default 30)",
      "  --acquire <list>           warm resources before the run (cpu,memory,disk)",
      "  --release <list>           release resources after the run (cpu,memory,disk)",
      "",
      "Shell flags:",
      "  --session-id <id>          reconnect to an existing PTY session",
      "  --command <path>           shell executable path (default: /bin/bash)",
      "  --cols <n> --rows <n>      initial terminal size",
      "  --no-persist               close the remote PTY process on disconnect",
    ].join("\n"),
  );
  process.exit(2);
}

// ── Entry ──────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  if (argv.length === 0 || argv[0] === "-h" || argv[0] === "--help") usage();
  const cmd = argv[0]!;
  const args = parseArgs(argv.slice(1));
  const client = clientFromArgs(args);

  try {
    switch (cmd) {
      // Shortcuts.
      case "ls":
      case "list":
        return await cmdVms({ ...args, positional: ["ls", ...args.positional] }, client);
      case "rm":
      case "delete":
        return await cmdVms({ ...args, positional: ["rm", ...args.positional] }, client);
      case "fork":
        return await cmdFork(args, client);
      case "run":
        return await cmdRun(args, client);
      case "sync":
        return await cmdSync(args, client);
      case "syncs":
        return await cmdSyncs(args, client);
      case "shell":
        return await cmdShell(args, client);
      // SSH is descoped/unsupported and hidden from the interface. The
      // implementation below (cmdSsh / cmdSshKeys) is kept intact; re-add
      // the `ssh` / `ssh-keys` cases here and their help entries to expose
      // it once the server-side SSH path is supported.
      // Resources.
      case "vms":
        return await cmdVms(args, client);
      case "runs":
        return await cmdRuns(args, client);
      case "sessions":
        return await cmdSessions(args, client);
      case "update":
        return await cmdUpdate(args, client);
      case "filesystems":
      case "fs":
        return await cmdFilesystems(args, client);
      default:
        die(`unknown command: ${cmd}. Run 'arker --help'.`);
    }
  } catch (e) {
    if (e instanceof ArkerError) {
      err(`${e.code}: ${e.message}`);
      process.exit(1);
    }
    throw e;
  }
}

void main();

// Touch ResourceKind to keep the import alive for downstream callers
// that re-export from this module via `tsc --declaration` in future.
void (null as unknown as ResourceKind);

// SSH is descoped/hidden from the interface (no `ssh` / `ssh-keys` command
// dispatch above), but the implementation is intentionally retained so it can
// be re-exposed in one step once supported. Reference it here to keep the
// definitions and their imports alive.
void cmdSsh;
void cmdSshKeys;
