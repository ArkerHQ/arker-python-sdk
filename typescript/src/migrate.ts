/**
 * Command migration: move a running command (by PID) into an Arker VM.
 *
 * This is the config-driven engine — every command-specific detail lives in
 * `command_migration.json` (bundled alongside this module and loaded here),
 * so the same recipes drive the Python, TypeScript, and CLI SDKs and adding a
 * command is a config entry, not code in three languages. Keep
 * `typescript/src/command_migration.json` byte-identical to the canonical
 * copy at `python/src/arker/command_migration.json` — `tests/migrate.ts`
 * diffs the two against each other when both are present on disk (i.e. in a
 * monorepo checkout) and fails the build if they drift.
 *
 * No CRIU: we sync the command's working dir + its on-disk resumable
 * transcript and re-invoke the command's own resume entrypoint in the VM.
 * Works for any command that (a) persists a transcript and (b) can resume
 * from it.
 *
 * Node-only: it reads `/proc`, the local filesystem, and sends POSIX signals
 * — the same constraint {@link VM.syncDir} already carries.
 */
import { existsSync, readFileSync, readdirSync, readlinkSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join, relative } from "node:path";

import migrationConfigJson from "./command_migration.json";
import type { Arker, VM } from "./index.js";

// ── Recipe shape (mirrors command_migration.json's own `recipe_schema`) ────

export interface DetectSpec {
  argv_contains?: string;
  argv_regex?: string;
}

export type SessionIdSpec = "stem" | "session_path" | { regex: string };

export interface SessionSpec {
  glob: string;
  pick?: "newest_mtime" | "oldest_mtime";
  id?: SessionIdSpec;
}

export type PlaceSpec = string | { verbatim_under: string; from_host_root: string };

export interface CommandSpec {
  detect: DetectSpec;
  session: SessionSpec;
  requires?: Record<string, unknown>;
  install: string;
  place: PlaceSpec;
  extra_files?: Record<string, { json: unknown }>;
  env?: Record<string, string>;
  resume: string;
  keys?: string[];
}

export interface MigrationConfig {
  version: number;
  kind: string;
  description: string;
  quiesce?: { stable_secs?: number; timeout_secs?: number };
  commands: Record<string, CommandSpec>;
}

/** The parsed recipe map. esbuild/tsup inline the JSON at bundle time (and
 * Bun/tsc read it straight off disk under `bun test`/`tsc`), so there is no
 * runtime file lookup to get wrong across the ESM/CJS dual build. */
export function loadConfig(): MigrationConfig {
  return migrationConfigJson as unknown as MigrationConfig;
}

// ── Small pure helpers — exported for direct unit testing, mirroring the
// underscore-prefixed-but-still-imported helpers in python/src/arker/migrate.py ──

export function cwdKey(cwd: string): string {
  return cwd.replace(/[^A-Za-z0-9]/g, "-");
}

// Prefer $HOME over os.homedir(): Python's os.path.expanduser (what this
// mirrors) checks $HOME first and only falls back to the pwd database if it's
// unset, and some JS runtimes cache os.homedir() at process start rather than
// re-reading $HOME — which would make it deaf to a test (or a caller) that
// points HOME elsewhere for the lifetime of one call.
function expandHome(p: string): string {
  const home = process.env.HOME || homedir();
  if (p === "~") return home;
  if (p.startsWith("~/")) return join(home, p.slice(2));
  return p;
}

export function subst(template: string, vars: Record<string, string>): string {
  let out = template;
  for (const [k, v] of Object.entries(vars)) {
    out = out.split(`\${${k}}`).join(v);
  }
  return expandHome(out);
}

export function detectCommand(argv: string, spec: DetectSpec): boolean {
  if (spec.argv_contains !== undefined) return argv.includes(spec.argv_contains);
  if (spec.argv_regex !== undefined) return new RegExp(spec.argv_regex).test(argv);
  return false;
}

function stem(path: string): string {
  const base = basename(path);
  const dot = base.lastIndexOf(".");
  return dot > 0 ? base.slice(0, dot) : base;
}

/**
 * Minimal glob supporting exactly what the recipes need: `*` (any chars
 * within one path segment) and `**` (zero or more directories), matching
 * Python's `glob.glob(pattern, recursive=True)` semantics for these two
 * wildcards. No brace expansion, no `?`, no character classes — recipes
 * don't use them, and by the time a pattern reaches here every `${...}`
 * placeholder has already been substituted with a literal (non-wildcard)
 * value, so there's nothing else to support.
 */
function globSync(pattern: string): string[] {
  const expanded = expandHome(pattern);
  const isAbsolute = expanded.startsWith("/");
  const segments = expanded.split("/").filter((s) => s.length > 0);
  const results: string[] = [];

  function segmentRegex(seg: string): RegExp {
    const escaped = seg.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*");
    return new RegExp(`^${escaped}$`);
  }

  function walk(base: string, segIdx: number): void {
    if (segIdx === segments.length) {
      results.push(base);
      return;
    }
    const seg = segments[segIdx]!;
    let entries: string[];
    try {
      entries = readdirSync(base);
    } catch {
      return;
    }
    if (seg === "**") {
      // `**` matches zero directories too: try the rest of the pattern here...
      walk(base, segIdx + 1);
      // ...and one-or-more, by recursing into every subdirectory while still
      // consuming `**`.
      for (const entry of entries) {
        const full = join(base, entry);
        let isDir: boolean;
        try {
          isDir = statSync(full).isDirectory();
        } catch {
          continue;
        }
        if (isDir) walk(full, segIdx);
      }
      return;
    }
    const re = segmentRegex(seg);
    const isLast = segIdx === segments.length - 1;
    for (const entry of entries) {
      if (!re.test(entry)) continue;
      const full = join(base, entry);
      if (isLast) {
        results.push(full);
        continue;
      }
      let isDir: boolean;
      try {
        isDir = statSync(full).isDirectory();
      } catch {
        continue;
      }
      if (isDir) walk(full, segIdx + 1);
    }
  }

  walk(isAbsolute ? "/" : ".", 0);
  return results;
}

export function findSession(
  spec: SessionSpec,
  vars: Record<string, string>,
): [path: string | null, sessionId: string | null] {
  const pattern = subst(spec.glob, vars);
  const matches = globSync(pattern)
    .map((p) => {
      try {
        return { p, mtime: statSync(p).mtimeMs };
      } catch {
        return null;
      }
    })
    .filter((m): m is { p: string; mtime: number } => m !== null)
    .sort((a, b) => a.mtime - b.mtime);
  if (matches.length === 0) return [null, null];
  // `matches` is sorted by mtime ascending; newest_mtime (default) is the
  // last entry, oldest_mtime the first.
  const chosen = spec.pick === "oldest_mtime" ? matches[0]! : matches[matches.length - 1]!;
  const idSpec = spec.id ?? "stem";
  let sessionId: string;
  if (idSpec === "stem") {
    sessionId = stem(chosen.p);
  } else if (idSpec === "session_path") {
    sessionId = chosen.p;
  } else if (typeof idSpec === "object" && "regex" in idSpec) {
    const m = new RegExp(idSpec.regex).exec(basename(chosen.p));
    sessionId = m ? m[1]! : stem(chosen.p);
  } else {
    sessionId = stem(chosen.p);
  }
  return [chosen.p, sessionId];
}

// ── /proc introspection ─────────────────────────────────────────────

export interface DiscoverResult {
  cwd: string;
  command: string | null;
  environ: Record<string, string>;
  sessionPath: string | null;
  sessionId: string | null;
}

/** Inspect `/proc/<pid>` and match it to a recipe. Returns the migration plan. */
export function discover(pid: number): DiscoverResult {
  const cfg = loadConfig();
  const cwd = readlinkSync(`/proc/${pid}/cwd`);
  const argv = readFileSync(`/proc/${pid}/cmdline`, "utf8")
    .split("\0")
    .filter((s) => s.length > 0)
    .join(" ")
    .toLowerCase();
  const environ: Record<string, string> = {};
  for (const entry of readFileSync(`/proc/${pid}/environ`, "utf8").split("\0")) {
    const eq = entry.indexOf("=");
    if (eq > -1) environ[entry.slice(0, eq)] = entry.slice(eq + 1);
  }
  const command =
    Object.entries(cfg.commands).find(([, spec]) => detectCommand(argv, spec.detect))?.[0] ?? null;
  let sessionPath: string | null = null;
  let sessionId: string | null = null;
  if (command !== null) {
    const vars = { cwd, cwd_key: cwdKey(cwd) };
    [sessionPath, sessionId] = findSession(cfg.commands[command]!.session, vars);
  }
  return { cwd, command, environ, sessionPath, sessionId };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Wait until the transcript stops growing (in-flight turn flushed). True if
 * it settled, false if `timeoutSecs` elapsed first. */
export async function quiesce(
  sessionPath: string | null,
  timeoutSecs?: number,
  stableSecs?: number,
): Promise<boolean> {
  const cfg = loadConfig().quiesce ?? {};
  const timeout = (timeoutSecs ?? cfg.timeout_secs ?? 30) * 1000;
  const stable = (stableSecs ?? cfg.stable_secs ?? 2.0) * 1000;
  if (!sessionPath || !existsSync(sessionPath)) return true;
  let last = -1;
  let stableAt: number | null = null;
  const t0 = Date.now();
  while (Date.now() - t0 < timeout) {
    const size = statSync(sessionPath).size;
    if (size === last) {
      if (stableAt !== null && Date.now() - stableAt >= stable) return true;
    } else {
      last = size;
      stableAt = Date.now();
    }
    await sleep(400);
  }
  return false;
}

// ── migrate() ──────────────────────────────────────────────────────

export interface MigrateOptions {
  pid: number;
  source?: string;
  memoryMib?: number;
  doQuiesce?: boolean;
  freezeLocal?: boolean;
  killLocal?: boolean;
  probe?: string;
  keys?: Record<string, string>;
}

export interface MigrateResult {
  vm: VM;
  command: string;
  output: string;
}

/**
 * Migrate the running command at `pid` into a fresh Arker VM and resume it.
 *
 * Purely client-side: uses the SDK's fork + sync + syncDir + run under the
 * hood — no special server route. Mirrors `python/src/arker/migrate.py`'s
 * `migrate()` step for step.
 */
export async function migrate(client: Arker, options: MigrateOptions): Promise<MigrateResult> {
  const {
    pid,
    source = "ubuntu-small",
    memoryMib = 2048,
    doQuiesce = true,
    freezeLocal = false,
    killLocal = false,
    probe = "In one short line: what were you last doing?",
    keys,
  } = options;

  const cfg = loadConfig();
  const info = discover(pid);
  const { command, cwd, environ } = info;
  if (command === null) {
    throw new Error(
      `pid ${pid} is not a recognized migratable command (no matching recipe in command_migration.json)`,
    );
  }
  const spec = cfg.commands[command]!;
  const sessionId = info.sessionId;
  const sessionPath = info.sessionPath;
  const vars: Record<string, string> = {
    cwd,
    cwd_key: cwdKey(cwd),
    session_id: sessionId ?? "",
    probe: JSON.stringify(probe),
  };

  if (doQuiesce) {
    // Completed turns are on disk regardless of whether this settles before
    // its timeout; only the current unflushed turn is at risk either way, so
    // the result is intentionally not checked — same as the Python engine.
    await quiesce(sessionPath);
  }
  if (freezeLocal) {
    process.kill(pid, "SIGSTOP");
  }

  const vm = await client.fork(source, { resources: { memory_mib: memoryMib } });
  await vm.run(`mkdir -p ${cwd}`);
  await vm.syncDir(cwd, cwd.replace(/^\/+/, ""));
  await vm.run(spec.install);

  // Place the transcript.
  if (sessionPath && existsSync(sessionPath)) {
    const place = spec.place;
    let dest: string;
    if (typeof place === "object" && "verbatim_under" in place) {
      const root = expandHome(place.from_host_root);
      dest = `${place.verbatim_under}/${relative(root, sessionPath)}`;
    } else {
      dest = subst(place, vars);
    }
    await vm.sync(dest, readFileSync(sessionPath));
  }

  // Extra config files (resolve placeholders inside the JSON).
  for (const [vmPathTemplate, body] of Object.entries(spec.extra_files ?? {})) {
    if ("json" in body) {
      const raw = subst(JSON.stringify(body.json), vars);
      await vm.sync(subst(vmPathTemplate, vars), raw);
    }
  }

  // Forward keys (explicit override wins over discovered environ) + recipe env.
  //
  // NOTE: auto-discovery only ever forwards environment VARIABLES present in
  // the source process's /proc/<pid>/environ. Tools whose default login flow
  // stores credentials in a FILE instead (e.g. Claude Code's interactive
  // `claude login`, which writes ~/.claude/.credentials.json rather than
  // setting ANTHROPIC_API_KEY) are invisible to this mechanism no matter what
  // is added to a recipe's `keys` list — there is nothing in environ to find.
  // That case has no automatic path today; the caller must pass an explicit
  // `keys` override (e.g. a `claude setup-token`-minted CLAUDE_CODE_OAUTH_TOKEN)
  // to authenticate the resumed process in the VM.
  const keyEnv =
    keys ??
    Object.fromEntries((spec.keys ?? []).filter((k) => environ[k]).map((k) => [k, environ[k]!]));
  const procEnv = { ...(spec.env ?? {}), ...keyEnv };

  const session = await vm.createSession({ env: procEnv, cwd });
  const result = await vm.run(subst(spec.resume, vars), {
    session_id: session.session_id,
    timeout: 180,
  });
  const output = result.type === "completed" ? result.stdout : "";

  if (killLocal) {
    try {
      process.kill(pid, "SIGTERM");
    } catch {
      // Already gone — fine, that was the goal.
    }
  }

  return { vm, command, output };
}
