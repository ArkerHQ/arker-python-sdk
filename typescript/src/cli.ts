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
 * Resources: vms, runs, sessions, syncs, tunnels, filesystems (alias `fs`).
 * Each supports `ls`, `get`, `rm`, and the resource-specific verbs.
 *
 * Auth: reads `ARKER_API_KEY` from the environment (or `~/.arker/config`).
 * Region: `ARKER_REGION` or the `--region` flag.
 */

import { readFileSync, existsSync } from "node:fs";
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
  const region = explicitRegion ?? file.region;
  const provider = (args.flags.provider as "aws" | "aws-burst" | undefined) ??
    (process.env.ARKER_PROVIDER as "aws" | "aws-burst" | undefined);
  if (!apiKey) {
    die("Missing API key. Set ARKER_API_KEY or pass --api-key.");
  }
  if (!baseUrl && !region) {
    die("Missing region. Set ARKER_REGION or pass --region (e.g. us-west-2). --provider (aws|aws-burst) defaults to aws.");
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

function fmtVm(vm: VM): string {
  const provider = vm.provider ?? "?";
  const region = vm.region ?? "?";
  const name = vm.name ?? "—";
  const state = vm.state ?? "?";
  return `${vm.vm_id ?? vm.id}\t${provider}-${region}\t${state}\t${name}`;
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
    die("usage: arker fork <vm_name> | --source-vm-id <id> | --source-vm-name <name> [--source-org-id <org>]");
  }
  const computer = await client.fork({
    sourceVmId,
    sourceVmName,
    sourceOrgId,
    name,
    public: publicFlag,
  });
  out({ vm_id: computer.id });
}

async function cmdRun(args: ParsedArgs, client: Arker): Promise<void> {
  const vmId = args.positional[0] ?? die("usage: arker run <vm_id> <command...>");
  const command = args.positional.slice(1).join(" ");
  if (!command) die("missing command to run");
  const result: RunResult = await client.vm(vmId).run(command, {
    background: boolFlag(args, "background"),
    timeout: numFlag(args, "timeout"),
    acquire: args.flags.acquire as string | undefined,
    release: args.flags.release as string | undefined,
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

async function cmdTunnels(args: ParsedArgs, client: Arker): Promise<void> {
  const sub = args.positional[0];
  const rest = args.positional.slice(1);
  const vm = rest[0];
  switch (sub) {
    case "ls":
    case "list": {
      if (!vm) die("usage: arker tunnels ls <vm_id>");
      const res = await client.vm(vm).listTunnels({
        state: args.flags.state as "starting" | "open" | "closed" | undefined,
        cursor: args.flags.cursor as string | undefined,
        limit: numFlag(args, "limit"),
      });
      if (args.flags.json) return out(res);
      for (const t of res.tunnels) {
        out(`${t.tunnel_key ?? "-"}\t${t.port}\t${t.state}\t${t.protocol}\t${t.url ?? "-"}`);
      }
      if (res.next_cursor) out(`# next_cursor=${res.next_cursor}`);
      return;
    }
    case "create": {
      if (!vm) die("usage: arker tunnels create <vm_id> [--ports 80,8080] [--auth-mode open|authenticated]");
      const tunnel = await client.vm(vm).createTunnel({
        ports: parsePorts(args.flags.ports),
        auth_mode: args.flags["auth-mode"] as "open" | "authenticated" | undefined,
      });
      return out(tunnel);
    }
    case "get": {
      if (!vm) die("usage: arker tunnels get <vm_id> <key>");
      const key = rest[1] ?? die("missing key");
      out(await client.vm(vm).getTunnel(key));
      return;
    }
    case "rm":
    case "delete": {
      if (!vm) die("usage: arker tunnels rm <vm_id> <key>");
      const key = rest[1] ?? die("missing key");
      const r = await client.vm(vm).deleteTunnel(key);
      out(r.deleted ? `deleted tunnel ${key}` : "delete failed");
      return;
    }
    default:
      die(`usage: arker tunnels <ls|create|get|rm> ...`);
  }
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
  const pty = await computer.connectPty({
    sessionId,
    cols,
    rows,
    command: args.flags.command as string | undefined,
    persist,
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

function parsePorts(value: string | boolean | undefined): number[] | undefined {
  if (typeof value !== "string" || value.trim() === "") return undefined;
  return value.split(",").map((part) => Number(part.trim())).filter((port) => Number.isFinite(port));
}

async function readAllStdin(): Promise<Uint8Array> {
  const chunks: Buffer[] = [];
  for await (const chunk of input) chunks.push(chunk as Buffer);
  return new Uint8Array(Buffer.concat(chunks));
}

function usage(): never {
  out(
    [
      "arker — VM control plane CLI",
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
      "  arker run <vm> <command>                       run a command",
      "  arker shell [vm_id]                            native PTY shell (forks ubuntu-full if no vm)",
      "",
      "Resources:",
      "  arker vms         <ls|get|rm|fork|run> ...",
      "  arker runs        <ls|get|rm> <vm_id> ...",
      "  arker sessions    <ls|get|create|rm> <vm_id> ...",
      "  arker syncs       <ls|create|rm> <vm_id> ...",
      "  arker tunnels     <ls|get|rm> <vm_id> ...",
      "  arker filesystems <ls|create|get|rm> ...   (alias: fs)",
      "",
      "Flags:",
      "  --api-key <key>            (or env ARKER_API_KEY)",
      "  --region <region>          (or env ARKER_REGION; e.g. us-west-2)",
      "  --provider <aws|aws-burst> (or env ARKER_PROVIDER; default aws)",
      "  --base-url <url>           override compute URL (env ARKER_BASE_URL)",
      "  --control-base-url <url>   override CF Worker URL (env ARKER_CONTROL_BASE_URL)",
      "  --json                     emit JSON instead of tabular output",
      "",
      "Shell flags:",
      "  --session-id <id>          reconnect to an existing PTY session",
      "  --command <path>           shell executable path (default: /bin/bash)",
      "  --cols <n> --rows <n>      initial terminal size",
      "  --no-persist               close the remote PTY process on disconnect",
      "",
      `Arker org id: ${ARKER_ORG_ID}`,
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
      // Resources.
      case "vms":
        return await cmdVms(args, client);
      case "runs":
        return await cmdRuns(args, client);
      case "sessions":
        return await cmdSessions(args, client);
      case "tunnels":
        return await cmdTunnels(args, client);
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
