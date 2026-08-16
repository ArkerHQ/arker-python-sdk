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
 * Placement: `ARKER_PROVIDER` + `ARKER_REGION`, or the matching flags.
 */

import { readFileSync, existsSync, fstatSync } from "node:fs";
import { createRequire } from "node:module";
import { homedir } from "node:os";
import { join } from "node:path";
import { stdin as input, stdout as output } from "node:process";
import {
  Arker,
  ArkerError,
  discoverRegions,
} from "./index.js";
import { bridgePty } from "./cli-pty.js";
import type {
  PolicyDoc,
  ResourcesInput,
  RunRecord,
  RunSignal,
  VM,
  RunResult,
  Vm,
  ListVmsParameters,
} from "./index.js";

/** Signals the service accepts, per RunRequest.signal in the OpenAPI contract. */
const RUN_SIGNALS = ["SIGINT", "SIGTERM", "SIGKILL", "SIGHUP"] as const;

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
  flags: Record<string, string | boolean | number>;
}

type OptionSpec =
  | { type: "boolean" }
  | { type: "string"; values?: readonly string[] }
  | { type: "integer"; min: number; max?: number }
  // Fractional, for `--vgpu 0.25`. `min` is INCLUSIVE when a `step` is given
  // (the smallest rung is a legal value); exclusive otherwise. `step` states a
  // ladder the server enforces, so we can refuse the same values it would
  // rather than spending a round trip on a 400.
  | { type: "number"; min: number; max: number; step?: number };

type OptionSpecs = Record<string, OptionSpec>;

const GLOBAL_OPTIONS: OptionSpecs = {
  help: { type: "boolean" },
  json: { type: "boolean" },
  provider: { type: "string" },
  region: { type: "string" },
};

const PAGINATION_OPTIONS: OptionSpecs = {
  cursor: { type: "string" },
  limit: { type: "integer", min: 1, max: 1000 },
};

const RESOURCE_OPTIONS: OptionSpecs = {
  "disk-mib": { type: "integer", min: 0 },
  "memory-mib": { type: "integer", min: 0 },
  vcpu: { type: "integer", min: 0, max: 255 },
};

const FORK_RESOURCE_OPTIONS: OptionSpecs = {
  ...RESOURCE_OPTIONS,
  // Eighths of one card, matching `multipleOf: 0.125` in the API contract.
  vgpu: { type: "number", min: 0.125, max: 1, step: 0.125 },
};

const RUN_OPTIONS: OptionSpecs = {
  ...GLOBAL_OPTIONS,
  acquire: { type: "string" },
  "queueing-timeout": { type: "integer", min: 0 },
  release: { type: "string" },
  "session-id": { type: "string" },
  "session-idx": { type: "integer", min: 0 },
  timeout: { type: "integer", min: 0 },
  "time-to-background": { type: "integer", min: 0 },
};

const COMMAND_OPTIONS: Record<string, OptionSpecs> = {
  delete: GLOBAL_OPTIONS,
  filesystems: {
    ...GLOBAL_OPTIONS,
    ...PAGINATION_OPTIONS,
    name: { type: "string" },
    "name-prefix": { type: "string" },
  },
  fork: {
    ...GLOBAL_OPTIONS,
    ...FORK_RESOURCE_OPTIONS,
    description: { type: "string" },
    name: { type: "string" },
    "no-disk": { type: "boolean" },
    platform: { type: "string" },
    public: { type: "boolean" },
    "queueing-timeout": { type: "integer", min: 0 },
    "source-org-id": { type: "string" },
    "source-vm-id": { type: "string" },
    "source-vm-name": { type: "string" },
  },
  fs: {},
  list: {
    ...GLOBAL_OPTIONS,
    ...PAGINATION_OPTIONS,
    public: { type: "boolean" },
    "source-org-id": { type: "string" },
    state: { type: "string", values: ["idle", "running"] },
  },
  ls: {
    ...GLOBAL_OPTIONS,
    ...PAGINATION_OPTIONS,
    public: { type: "boolean" },
    "source-org-id": { type: "string" },
    state: { type: "string", values: ["idle", "running"] },
  },
  rm: GLOBAL_OPTIONS,
  run: RUN_OPTIONS,
  runs: {
    ...GLOBAL_OPTIONS,
    ...PAGINATION_OPTIONS,
    state: { type: "string", values: ["running", "completed", "cancelled", "failed"] },
  },
  sessions: {
    ...GLOBAL_OPTIONS,
    ...PAGINATION_OPTIONS,
    cols: { type: "integer", min: 1 },
    cwd: { type: "string" },
    rows: { type: "integer", min: 1 },
    state: { type: "string", values: ["idle", "running"] },
    "timeout-secs": { type: "integer", min: 0 },
  },
  shell: {
    ...GLOBAL_OPTIONS,
    "cancel-ttl": { type: "integer", min: 0 },
    cols: { type: "integer", min: 1 },
    command: { type: "string" },
    cwd: { type: "string" },
    "no-persist": { type: "boolean" },
    persist: { type: "boolean" },
    rows: { type: "integer", min: 1 },
    "session-id": { type: "string" },
    "source-vm-name": { type: "string" },
    "vm-id": { type: "string" },
  },
  policies: {
    ...GLOBAL_OPTIONS,
    file: { type: "string" },
  },
  regions: {
    help: { type: "boolean" },
    json: { type: "boolean" },
  },
  signal: {
    ...GLOBAL_OPTIONS,
    "session-id": { type: "string" },
    "session-idx": { type: "integer", min: 0 },
  },
  sync: {
    ...GLOBAL_OPTIONS,
    from: { type: "string" },
    read: { type: "boolean" },
    to: { type: "string" },
  },
  "sync-dir": {
    ...GLOBAL_OPTIONS,
    "assume-empty": { type: "boolean" },
  },
  syncs: {
    ...GLOBAL_OPTIONS,
    ...PAGINATION_OPTIONS,
    "filesystem-id": { type: "string" },
    path: { type: "string" },
  },
  update: {
    ...GLOBAL_OPTIONS,
    ...RESOURCE_OPTIONS,
    description: { type: "string" },
  },
  vms: {
    ...GLOBAL_OPTIONS,
    ...PAGINATION_OPTIONS,
    ...FORK_RESOURCE_OPTIONS,
    acquire: { type: "string" },
    description: { type: "string" },
    name: { type: "string" },
    "no-disk": { type: "boolean" },
    platform: { type: "string" },
    public: { type: "boolean" },
    "queueing-timeout": { type: "integer", min: 0 },
    release: { type: "string" },
    "session-id": { type: "string" },
    "session-idx": { type: "integer", min: 0 },
    "source-org-id": { type: "string" },
    "source-vm-id": { type: "string" },
    "source-vm-name": { type: "string" },
    state: { type: "string", values: ["idle", "running"] },
    timeout: { type: "integer", min: 0 },
    "time-to-background": { type: "integer", min: 0 },
  },
};

COMMAND_OPTIONS.fs = COMMAND_OPTIONS.filesystems!;
COMMAND_OPTIONS.ls = COMMAND_OPTIONS.list!;

const COMMANDS = new Set(Object.keys(COMMAND_OPTIONS));

interface Invocation {
  command: string;
  args: ParsedArgs;
}

type LocalAction =
  | { type: "help"; command?: string; sub?: string }
  | { type: "version" };

function parseInvocation(argv: string[]): Invocation | LocalAction {
  if (argv.length === 0) return { type: "help" };
  const flags: ParsedArgs["flags"] = {};
  let index = 0;
  while (index < argv.length) {
    const arg = argv[index]!;
    if (arg === "--help" || arg === "-h") return { type: "help" };
    if (arg === "--version" || arg === "-v") return { type: "version" };
    if (!arg.startsWith("-")) break;
    index = parseOption(argv, index, GLOBAL_OPTIONS, flags);
  }

  const command = argv[index];
  if (!command) return { type: "help" };
  if (!COMMANDS.has(command)) die(`unknown command: ${command}. Run 'arker --help'.`);
  const remoteBoundary = command === "run"
    ? (positional: string[]) => positional.length >= 2
    : command === "vms"
      ? (positional: string[]) => positional[0] === "run" && positional.length >= 3
      : undefined;
  const args = parseArgs(argv.slice(index + 1), COMMAND_OPTIONS[command]!, flags, remoteBoundary);
  if (args.flags.help === true) {
    const sub = args.positional[0];
    return { type: "help", command, sub: typeof sub === "string" ? sub : undefined };
  }
  validateInvocationOptions(command, args);
  return { command, args };
}

function validateInvocationOptions(command: string, args: ParsedArgs): void {
  const subcommand = args.positional[0];
  let allowed = COMMAND_OPTIONS[command]!;
  let context = command;
  if (command === "vms") {
    context = `vms ${subcommand ?? "ls"}`;
    if (subcommand === undefined || subcommand === "ls" || subcommand === "list") {
      allowed = {
        ...GLOBAL_OPTIONS,
        ...PAGINATION_OPTIONS,
        public: { type: "boolean" },
        "source-org-id": { type: "string" },
        state: { type: "string" },
      };
    } else if (subcommand === "fork") {
      allowed = COMMAND_OPTIONS.fork!;
    } else if (subcommand === "run") {
      allowed = RUN_OPTIONS;
    } else if (subcommand === "update") {
      allowed = COMMAND_OPTIONS.update!;
    } else {
      allowed = GLOBAL_OPTIONS;
    }
  } else if (command === "runs") {
    context = `runs ${subcommand ?? ""}`.trim();
    allowed = subcommand === "ls" || subcommand === "list"
      ? { ...GLOBAL_OPTIONS, ...PAGINATION_OPTIONS, state: { type: "string" } }
      : GLOBAL_OPTIONS;
  } else if (command === "sessions") {
    context = `sessions ${subcommand ?? ""}`.trim();
    allowed = subcommand === "ls" || subcommand === "list"
      ? { ...GLOBAL_OPTIONS, ...PAGINATION_OPTIONS, state: { type: "string" } }
      : subcommand === "create"
        ? { ...GLOBAL_OPTIONS, cwd: { type: "string" } }
        : subcommand === "update"
          ? {
              ...GLOBAL_OPTIONS,
              cols: { type: "integer", min: 1 },
              rows: { type: "integer", min: 1 },
              "timeout-secs": { type: "integer", min: 0 },
            }
          : GLOBAL_OPTIONS;
  } else if (command === "syncs") {
    context = `syncs ${subcommand ?? ""}`.trim();
    allowed = subcommand === "ls" || subcommand === "list"
      ? { ...GLOBAL_OPTIONS, ...PAGINATION_OPTIONS, "filesystem-id": { type: "string" } }
      : subcommand === "create"
        ? { ...GLOBAL_OPTIONS, "filesystem-id": { type: "string" }, path: { type: "string" } }
        : GLOBAL_OPTIONS;
  } else if (command === "filesystems" || command === "fs") {
    context = `${command} ${subcommand ?? "ls"}`;
    allowed = subcommand === undefined || subcommand === "ls" || subcommand === "list"
      ? { ...GLOBAL_OPTIONS, ...PAGINATION_OPTIONS, "name-prefix": { type: "string" } }
      : subcommand === "create"
        ? { ...GLOBAL_OPTIONS, name: { type: "string" } }
        : GLOBAL_OPTIONS;
  }

  for (const flag of Object.keys(args.flags)) {
    if (!(flag in allowed)) die(`parameter "${flag}" is not valid for "${context}"`);
  }
}

function parseArgs(
  argv: string[],
  specs: OptionSpecs,
  initialFlags: ParsedArgs["flags"] = {},
  stopParsingOptions?: (positional: string[]) => boolean,
): ParsedArgs {
  const positional: string[] = [];
  const flags = { ...initialFlags };
  let optionsActive = true;
  for (let i = 0; i < argv.length;) {
    const arg = argv[i]!;
    if (optionsActive && arg === "--") {
      optionsActive = false;
      i++;
      continue;
    }
    if (optionsActive && arg.startsWith("-") && arg !== "-") {
      i = parseOption(argv, i, specs, flags);
      continue;
    }
    positional.push(arg);
    i++;
    if (stopParsingOptions?.(positional)) optionsActive = false;
  }
  return { positional, flags };
}

function parseOption(
  argv: string[],
  index: number,
  specs: OptionSpecs,
  flags: ParsedArgs["flags"],
): number {
  const raw = argv[index]!;
  const shortName = raw === "-h" ? "help" : undefined;
  if (!raw.startsWith("--") && !shortName) die(`unknown parameter "${raw.slice(1)}"`);
  const equal = raw.indexOf("=");
  const name = shortName ?? raw.slice(2, equal === -1 ? undefined : equal);
  const inline = equal === -1 ? undefined : raw.slice(equal + 1);
  const spec = specs[name];
  if (!spec) die(`unknown parameter "${name}"`);

  if (spec.type === "boolean") {
    if (inline === undefined || inline === "true" || inline === "1") flags[name] = true;
    else if (inline === "false" || inline === "0") flags[name] = false;
    else die(`parameter "${name}" must be a boolean`);
    return index + 1;
  }

  const value = inline ?? argv[index + 1];
  if (value === undefined) die(`parameter "${name}" requires a value`);
  if (spec.type === "string") {
    if (spec.values && !spec.values.includes(value)) {
      die(`parameter "${name}" must be one of: ${spec.values.join(", ")}`);
    }
    flags[name] = value;
  } else if (spec.type === "number") {
    const parsed = Number(value);
    if (!/^[+-]?(\d+\.?\d*|\.\d+)$/.test(value) || !Number.isFinite(parsed)) {
      die(`parameter "${name}" must be a number`);
    }
    if (spec.step === undefined) {
      if (parsed <= spec.min || parsed > spec.max) {
        die(`parameter "${name}" must be > ${spec.min} and <= ${spec.max}`);
      }
    } else {
      // Every rung is a power-of-two fraction, so this is exact — no epsilon.
      const rungs = [];
      for (let v = spec.min; v <= spec.max + spec.step / 2; v += spec.step) {
        rungs.push(v);
      }
      if (!rungs.includes(parsed)) {
        die(`parameter "${name}" must be one of: ${rungs.join(", ")}`);
      }
    }
    flags[name] = parsed;
  } else {
    if (!/^[+-]?\d+$/.test(value)) {
      die(`parameter "${name}" must be an integer`);
    }
    const parsed = Number(value);
    const range = spec.min === 0 ? "a non-negative integer" : `an integer >= ${spec.min}`;
    if (!Number.isSafeInteger(parsed) || parsed < spec.min || (spec.max !== undefined && parsed > spec.max)) {
      die(`parameter "${name}" must be ${range}${spec.max === undefined ? "" : ` and <= ${spec.max}`}`);
    }
    flags[name] = parsed;
  }
  return inline === undefined ? index + 2 : index + 1;
}

// ── Config + client ────────────────────────────────────────────────

interface CliConfig {
  apiKey?: string;
  baseUrl?: string;
  region?: string;
  provider?: string;
  controlBaseUrl?: string;
}

function readFileConfig(): CliConfig {
  for (const name of ["config.json", "config"]) {
    const path = join(homedir(), ".arker", name);
    if (!existsSync(path)) continue;
    try {
      return JSON.parse(readFileSync(path, "utf8")) as CliConfig;
    } catch {
      continue;
    }
  }
  return {};
}

function clientFromArgs(
  args: ParsedArgs,
  { requiresComputePlacement }: { requiresComputePlacement: boolean },
): Arker {
  const file = readFileConfig();
  const explicitBaseUrl = process.env.ARKER_BASE_URL;
  const explicitRegion =
    (args.flags.region as string | undefined) ??
    process.env.ARKER_REGION;
  const apiKey =
    process.env.ARKER_API_KEY ??
    file.apiKey;
  const baseUrl = explicitBaseUrl ?? (explicitRegion ? undefined : file.baseUrl);
  const controlBaseUrl =
    process.env.ARKER_CONTROL_BASE_URL ??
    file.controlBaseUrl;
  const provider = (args.flags.provider as string | undefined) ??
    process.env.ARKER_PROVIDER ??
    file.provider;
  const configuredRegion = explicitRegion ?? file.region;
  if (requiresComputePlacement && !baseUrl && (!provider || !configuredRegion)) {
    die(
      "Provider and region are required for compute commands. Set --provider and --region, or set ARKER_BASE_URL.",
    );
  }
  if (!apiKey) {
    die("Missing API key. Set ARKER_API_KEY or add apiKey to ~/.arker/config.json.");
  }
  const resolvedBaseUrl = baseUrl ?? (requiresComputePlacement ? undefined : controlBaseUrl ?? "https://arker.ai/api");
  return new Arker({
    apiKey,
    baseUrl: resolvedBaseUrl,
    region: configuredRegion,
    provider,
    controlBaseUrl,
  });
}

function commandRequiresComputePlacement(
  command: string,
  args: ParsedArgs,
): boolean {
  if (command === "ls" || command === "list") return false;
  if (command !== "vms") return true;
  const subcommand = args.positional[0];
  return subcommand !== undefined && subcommand !== "ls" && subcommand !== "list";
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

async function cmdRegions(args: ParsedArgs): Promise<void> {
  const file = readFileConfig();
  const response = await discoverRegions({
    controlBaseUrl: process.env.ARKER_CONTROL_BASE_URL ?? file.controlBaseUrl,
  });
  if (args.flags.json) return out(response);
  for (const placement of response.regions) {
    out(`${placement.provider}-${placement.region}`);
  }
}

async function cmdVms(args: ParsedArgs, client: Arker): Promise<void> {
  const sub = args.positional[0];
  const rest = args.positional.slice(1);
  switch (sub) {
    case undefined:
    case "ls":
    case "list": {
      const res = await client.listVms({
        provider: args.flags.provider as ListVmsParameters["provider"],
        region: args.flags.region as string | undefined,
        state: args.flags.state as "idle" | "running" | undefined,
        // Same two flags fork already takes: `--source-org-id ArkerHQ
        // --public` is the public template catalog. Without them the listing
        // stays scoped to the caller's own org.
        org_id: args.flags["source-org-id"] as string | undefined,
        public: boolFlag(args, "public"),
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
  // source-vm-name.
  const refPositional = args.positional[0];
  const srcVmIdFlag = args.flags["source-vm-id"] as string | undefined;
  const srcVmNameFlag = args.flags["source-vm-name"] as string | undefined;
  const srcOrgIdFlag = args.flags["source-org-id"] as string | undefined;
  const name = args.flags.name as string | undefined;
  const description = args.flags.description as string | undefined;
  const publicFlag = boolFlag(args, "public");

  let sourceVmId: string | undefined = srcVmIdFlag;
  let sourceVmName: string | undefined = srcVmNameFlag;
  let sourceOrgId: string | undefined = srcOrgIdFlag;

  if (!sourceVmId && !sourceVmName && refPositional) {
    // A positional source is a source VM name. Pass --source-org-id to select
    // an owner explicitly.
    sourceVmName = refPositional;
  }

  if (!sourceVmId && !sourceVmName) {
    die("usage: arker fork <vm_name> | --source-vm-id <id> | --source-vm-name <name> [--source-org-id <org>]\n" +
        "       [--platform <token[,token...]>] [--vcpu N] [--memory-mib N] [--disk-mib N]\n" +
        "       [--vgpu F] [--no-disk]");
  }

  // Hard platform pin: `--platform icelake` (or graviton2/x86_64/...) forces
  // the fork onto a machine of that compute platform and fails closed if none
  // is available — it never silently falls back to another arch. Comma-
  // separate to allow any of several platforms (e.g. `graviton2,icelake`).
  // Omit to inherit the source VM's platform set.
  const platformFlag = args.flags.platform as string | undefined;
  const platforms = platformFlag
    ?.split(",")
    .map((token) => token.trim())
    .filter((token) => token.length > 0);

  // Resource overrides — same flag names as `arker update` for consistency.
  // Folded into the contract's single `resources` object; unset fields stay
  // null so the source VM's defaults apply.
  const vcpu = numFlag(args, "vcpu");
  const memoryMib = numFlag(args, "memory-mib");
  const diskMib = numFlag(args, "disk-mib");
  const vgpu = numFlag(args, "vgpu");
  const hasResources = [vcpu, memoryMib, diskMib, vgpu]
    .some((value) => value !== undefined);
  const resources: ResourcesInput | undefined = hasResources
    ? {
        vcpu: vcpu ?? null,
        memory_mib: memoryMib ?? null,
        disk_mib: diskMib ?? null,
        vgpu: vgpu ?? null,
      }
    : undefined;

  // --no-disk forks a memory-backed VM with no persistent disk; by default the
  // service derives disk behavior from the source. Inbound reachability is intentionally not
  // exposed on the CLI yet.
  const disk = boolFlag(args, "no-disk") ? false : undefined;

  const queueingTimeout = numFlag(args, "queueing-timeout");
  const computer = await client.fork({
    sourceVmId,
    sourceVmName,
    sourceOrgId,
    name,
    description,
    public: publicFlag,
    ...(platforms && platforms.length > 0 ? { platforms } : {}),
    ...(resources ? { resources } : {}),
    ...(disk !== undefined ? { disk } : {}),
    ...(queueingTimeout !== undefined ? { queueing_timeout: queueingTimeout } : {}),
  });
  out({ vm_id: computer.id });
}

async function cmdRun(args: ParsedArgs, client: Arker): Promise<void> {
  const vmId = args.positional[0] ?? die("usage: arker run <vm_id> <command...>");
  const command = joinRemoteCommand(args.positional.slice(1));
  if (!command) die("missing command to run");
  const sessionIdx = numFlag(args, "session-idx");
  const result: RunResult = await client.vm(vmId).run(command, {
    timeout: numFlag(args, "timeout"),
    time_to_background: numFlag(args, "time-to-background"),
    queueing_timeout: numFlag(args, "queueing-timeout"),
    acquire: args.flags.acquire as string | undefined,
    release: args.flags.release as string | undefined,
    session_id: args.flags["session-id"] as string | undefined,
    ...(sessionIdx !== undefined ? { session_idx: sessionIdx } : {}),
  });
  printRunResult(result, Boolean(args.flags.json));
}

function formatMib(value: number | null | undefined): string {
  return typeof value === "number" ? `${value} MiB` : "unknown";
}

interface PrintableRun {
  type: "completed";
  runId?: string;
  state: string;
  /** The CLI writes command output through to its own stdout/stderr, so it
   * carries the exact bytes: decoding here would corrupt binary output. */
  stdout: Uint8Array;
  stderr: Uint8Array;
  exitCode: number;
  failReason?: string | null;
  memoryRequestedMib?: number | null;
  memoryAchievedMib?: number | null;
  memoryPartial?: boolean;
}

function printRunResult(result: RunResult, json: boolean): void {
  if (result.type === "background") {
    out({ run_id: result.runId, state: result.state });
    return;
  }
  printCompletedRun({ ...result, stdout: result.stdoutBytes, stderr: result.stderrBytes }, json);
}

function printStoredRun(run: RunRecord, json: boolean): void {
  if (run.state === "running") {
    out({ run_id: run.run_id, state: run.state });
    return;
  }
  printCompletedRun({
    type: "completed",
    runId: run.run_id,
    state: run.state,
    // Exact bytes — the CLI pipes them through unchanged.
    stdout: run.stdoutBytes,
    stderr: run.stderrBytes,
    exitCode: run.exit_code ?? (run.state === "completed" ? 0 : 1),
    failReason: run.fail_reason,
  }, json);
}

function printCompletedRun(result: PrintableRun, json: boolean): void {
  if (json) {
    out({
      type: result.type,
      runId: result.runId,
      state: result.state,
      stdout: Buffer.from(result.stdout).toString("base64"),
      stdoutEncoding: "base64",
      stderr: Buffer.from(result.stderr).toString("base64"),
      stderrEncoding: "base64",
      exitCode: result.exitCode,
      failReason: result.failReason,
      memoryRequestedMib: result.memoryRequestedMib,
      memoryAchievedMib: result.memoryAchievedMib,
      memoryPartial: result.memoryPartial,
    });
  } else {
    if (result.memoryPartial) {
      err(`Memory target partially applied: requested ${formatMib(result.memoryRequestedMib)}, achieved ${formatMib(result.memoryAchievedMib)}.`);
    }
    if (result.stdout.length) process.stdout.write(result.stdout);
    if (result.stderr.length) process.stderr.write(result.stderr);
    if (result.failReason) err(result.failReason);
  }
  process.exitCode = runExitCode(result.state, result.exitCode);
}

function runExitCode(state: string, exitCode: number): number {
  if (state === "failed" && exitCode === 0) return 1;
  return exitCode;
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
      printStoredRun(await client.vm(vm).getRun(runId), Boolean(args.flags.json));
      return;
    }
    case "rm":
    case "cancel": {
      const [vm, runId] = rest;
      if (!vm || !runId) die("usage: arker runs rm <vm_id> <run_id>");
      const r = await client.vm(vm).cancelRun(runId);
      if (r.cancelled) out(`cancelled ${runId}`);
      else { err("cancel failed"); process.exitCode = 1; }
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
      if (r.deleted) out(`deleted ${sid}`);
      else { err("delete failed"); process.exitCode = 1; }
      return;
    }
    case "update": {
      if (!vm) die("usage: arker sessions update <vm_id> <session_id> [--cols N] [--rows N] [--timeout-secs N]");
      const sid = rest[1] ?? die("missing session_id");
      const cols = numFlag(args, "cols");
      const rows = numFlag(args, "rows");
      const timeoutSecs = numFlag(args, "timeout-secs");
      if (cols === undefined && rows === undefined && timeoutSecs === undefined) {
        die("sessions update: pass at least one of --cols, --rows, --timeout-secs");
      }
      out(
        await client.vm(vm).updateSession(sid, {
          ...(cols !== undefined ? { cols } : {}),
          ...(rows !== undefined ? { rows } : {}),
          ...(timeoutSecs !== undefined ? { timeoutSecs } : {}),
        }),
      );
      return;
    }
    default:
      die(`usage: arker sessions <ls|get|create|rm|update> ...`);
  }
}

// Signal the foreground process group of a persistent session, which is a
// distinct operation from `run`: the service delivers the signal instead of
// executing a command.
async function cmdSignal(args: ParsedArgs, client: Arker): Promise<void> {
  const vm = args.positional[0] ?? die("usage: arker signal <vm_id> <SIGINT|SIGTERM|SIGKILL|SIGHUP> [--session-id ID] [--session-idx N]");
  const raw = args.positional[1] ?? die("missing signal");
  const signal = raw.toUpperCase();
  if (!(RUN_SIGNALS as readonly string[]).includes(signal)) {
    die(`unknown signal ${raw} (expected one of: ${RUN_SIGNALS.join(", ")})`);
  }
  const sessionId = args.flags["session-id"] as string | undefined;
  const sessionIdx = numFlag(args, "session-idx");
  const result = await client.vm(vm).signal(signal as RunSignal, {
    ...(sessionId !== undefined ? { sessionId } : {}),
    ...(sessionIdx !== undefined ? { sessionIdx } : {}),
  });
  if (args.flags.json) return out(result);
  if (result.stdout) output.write(result.stdout);
  if (result.stderr) err(result.stderr);
  process.exitCode = result.exitCode ?? 0;
}

// Deprecated alias of `arker sync <vm_id> <remote> --from <local>`, kept so
// existing scripts keep working. Recursive local -> VM directory sync: only the
// files whose contents differ are sent.
async function cmdSyncDir(args: ParsedArgs, client: Arker): Promise<void> {
  const vm = args.positional[0] ?? die("usage: arker sync-dir <vm_id> <local_dir> <remote_dir> [--assume-empty]");
  const localDir = args.positional[1] ?? die("missing local_dir");
  const remoteDir = args.positional[2] ?? die("missing remote_dir");
  if (!existsSync(localDir)) die(`no such directory: ${localDir}`);
  const result = await client.vm(vm).syncDir(localDir, remoteDir, {
    ...(args.flags["assume-empty"] ? { assumeEmpty: true } : {}),
  });
  if (args.flags.json) return out(result);
  out(`synced ${result.sent} file(s), skipped ${result.skipped}, ${result.bytesSent} byte(s) to ${remoteDir}`);
  if (result.manifestTruncated) err("warning: remote manifest was truncated; sync stayed correct but re-sent files beyond the cap");
}

// Policies are a whole-document GET/PUT, so `set` replaces the document. It is
// read from --file or stdin because PolicyDoc is nested and does not flatten
// onto argv.
async function cmdPolicies(args: ParsedArgs, client: Arker): Promise<void> {
  const sub = args.positional[0];
  const vm = args.positional[1];
  switch (sub) {
    case undefined:
    case "get": {
      if (!vm) die("usage: arker policies get <vm_id>");
      return out(await client.vm(vm).getPolicies());
    }
    case "set": {
      if (!vm) die("usage: arker policies set <vm_id> --file <doc.json>   (or pipe the document on stdin)");
      const file = args.flags.file as string | undefined;
      let raw: string;
      if (file) {
        if (!existsSync(file)) die(`no such file: ${file}`);
        raw = readFileSync(file, "utf8");
      } else if (stdinHasDataSource()) {
        raw = new TextDecoder().decode(await readAllStdin());
      } else {
        return die("provide the policy document via --file <path> or on stdin");
      }
      let doc: unknown;
      try {
        doc = JSON.parse(raw);
      } catch (err) {
        return die(`policy document is not valid JSON: ${(err as Error).message}`);
      }
      if (!doc || typeof doc !== "object" || Array.isArray(doc)) {
        return die("policy document must be a JSON object");
      }
      return out(await client.vm(vm).setPolicies(doc as PolicyDoc));
    }
    default:
      return die(`unknown policies subcommand: ${sub}. Use get|set.`);
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
      if (r.deleted) out(`deleted ${sid}`);
      else { err("delete failed"); process.exitCode = 1; }
      return;
    }
    default:
      die(`usage: arker syncs <ls|create|rm> ...  (read/write files with: arker sync)`);
  }
}

const SYNC_USAGE =
  "usage: arker sync <vm_id> <path> [data|-] [--from LOCAL] [--to LOCAL]   " +
  "(omit data to read; - or a pipe writes stdin)";

/** How long a piped-but-silent stdin is given to prove it is a writer before
 *  `arker sync` refuses to guess. Only reached when the arguments alone leave
 *  the direction open. */
const STDIN_DIRECTION_GRACE_MS = 2000;

// File I/O on a VM: read (no data), write (inline arg or piped stdin), or copy
// a local file/directory in (--from) or out (--to) — mirroring the SDK's single
// `sync()` entrypoint. Direction comes from the arguments; stdin is only
// consulted when they leave it open, and never blocks indefinitely.
async function cmdSync(args: ParsedArgs, client: Arker): Promise<void> {
  const vm = args.positional[0] ?? die(SYNC_USAGE);
  const path = args.positional[1] ?? die("missing path");
  const fromLocal = args.flags.from as string | undefined;
  const toLocal = args.flags.to as string | undefined;
  if (fromLocal && toLocal) die("pass --from or --to, not both");
  if (fromLocal) {
    if (!existsSync(fromLocal)) die(`no such file or directory: ${fromLocal}`);
    const res = await client.vm(vm).sync(path, { fromLocal });
    out(`sent ${res.sent} file(s), ${res.bytesSent} bytes to ${path} (skipped ${res.skipped})`);
    return;
  }
  if (toLocal) {
    const res = await client.vm(vm).sync(path, { toLocal });
    out(`received ${res.sent} file(s), ${res.bytesSent} bytes from ${path}`);
    return;
  }
  const inline = args.positional[2];

  const write = async (data: Uint8Array | string): Promise<void> => {
    await client.vm(vm).sync(path, data);
    const n = typeof data === "string" ? Buffer.byteLength(data) : data.length;
    out(`wrote ${n} bytes to ${path}`);
  };

  if (args.flags.read) {
    if (inline !== undefined) die("sync: --read takes no data argument");
    output.write(await client.vm(vm).sync(path));
    return;
  }
  // Explicit stdin write: the user said so, so wait as long as it takes.
  if (inline === "-") return write(await readAllStdin());
  if (inline !== undefined) return write(inline);

  switch (stdinKind()) {
    case "file":
      // A `< file` redirect is unambiguous and ends at EOF.
      return write(await readAllStdin());
    case "stream": {
      const piped = await readAllStdinWithFirstByteDeadline(STDIN_DIRECTION_GRACE_MS);
      if (piped === null) {
        return die(
          `sync: stdin is an open pipe that sent nothing in ${STDIN_DIRECTION_GRACE_MS}ms, so read-vs-write is ambiguous.\n` +
            `  to read:  arker sync ${vm} ${path} --read\n` +
            `  to write: <producer> | arker sync ${vm} ${path} -`,
        );
      }
      return write(piped);
    }
    default:
      output.write(await client.vm(vm).sync(path));
  }
}

async function cmdUpdate(args: ParsedArgs, client: Arker): Promise<void> {
  const vm = args.positional[0];
  if (!vm) die("usage: arker update <vm_id> [--description TEXT] [--memory-mib N] [--vcpu N] [--disk-mib N]");
  const memoryMib = numFlag(args, "memory-mib");
  const vcpu = numFlag(args, "vcpu");
  const diskMib = numFlag(args, "disk-mib");
  const description = args.flags.description as string | undefined;
  if (memoryMib === undefined && vcpu === undefined && diskMib === undefined && description === undefined) {
    die("update: pass at least one of --description, --memory-mib, --vcpu, --disk-mib");
  }
  const updated = await client.vm(vm).update({
    ...(description !== undefined ? { description } : {}),
    ...(memoryMib !== undefined || vcpu !== undefined || diskMib !== undefined
      ? {
          resources: {
            vcpu: vcpu ?? null,
            memory_mib: memoryMib ?? null,
            disk_mib: diskMib ?? null,
          },
        }
      : {}),
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
      if (r.deleted) out(`deleted ${id}`);
      else { err("delete failed"); process.exitCode = 1; }
      return;
    }
    default:
      die(`usage: arker fs <ls|create|get|rm> ...`);
  }
}

// ── Shell ──────────────────────────────────────────────────────────

async function cmdShell(args: ParsedArgs, client: Arker): Promise<void> {
  // Attach to an explicit VM by id (--vm-id or a positional vm id), otherwise
  // fork a fresh one from an explicit source name.
  let computer: VM;
  const vmIdArg = (args.flags["vm-id"] as string | undefined) ?? args.positional[0];
  const explicitSessionId = args.flags["session-id"] as string | undefined;
  if (!vmIdArg && explicitSessionId) {
    die("usage: arker shell <vm_id> --session-id <session_id>");
  }
  if (vmIdArg) {
    computer = await client.vm(vmIdArg).refresh();
  } else {
    const sourceVmName = args.flags["source-vm-name"] as string | undefined;
    if (!sourceVmName) {
      die("usage: arker shell <vm_id> | --source-vm-name <name> [--source-org-id <org>]");
    }
    computer = await client.fork({
      sourceVmName,
      sourceOrgId: args.flags["source-org-id"] as string | undefined,
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

// ── Helpers ────────────────────────────────────────────────────────

function numFlag(args: ParsedArgs, name: string): number | undefined {
  const v = args.flags[name];
  return typeof v === "number" ? v : undefined;
}

function boolFlag(args: ParsedArgs, name: string): boolean | undefined {
  const v = args.flags[name];
  return typeof v === "boolean" ? v : undefined;
}

function joinRemoteCommand(argv: string[]): string {
  if (argv.length === 1) return argv[0]!;
  return argv.map(shellQuote).join(" ");
}

function shellQuote(value: string): string {
  if (/^[A-Za-z0-9_@%+=:,./-]+$/.test(value)) return value;
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}

async function readAllStdin(): Promise<Uint8Array> {
  const chunks: Buffer[] = [];
  for await (const chunk of input) chunks.push(chunk as Buffer);
  return new Uint8Array(Buffer.concat(chunks));
}

/** How stdin is attached. This is the only thing that can disambiguate a bare
 *  `arker sync <vm> <path>`: read the file back, or write what is piped in.
 *
 *  The distinction that matters is whether draining is guaranteed to finish.
 *  A `< file` redirect ends at EOF. A pipe or socket does not: a script that
 *  inherits stdin from a parent nobody ever closes hands us a descriptor that
 *  stays open forever, and draining it blocks with no output and no error. */
function stdinKind(): "tty" | "file" | "stream" | "none" {
  if (input.isTTY) return "tty";
  try {
    const stat = fstatSync(0);
    if (stat.isFile()) return "file";
    if (stat.isFIFO() || stat.isSocket()) return "stream";
    return "none";
  } catch {
    return "none";
  }
}

function stdinHasDataSource(): boolean {
  const kind = stdinKind();
  return kind === "file" || kind === "stream";
}

/** Drain stdin, giving up if the FIRST byte never arrives. Returns null when
 *  nothing had been read by the deadline — the descriptor is idle and the
 *  caller cannot tell read from write. Once any data arrives the remainder is
 *  read unbounded: a slow producer is legitimate, a silent one is not
 *  actionable. */
async function readAllStdinWithFirstByteDeadline(ms: number): Promise<Uint8Array | null> {
  const chunks: Buffer[] = [];
  const drained = (async () => {
    for await (const chunk of input) chunks.push(chunk as Buffer);
  })();
  const deadline = new Promise<"deadline">((resolve) => {
    const timer = setTimeout(() => resolve("deadline"), ms);
    if (typeof timer.unref === "function") timer.unref();
  });
  const first = await Promise.race([drained.then(() => "drained" as const), deadline]);
  if (first === "deadline" && chunks.length === 0) return null;
  await drained;
  return new Uint8Array(Buffer.concat(chunks));
}

// ── Per-command help ───────────────────────────────────────────────

// Placeholder + one-line description per flag. Flag names are consistent
// across commands, so one table covers them all; the flags actually shown
// for a command are read from COMMAND_OPTIONS, which keeps this honest when
// a command gains an option.
const OPTION_HELP: Record<string, { placeholder?: string; desc: string }> = {
  acquire: { placeholder: "<list>", desc: "warm resources before the run (cpu,memory,disk)" },
  "assume-empty": { desc: "skip the remote manifest; treat the destination as empty" },
  "cancel-ttl": { placeholder: "<seconds>", desc: "grace period before a disconnected PTY is reaped" },
  cols: { placeholder: "<n>", desc: "initial terminal width" },
  command: { placeholder: "<path>", desc: "shell executable path (default: /bin/bash)" },
  cursor: { placeholder: "<cursor>", desc: "continue from a previous page's next_cursor" },
  cwd: { placeholder: "<path>", desc: "working directory for the session" },
  description: { placeholder: "<text>", desc: "short description for the VM (empty clears it)" },
  "disk-mib": { placeholder: "<n>", desc: "disk size in MiB" },
  file: { placeholder: "<path>", desc: "read the policy document from this file" },
  "filesystem-id": { placeholder: "<id>", desc: "filter by filesystem" },
  from: { placeholder: "<local>", desc: "upload this local file or directory into the VM" },
  "gpu-sms": { placeholder: "<n>", desc: "GPU SM count, in hardware units" },
  "gpu-vram-mib": { placeholder: "<n>", desc: "GPU VRAM in MiB, in hardware units" },
  help: { desc: "show help without connecting" },
  json: { desc: "emit JSON instead of tabular output" },
  limit: { placeholder: "<n>", desc: "max rows to return (1-1000)" },
  "memory-mib": { placeholder: "<n>", desc: "memory in MiB" },
  name: { placeholder: "<name>", desc: "name for the new resource, scoped to your org" },
  "name-prefix": { placeholder: "<prefix>", desc: "filter by name prefix" },
  "no-disk": { desc: "fork a memory-backed (nodisk) VM" },
  "no-persist": { desc: "close the remote PTY process on disconnect" },
  path: { placeholder: "<path>", desc: "filter by guest path" },
  persist: { desc: "keep the remote PTY process alive on disconnect" },
  platform: { placeholder: "<token[,token...]>", desc: "pin to a compute platform (e.g. icelake, graviton2)" },
  provider: { placeholder: "<provider>", desc: "compute provider (or env ARKER_PROVIDER)" },
  public: { desc: "restrict the listing to public VMs" },
  "queueing-timeout": { placeholder: "<seconds>", desc: "queue up to this long instead of failing fast" },
  read: { desc: "read the file, ignoring stdin" },
  region: { placeholder: "<region>", desc: "service region (or env ARKER_REGION)" },
  release: { placeholder: "<list>", desc: "release resources after the run (cpu,memory,disk)" },
  rows: { placeholder: "<n>", desc: "initial terminal height" },
  "session-id": { placeholder: "<ulid>", desc: "target a specific existing session" },
  "session-idx": { placeholder: "<n>", desc: "target the session at this index (default 0)" },
  "source-org-id": { placeholder: "<org>", desc: "list that org's VMs (only ArkerHQ, with --public)" },
  "source-vm-id": { placeholder: "<id>", desc: "fork by global source VM id" },
  "source-vm-name": { placeholder: "<name>", desc: "fork by source VM name" },
  state: { desc: "filter by lifecycle state" },
  timeout: { placeholder: "<seconds>", desc: "exec/kill bound in seconds (omitted or 0 = unbounded)" },
  "time-to-background": { placeholder: "<seconds>", desc: "sync window; 0 returns a run id immediately (default 120)" },
  to: { placeholder: "<local>", desc: "download the VM path to this local file or directory" },
  vcpu: { placeholder: "<n>", desc: "vCPU count" },
  vgpu: { placeholder: "<fraction>", desc: "GPU size in eighths of a card (0.125 - 1)" },
  "vm-id": { placeholder: "<id>", desc: "target VM by global id" },
};

// Flags every command shares; pushed below the command's own flags so the
// interesting ones are read first.
const COMMON_FLAG_ORDER = ["region", "provider", "cursor", "limit", "json", "help"];

interface CommandHelp {
  synopsis: string[];
  summary: string;
  subs?: Record<string, string>;
  notes?: string[];
}

const COMMAND_HELP: Record<string, CommandHelp> = {
  filesystems: {
    synopsis: ["arker filesystems <ls|create|get|rm> [args] [flags]"],
    summary: "Manage filesystems. Alias: arker fs.",
    subs: {
      ls: "list filesystems",
      create: "create a filesystem",
      get: "show one filesystem",
      rm: "delete a filesystem",
    },
  },
  fork: {
    synopsis: [
      "arker fork <vm_name> [flags]",
      "arker fork --source-vm-id <id> [flags]",
      "arker fork --source-vm-name <name> --source-org-id <org> [flags]",
    ],
    summary: "Fork a source VM into a new VM.",
    notes: ["Resource flags are capped by the source VM's max_vcpus / max_memory_mib / max_disk_mib."],
  },
  list: {
    synopsis: ["arker ls [flags]"],
    summary: "List VMs. Aggregates across every region unless --region or --provider narrows it.",
    notes: [
      "Without --limit the listing stops at the first page and prints a trailing",
      "'# next_cursor=<n>' line; pass --limit (max 1000) or --cursor to page further.",
    ],
  },
  policies: {
    synopsis: ["arker policies <get|set> <vm_id> [flags]"],
    summary: "Read or replace a VM's policy document.",
    subs: { get: "show the current policy document", set: "replace it (use --file)" },
  },
  regions: {
    synopsis: ["arker regions [flags]"],
    summary: "List available public placements (provider + region + endpoint).",
  },
  rm: {
    synopsis: ["arker rm <vm> [flags]"],
    summary: "Delete a VM.",
  },
  run: {
    synopsis: ["arker run [flags] <vm> <command> [args...]"],
    summary: "Run a command in a VM session.",
    notes: [
      "CLI options must appear before <command>; subsequent flags are passed to the",
      "remote command. Use -- before <command> when it itself begins with a dash.",
    ],
  },
  runs: {
    synopsis: ["arker runs <ls|get|rm> <vm_id> [args] [flags]"],
    summary: "Inspect or cancel runs on a VM.",
    subs: { ls: "list runs", get: "show one run", rm: "cancel a run" },
  },
  sessions: {
    synopsis: ["arker sessions <ls|get|create|rm|update> <vm_id> [args] [flags]"],
    summary: "Manage a VM's shell sessions.",
    subs: {
      ls: "list sessions",
      get: "show one session",
      create: "create a session",
      rm: "delete a session",
      update: "update a session's cwd/size",
    },
  },
  shell: {
    synopsis: ["arker shell <vm_id> [flags]", "arker shell --source-vm-name <name> [flags]"],
    summary: "Open a native PTY shell, optionally forking a source VM first.",
  },
  signal: {
    synopsis: ["arker signal <vm_id> <SIGINT|SIGTERM|SIGKILL|SIGHUP> [flags]"],
    summary: "Signal a session's foreground process group.",
  },
  sync: {
    synopsis: [
      "arker sync <vm_id> <path> [data|-] [flags]",
      "arker sync <vm_id> <path> --from <local> [flags]",
      "arker sync <vm_id> <path> --to <local> [flags]",
    ],
    summary: "Move files between the VM and here: read, write, upload or download.",
    notes: [
      "--from uploads a local file or directory into <path>; --to downloads <path>",
      "out to a local file or directory. Without either, <path> is read (no data)",
      "or written (data argument, '-', or piped stdin).",
    ],
  },
  "sync-dir": {
    synopsis: ["arker sync-dir <vm_id> <local> <remote> [flags]"],
    summary: "Deprecated: use 'arker sync <vm_id> <remote> --from <local>'.",
  },
  syncs: {
    synopsis: ["arker syncs <ls|create|rm> <vm_id> [args] [flags]"],
    summary: "Manage a VM's sync mounts.",
    subs: { ls: "list syncs", create: "create a sync", rm: "delete a sync" },
  },
  update: {
    synopsis: ["arker update <vm> [flags]"],
    summary: "Update a VM's description or resource allocation.",
  },
  vms: {
    synopsis: ["arker vms <ls|get|rm|fork|run|update> [args] [flags]"],
    summary: "Full VM resource surface; the shortcuts (ls, rm, fork, run, update) call into it.",
    subs: {
      ls: "list VMs",
      get: "show one VM",
      rm: "delete a VM",
      fork: "fork a VM",
      run: "run a command",
      update: "update a VM",
    },
  },
};

// Shortcut commands share their help entry with the resource they alias.
const HELP_ALIASES: Record<string, string> = { delete: "rm", fs: "filesystems", ls: "list" };

function resolveHelpKey(command: string): string {
  return HELP_ALIASES[command] ?? command;
}

function optionPlaceholder(name: string, spec: OptionSpec): string {
  if (spec.type === "boolean") return "";
  if (spec.type === "string" && spec.values) return `<${spec.values.join("|")}>`;
  return OPTION_HELP[name]?.placeholder ?? (spec.type === "string" ? "<value>" : "<n>");
}

function optionLine(name: string, spec: OptionSpec): string {
  const flag = name === "help" ? "-h, --help" : `--${name}`;
  const left = `  ${flag} ${optionPlaceholder(name, spec)}`.trimEnd();
  const desc = OPTION_HELP[name]?.desc ?? "";
  if (!desc) return left;
  return left.padEnd(34) + " " + desc;
}

function commandUsage(command: string, sub?: string): string[] {
  const key = resolveHelpKey(command);
  const help = COMMAND_HELP[key]!;
  const specs = COMMAND_OPTIONS[command] ?? COMMAND_OPTIONS[key] ?? {};
  const names = Object.keys(specs);
  const own = names.filter((n) => !COMMON_FLAG_ORDER.includes(n)).sort();
  const common = COMMON_FLAG_ORDER.filter((n) => names.includes(n));

  const lines = [`arker v${VERSION}`, "", "Usage:"];
  for (const line of help.synopsis) lines.push(`  ${line}`);
  lines.push("", help.summary);

  if (sub && help.subs?.[sub]) {
    lines.push("", `Subcommand '${sub}': ${help.subs[sub]}`);
  } else if (help.subs) {
    lines.push("", "Subcommands:");
    for (const [name, desc] of Object.entries(help.subs)) {
      lines.push(`  ${name.padEnd(8)} ${desc}`);
    }
  }

  if (own.length || common.length) {
    lines.push("", "Flags:");
    for (const name of [...own, ...common]) lines.push(optionLine(name, specs[name]!));
  }

  if (help.notes?.length) {
    lines.push("");
    for (const note of help.notes) lines.push(note);
  }

  lines.push("", "Run 'arker --help' for the full command list.");
  return lines;
}

function usage(command?: string, sub?: string): void {
  if (command && COMMAND_HELP[resolveHelpKey(command)]) {
    out(commandUsage(command, sub).join("\n"));
    return;
  }
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
      "  arker fork <vm_name>                           fork by source VM name",
      "  arker fork --source-vm-id <id>                 fork by global id",
      "  arker fork --source-vm-name <n> --source-org-id <org>",
      "                                                 fork by name in another org",
      "  arker fork <vm> [--vcpu N] [--memory-mib N] [--disk-mib N] [--no-disk]",
      "                                                 fork with resource overrides",
      "  arker fork <vm> --platform <token[,token...]>  pin the fork to a compute platform",
      "                                                 (e.g. icelake, graviton2; fails closed)",
      "  arker fork <vm> --vgpu 0.25                    size the GPU in eighths of a card (0.125 … 1)",
      "  arker run [flags] <vm> <command> [args...]     run a command",
      "  arker update <vm> [--description TEXT] [--memory-mib N] [--vcpu N] [--disk-mib N]",
      "  arker shell <vm_id>                            native PTY shell",
      "  arker shell --source-vm-name <name>            fork a source, then open a shell",
      "",
      "Resources:",
      "  arker regions                                  list available public placements",
      "  arker vms         <ls|get|rm|fork|run|update> ...",
      "  arker vms ls --source-org-id ArkerHQ --public  list the public VM catalog",
      "  arker runs        <ls|get|rm> <vm_id> ...",
      "  arker sessions    <ls|get|create|rm|update> <vm_id> ...",
      "  arker syncs       <ls|create|rm> <vm_id> ...",
      "  arker filesystems <ls|create|get|rm> ...   (alias: fs)",
      "  arker sync <vm_id> <path> [data|-]          read a file, or write data/stdin",
      "  arker sync <vm_id> <path> --read            read a file, ignoring stdin",
      "  arker sync <vm_id> <path> --from <local>    upload a local file or directory",
      "  arker sync <vm_id> <path> --to <local>      download a file or directory",
      "  arker sync-dir <vm_id> <local> <remote>     deprecated: use sync --from",
      "  arker signal <vm_id> <SIGINT|SIGTERM|SIGKILL|SIGHUP>",
      "                                              signal a session's foreground group",
      "",
      "Flags:",
      "  --region <region>          (or env ARKER_REGION)",
      "  --provider <provider>      (or env ARKER_PROVIDER)",
      "  --json                     emit JSON instead of tabular output",
      "  -h, --help                 show help without connecting",
      "  -v, --version              show version without connecting",
      "",
      "List flags (arker vms ls):",
      "  --source-org-id <org>      list that org's VMs (only ArkerHQ, with --public)",
      "  --public                   restrict the listing to public VMs",
      "  --state <idle|running>     filter by VM state",
      "",
      "Fork flags:",
      "  --description <text>       short description for the new VM",
      "  --vcpu <n>                 vCPU count for the new VM (capped by source max_vcpus)",
      "  --memory-mib <n>           memory (MiB) for the new VM",
      "  --disk-mib <n>             disk size (MiB) for the new VM",
      "  --no-disk                  fork a memory-backed VM with no disk",
      "",
      "Update flags:",
      "  --description <text>       replace the VM description (empty clears it)",
      "",
      "Run flags:",
      "  --session-id <ulid>        run in a specific existing session",
      "  --session-idx <n>          run in the session at this index (default 0)",
      "  --timeout <seconds>             exec/kill bound in seconds (omitted or 0 = unbounded)",
      "  --time-to-background <seconds>  sync window; 0 returns a run id immediately (default 120)",
      "  --queueing-timeout <seconds>    queue up to this long instead of failing fast (also a fork flag)",
      "  --acquire <list>           warm resources before the run (cpu,memory,disk)",
      "  --release <list>           release resources after the run (cpu,memory,disk)",
      "",
      "CLI options must appear before <command>; subsequent flags are passed to the remote command.",
      "Use -- before <command> when the executable itself begins with a dash.",
      "",
      "Resource flags:",
      "  --cursor <cursor> --limit <n>               paginate list commands",
      "  sessions: --cwd <path> --state <state>",
      "  syncs: --filesystem-id <id> --path <path>",
      "  filesystems: --name <name> --name-prefix <prefix>",
      "",
      "Shell flags:",
      "  --session-id <id>          reconnect to an existing PTY session",
      "  --command <path>           shell executable path (default: /bin/bash)",
      "  --cols <n> --rows <n>      initial terminal size",
      "  --no-persist               close the remote PTY process on disconnect",
    ].join("\n"),
  );
}

// ── Entry ──────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const invocation = parseInvocation(process.argv.slice(2));
  if ("type" in invocation) {
    if (invocation.type === "version") out(`arker ${VERSION}`);
    else usage(invocation.command, invocation.sub);
    return;
  }
  const { command: cmd, args } = invocation;

  try {
    if (cmd === "regions") return await cmdRegions(args);
    const client = clientFromArgs(args, {
      requiresComputePlacement: commandRequiresComputePlacement(cmd, args),
    });
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
      case "signal":
        return await cmdSignal(args, client);
      case "sync":
        return await cmdSync(args, client);
      case "sync-dir":
        return await cmdSyncDir(args, client);
      case "syncs":
        return await cmdSyncs(args, client);
      case "policies":
        return await cmdPolicies(args, client);
      case "shell":
        return await cmdShell(args, client);
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
      err(e.message);
      process.exit(1);
    }
    throw e;
  }
}

void main();
