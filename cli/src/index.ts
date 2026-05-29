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
 *     arker shell [vm]         → REPL: fork a fresh VM (or attach to one) and exec
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
import * as readline from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import { Arker, ArkerError, ARKER_ORG_ID } from "@arker-ai/sdk";
import type {
  Computer,
  ResourceKind,
  RunResult,
  Vm,
} from "@arker-ai/sdk";

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
  const path = join(homedir(), ".arker", "config.json");
  if (!existsSync(path)) return {};
  try {
    return JSON.parse(readFileSync(path, "utf8")) as CliConfig;
  } catch {
    return {};
  }
}

function clientFromArgs(args: ParsedArgs): Arker {
  const file = readFileConfig();
  const apiKey =
    (args.flags["api-key"] as string | undefined) ??
    process.env.ARKER_API_KEY ??
    file.apiKey;
  const baseUrl =
    (args.flags["base-url"] as string | undefined) ??
    process.env.ARKER_BASE_URL ??
    file.baseUrl;
  const controlBaseUrl =
    (args.flags["control-base-url"] as string | undefined) ??
    process.env.ARKER_CONTROL_BASE_URL;
  const region =
    (args.flags.region as string | undefined) ??
    process.env.ARKER_REGION ??
    file.region;
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

function fmtVm(vm: Vm): string {
  const provider = vm.provider ?? "?";
  const region = vm.region ?? "?";
  const name = vm.name ?? "—";
  const state = vm.state;
  return `${vm.vm_id}\t${provider}-${region}\t${state}\t${name}`;
}

// ── Resources ──────────────────────────────────────────────────────

async function cmdVms(args: ParsedArgs, client: Arker): Promise<void> {
  const sub = args.positional[0];
  const rest = args.positional.slice(1);
  switch (sub) {
    case undefined:
    case "ls":
    case "list": {
      const res = await client.list({
        provider: args.flags.provider as "aws" | "aws-burst" | undefined,
        region: args.flags.region as string | undefined,
        state: args.flags.state as "idle" | "running" | undefined,
        cursor: args.flags.cursor as string | undefined,
        limit: numFlag(args, "limit"),
      });
      if (args.flags.json) return out(res);
      for (const vm of res.vms) out(fmtVm(vm));
      if (res.next_cursor) out(`# next_cursor=${res.next_cursor}`);
      return;
    }
    case "get": {
      const id = rest[0] ?? die("usage: arker vms get <vm_id>");
      out(await client.get(id));
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
    // Shortcut: `arker fork arkuntu` → public-goldens fork.
    sourceVmName = refPositional;
    if (!sourceOrgId) sourceOrgId = ARKER_ORG_ID;
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
  if (result.type === "completed") {
    process.stdout.write(new TextDecoder().decode(result.stdout));
    if (result.stderr.length) process.stderr.write(new TextDecoder().decode(result.stderr));
    process.exitCode = result.exitCode === 0 ? 0 : result.exitCode;
    return;
  }
  out({ run_id: result.runId, tunnels: result.tunnels });
}

async function cmdRuns(args: ParsedArgs, client: Arker): Promise<void> {
  const sub = args.positional[0];
  const rest = args.positional.slice(1);
  switch (sub) {
    case "ls":
    case "list": {
      const vm = rest[0] ?? die("usage: arker runs ls <vm_id>");
      const res = await client.vm(vm).runs.list({
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
      out(await client.vm(vm).runs.get(runId));
      return;
    }
    case "rm":
    case "cancel": {
      const [vm, runId] = rest;
      if (!vm || !runId) die("usage: arker runs rm <vm_id> <run_id>");
      const r = await client.vm(vm).runs.cancel(runId);
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
      const res = await client.vm(vm).sessions.list({
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
      out(await client.vm(vm).sessions.get(sid));
      return;
    }
    case "create": {
      if (!vm) die("usage: arker sessions create <vm_id>");
      out(await client.vm(vm).sessions.create({ cwd: args.flags.cwd as string | undefined }));
      return;
    }
    case "rm":
    case "delete": {
      if (!vm) die("usage: arker sessions rm <vm_id> <session_id>");
      const sid = rest[1] ?? die("missing session_id");
      const r = await client.vm(vm).sessions.delete(sid);
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
      const res = await client.vm(vm).syncs.list({
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
    case "get": {
      if (!vm) die("usage: arker syncs get <vm_id> <sync_id>");
      const sid = rest[1] ?? die("missing sync_id");
      out(await client.vm(vm).syncs.get(sid));
      return;
    }
    case "create": {
      if (!vm) die("usage: arker syncs create <vm_id> --path /mnt [--filesystem-name foo] [--create]");
      const path = args.flags.path as string | undefined;
      if (!path) die("missing --path");
      out(await client.vm(vm).syncs.create({
        path,
        filesystemId: args.flags["filesystem-id"] as string | undefined,
        filesystemName: args.flags["filesystem-name"] as string | undefined,
        createIfMissing: boolFlag(args, "create") ?? false,
      }));
      return;
    }
    case "rm":
    case "delete": {
      if (!vm) die("usage: arker syncs rm <vm_id> <sync_id>");
      const sid = rest[1] ?? die("missing sync_id");
      const r = await client.vm(vm).syncs.delete(sid);
      out(r.deleted ? `deleted ${sid}` : "delete failed");
      return;
    }
    case "read": {
      if (!vm) die("usage: arker syncs read <vm_id> <path>");
      const path = rest[1] ?? die("missing path");
      const bytes = await client.vm(vm).syncs.readFile(path);
      output.write(bytes);
      return;
    }
    case "write": {
      if (!vm) die("usage: arker syncs write <vm_id> <path> < file");
      const path = rest[1] ?? die("missing path");
      const buf = await readAllStdin();
      await client.vm(vm).syncs.writeFile(path, buf);
      out(`wrote ${buf.length} bytes to ${path}`);
      return;
    }
    default:
      die(`usage: arker syncs <ls|get|create|rm|read|write> ...`);
  }
}

async function cmdTunnels(args: ParsedArgs, client: Arker): Promise<void> {
  const sub = args.positional[0];
  const rest = args.positional.slice(1);
  const vm = rest[0];
  switch (sub) {
    case "ls":
    case "list": {
      if (!vm) die("usage: arker tunnels ls <vm_id>");
      const res = await client.vm(vm).tunnels.list({
        state: args.flags.state as "starting" | "open" | "closed" | undefined,
        cursor: args.flags.cursor as string | undefined,
        limit: numFlag(args, "limit"),
      });
      if (args.flags.json) return out(res);
      for (const t of res.tunnels) {
        out(`${t.port}\t${t.state}\t${t.protocol}\t${t.url ?? "-"}`);
      }
      if (res.next_cursor) out(`# next_cursor=${res.next_cursor}`);
      return;
    }
    case "get": {
      if (!vm) die("usage: arker tunnels get <vm_id> <port>");
      const port = Number(rest[1] ?? die("missing port"));
      out(await client.vm(vm).tunnels.get(port));
      return;
    }
    case "rm":
    case "delete": {
      if (!vm) die("usage: arker tunnels rm <vm_id> <port>");
      const port = Number(rest[1] ?? die("missing port"));
      const r = await client.vm(vm).tunnels.delete(port);
      out(r.deleted ? `deleted tunnel ${port}` : "delete failed");
      return;
    }
    default:
      die(`usage: arker tunnels <ls|get|rm> ...`);
  }
}

async function cmdFilesystems(args: ParsedArgs, client: Arker): Promise<void> {
  const sub = args.positional[0];
  const rest = args.positional.slice(1);
  switch (sub) {
    case undefined:
    case "ls":
    case "list": {
      const res = await client.filesystems.list({
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
    case "get": {
      const id = rest[0] ?? die("usage: arker fs get <filesystem_id>");
      out(await client.filesystems.get(id));
      return;
    }
    case "rm":
    case "delete": {
      const id = rest[0] ?? die("usage: arker fs rm <filesystem_id>");
      const r = await client.filesystems.delete(id);
      out(r.deleted ? `deleted ${id}` : "delete failed");
      return;
    }
    default:
      die(`usage: arker fs <ls|get|rm> ...`);
  }
}

// ── Shell ──────────────────────────────────────────────────────────

async function cmdShell(args: ParsedArgs, client: Arker): Promise<void> {
  // Attach to an explicit VM by id (--vm-id or a positional vm id),
  // otherwise fork a fresh one from a source name in the Arker org
  // (default: ubuntu-full).
  let computer: Computer;
  let header: Vm;
  const vmIdArg = (args.flags["vm-id"] as string | undefined) ?? args.positional[0];
  if (vmIdArg) {
    computer = client.vm(vmIdArg);
    header = await computer.get();
  } else {
    const sourceVmName =
      (args.flags["source-vm-name"] as string | undefined) ?? "ubuntu-full";
    computer = await client.fork({
      sourceVmName,
      sourceOrgId: ARKER_ORG_ID,
    });
    header = await computer.get();
  }
  // Print the new VM as a get-style response, then drop into a minimal
  // `>` REPL. No prefix, no chrome.
  output.write(JSON.stringify(header, null, 2) + "\n");
  const rl = readline.createInterface({ input, output, prompt: "> " });
  rl.prompt();
  for await (const line of rl) {
    const cmd = line.trim();
    if (!cmd) {
      rl.prompt();
      continue;
    }
    if (cmd === "exit" || cmd === "quit") break;
    try {
      const result = await computer.run(cmd);
      if (result.type === "completed") {
        process.stdout.write(new TextDecoder().decode(result.stdout));
        if (result.stderr.length) process.stderr.write(new TextDecoder().decode(result.stderr));
      } else {
        out({ run_id: result.runId });
      }
    } catch (e) {
      err(e instanceof Error ? e.message : String(e));
    }
    rl.prompt();
  }
  rl.close();
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
      "  arker shell [vm_id]                            interactive shell (forks arkuntu if no vm)",
      "",
      "Resources:",
      "  arker vms         <ls|get|rm|fork|run> ...",
      "  arker runs        <ls|get|rm> <vm_id> ...",
      "  arker sessions    <ls|get|create|rm> <vm_id> ...",
      "  arker syncs       <ls|get|create|rm|read|write> <vm_id> ...",
      "  arker tunnels     <ls|get|rm> <vm_id> ...",
      "  arker filesystems <ls|get|rm> ...   (alias: fs)",
      "",
      "Flags:",
      "  --api-key <key>            (or env ARKER_API_KEY)",
      "  --region <region>          (or env ARKER_REGION; e.g. us-west-2)",
      "  --provider <aws|aws-burst> (or env ARKER_PROVIDER; default aws)",
      "  --base-url <url>           override compute URL (env ARKER_BASE_URL)",
      "  --control-base-url <url>   override CF Worker URL (env ARKER_CONTROL_BASE_URL)",
      "  --json                     emit JSON instead of tabular output",
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
