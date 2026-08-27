/**
 * Unit tests for src/migrate.ts — the config-driven command-migration
 * engine. Mirrors python/tests/test_migrate.py test-for-test where the
 * mechanism is the same (real files on disk, a real spawned process
 * introspected through real /proc — mocking those away would just test the
 * mock), and uses this codebase's own convention (a real `Arker` backed by a
 * scripted fetch) for the network-touching migrate() tests instead of a
 * hand-rolled duck-typed client.
 */
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Arker } from "../src/index.js";
import {
  cwdKey,
  detectCommand,
  discover,
  findSession,
  loadConfig,
  migrate,
  quiesce,
  subst,
} from "../src/migrate.js";

// ── HOME scoping ─────────────────────────────────────────────────────
// migrate.ts resolves `~` via node:os homedir(), which on POSIX reads $HOME.
// These tests run in-process (unlike the fake commands they introspect via
// /proc, which are real subprocesses), so pointing discovery at a scratch
// session tree means temporarily overriding this process's own HOME.

async function withHome<T>(dir: string, fn: () => Promise<T> | T): Promise<T> {
  const saved = process.env.HOME;
  process.env.HOME = dir;
  try {
    return await fn();
  } finally {
    if (saved === undefined) delete process.env.HOME;
    else process.env.HOME = saved;
  }
}

function mkTmp(): string {
  return mkdtempSync(join(tmpdir(), "arker-migrate-test-"));
}

function touch(path: string, mtimeMs: number): void {
  writeFileSync(path, "{}");
  const seconds = mtimeMs / 1000;
  utimesSync(path, seconds, seconds);
}

// ── detectCommand ────────────────────────────────────────────────────

function testDetectArgvContains(): void {
  assert.ok(detectCommand("node /usr/local/bin/claude --resume abc", { argv_contains: "claude" }));
  assert.ok(!detectCommand("node /usr/local/bin/codex", { argv_contains: "claude" }));
}

function testDetectArgvRegex(): void {
  const spec = { argv_regex: String.raw`(^|/|\s)pi(\s|$)` };
  assert.ok(detectCommand("/usr/bin/pi --provider anthropic", spec));
  assert.ok(!detectCommand("/usr/bin/pip install foo", spec));
  assert.ok(!detectCommand("/usr/bin/piano", spec));
}

function testDetectNoRecognizedKeyReturnsFalse(): void {
  assert.ok(!detectCommand("literally anything", {}));
}

// ── cwdKey ───────────────────────────────────────────────────────────

function testCwdKeyMatchesClaudeCodesOwnDirectoryConvention(): void {
  // The exact ~/.claude/projects/<key> naming Claude Code itself uses.
  assert.equal(cwdKey("/home/user/my-project"), "-home-user-my-project");
  assert.equal(cwdKey("/a/b.c_d"), "-a-b-c-d");
}

// ── subst ────────────────────────────────────────────────────────────

async function testSubstReplacesPlaceholdersAndExpandsHome(): Promise<void> {
  const home = mkTmp();
  try {
    await withHome(home, () => {
      const out = subst("~/foo/${a}/${b}.txt", { a: "1", b: "2" });
      assert.equal(out, join(home, "foo", "1", "2.txt"));
    });
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
}

function testSubstLeavesUnmatchedPlaceholdersUntouched(): void {
  const out = subst("${known}-${unknown}", { known: "x" });
  assert.equal(out, "x-${unknown}");
}

// ── findSession ──────────────────────────────────────────────────────

async function testFindSessionPicksNewestByDefault(): Promise<void> {
  const dir = mkTmp();
  try {
    const now = Date.now();
    const a = join(dir, "a.jsonl");
    const b = join(dir, "b.jsonl");
    touch(a, now - 100_000);
    touch(b, now - 10_000);
    const [path, sid] = findSession({ glob: join(dir, "*.jsonl") }, {});
    assert.equal(path, b);
    assert.equal(sid, "b");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

async function testFindSessionPickOldestMtime(): Promise<void> {
  // Same shape as the Python regression test for "pick" actually mattering:
  // pin that oldest_mtime returns the OLDEST match, not the newest.
  const dir = mkTmp();
  try {
    const now = Date.now();
    const a = join(dir, "a.jsonl");
    const b = join(dir, "b.jsonl");
    touch(a, now - 100_000);
    touch(b, now - 10_000);
    const [path, sid] = findSession({ glob: join(dir, "*.jsonl"), pick: "oldest_mtime" }, {});
    assert.equal(path, a);
    assert.equal(sid, "a");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

async function testFindSessionIdRegex(): Promise<void> {
  const dir = mkTmp();
  try {
    const name = "rollout-2026-08-25T12-00-00-abc12345-6789-4abc-9def-0123456789ab.jsonl";
    const p = join(dir, name);
    writeFileSync(p, "{}");
    const spec = {
      glob: join(dir, "*.jsonl"),
      id: { regex: String.raw`rollout-.*?-([0-9a-fA-F-]{36})\.jsonl$` },
    };
    const [path, sid] = findSession(spec, {});
    assert.equal(path, p);
    assert.equal(sid, "abc12345-6789-4abc-9def-0123456789ab");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

async function testFindSessionIdSessionPath(): Promise<void> {
  const dir = mkTmp();
  try {
    const p = join(dir, "x.jsonl");
    writeFileSync(p, "{}");
    const [path, sid] = findSession({ glob: join(dir, "*.jsonl"), id: "session_path" }, {});
    assert.equal(sid, p);
    assert.equal(path, p);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

async function testFindSessionNoMatchesReturnsNull(): Promise<void> {
  const dir = mkTmp();
  try {
    assert.deepEqual(findSession({ glob: join(dir, "*.jsonl") }, {}), [null, null]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

async function testFindSessionRegexNoMatchFallsBackToStem(): Promise<void> {
  const dir = mkTmp();
  try {
    const p = join(dir, "unexpected-name.jsonl");
    writeFileSync(p, "{}");
    const spec = { glob: join(dir, "*.jsonl"), id: { regex: String.raw`nomatch-(\d+)` } };
    const [, sid] = findSession(spec, {});
    assert.equal(sid, "unexpected-name");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

async function testFindSessionRecursiveDoubleStarMatchesAnyDepth(): Promise<void> {
  // Covers the codex/pi/cursor-agent recipes' `**` (Python's glob.glob with
  // recursive=True semantics: zero or more intermediate directories).
  const dir = mkTmp();
  try {
    const zeroDeep = join(dir, "rollout-a.jsonl");
    const twoDeep = join(dir, "2026", "08-25", "rollout-b.jsonl");
    mkdirSync(join(dir, "2026", "08-25"), { recursive: true });
    const now = Date.now();
    touch(zeroDeep, now - 100_000);
    touch(twoDeep, now - 10_000);
    const [path, sid] = findSession({ glob: join(dir, "**", "rollout-*.jsonl") }, {});
    assert.equal(path, twoDeep, "** must match through nested directories, picking the newest overall");
    assert.equal(sid, "rollout-b");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// ── quiesce ──────────────────────────────────────────────────────────

async function testQuiesceTrueWhenFileAbsent(): Promise<void> {
  assert.equal(await quiesce("/nonexistent/path.jsonl"), true);
}

async function testQuiesceSettlesOnceFileStopsGrowing(): Promise<void> {
  const dir = mkTmp();
  try {
    const p = join(dir, "t.jsonl");
    writeFileSync(p, "x".repeat(10));
    assert.equal(await quiesce(p, 5, 0.3), true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

async function testQuiesceTimesOutIfFileKeepsGrowing(): Promise<void> {
  const dir = mkTmp();
  try {
    const p = join(dir, "t.jsonl");
    writeFileSync(p, "x");
    let stop = false;
    const grow = (async () => {
      while (!stop) {
        writeFileSync(p, "x", { flag: "a" });
        await new Promise((r) => setTimeout(r, 100));
      }
    })();
    try {
      assert.equal(await quiesce(p, 1, 5), false);
    } finally {
      stop = true;
      await grow;
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// ── discover() — against a REAL spawned process and REAL /proc ─────────
//
// The child's argv[0] is renamed to "claude" via bash's `exec -a`, enough to
// satisfy the shipped claude-code recipe's {"argv_contains": "claude"} detect
// rule without needing the actual CLI installed.

interface FakeClaudeProcess {
  proc: ChildProcess;
  pid: number;
  home: string;
  cwd: string;
  sessionPath: string;
}

async function spawnFakeClaudeProcess(extraEnv: Record<string, string> = {}): Promise<FakeClaudeProcess> {
  const home = mkTmp();
  const cwd = join(home, "project");
  mkdirSync(cwd, { recursive: true });
  const key = cwdKey(cwd);
  const sessDir = join(home, ".claude", "projects", key);
  mkdirSync(sessDir, { recursive: true });
  const sessionPath = join(sessDir, "abc-session-id.jsonl");
  writeFileSync(sessionPath, '{"hello": "world"}\n');

  const proc = spawn("bash", ["-c", "exec -a claude sleep 100"], {
    cwd,
    env: { ...process.env, HOME: home, ...extraEnv },
  });
  await new Promise((r) => setTimeout(r, 200));
  if (proc.pid === undefined) throw new Error("failed to spawn fake claude process");
  return { proc, pid: proc.pid, home, cwd, sessionPath };
}

function killFakeProcess(f: { proc: ChildProcess; home: string }): void {
  f.proc.kill("SIGKILL");
  rmSync(f.home, { recursive: true, force: true });
}

async function testDiscoverFindsClaudeCodeRecipeCwdAndSession(): Promise<void> {
  const fake = await spawnFakeClaudeProcess({ ANTHROPIC_API_KEY: "sk-ant-test-demo-key" });
  try {
    await withHome(fake.home, () => {
      const info = discover(fake.pid);
      assert.equal(info.command, "claude-code");
      assert.equal(info.cwd, fake.cwd);
      assert.equal(info.sessionPath, fake.sessionPath);
      assert.equal(info.sessionId, "abc-session-id");
      assert.equal(info.environ.ANTHROPIC_API_KEY, "sk-ant-test-demo-key");
    });
  } finally {
    killFakeProcess(fake);
  }
}

async function testDiscoverUnrecognizedCommandReturnsNullAndNoSession(): Promise<void> {
  const proc = spawn("sleep", ["100"]);
  await new Promise((r) => setTimeout(r, 200));
  try {
    const info = discover(proc.pid!);
    assert.equal(info.command, null);
    assert.equal(info.sessionPath, null);
    assert.equal(info.sessionId, null);
  } finally {
    proc.kill("SIGKILL");
  }
}

// ── migrate() — key forwarding semantics, exercised without a real network
// call via a scripted fetch backing a REAL Arker client (this codebase's own
// convention — see tests/unit.ts's FakeFetch — rather than a duck-typed
// client/VM pair). ──────────────────────────────────────────────────

function jsonResponse(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json" } });
}

function completedRun(stdout: string): unknown {
  return { state: "completed", stdout, stdout_encoding: "utf-8", stderr: "", stderr_encoding: "utf-8", exit_code: 0 };
}

/** Answers exactly the request sequence migrate() issues against a fresh
 * `vm_migrated` VM: fork, mkdir run, syncDir's manifest fetch + tarball
 * upload, install run, transcript + extra_files writes, createSession, and
 * the resume run. Captures the createSession request body so tests can
 * assert on forwarded env, mirroring the Python suite's `vm.session_env`. */
function migrateFetchStub(capture: { sessionBody?: { env?: unknown; cwd?: unknown } }): typeof fetch {
  const vmId = "vm_migrated";
  return (async (input, init) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : (input as Request).url;
    const method = (init?.method ?? "GET").toUpperCase();
    const { pathname } = new URL(url);
    const bodyText = typeof init?.body === "string" ? init.body : undefined;
    const body: Record<string, unknown> | undefined = bodyText ? JSON.parse(bodyText) : undefined;

    if (method === "POST" && pathname === "/api/v1/fork") return jsonResponse({ vm_id: vmId, state: "idle" });
    if (method === "POST" && pathname === `/api/v1/vms/${vmId}/sync` && body?.op === "manifest") {
      return jsonResponse({ entries: [], truncated: false });
    }
    if (method === "POST" && pathname === `/api/v1/vms/${vmId}/sync-stream`) {
      return new Response(null, { status: 200 });
    }
    if (method === "POST" && pathname === `/api/v1/vms/${vmId}/sessions`) {
      capture.sessionBody = { env: body?.env, cwd: body?.cwd };
      return jsonResponse({ session_id: "sess-1", state: "idle", cwd: (body?.cwd as string) ?? "/" });
    }
    if (method === "POST" && pathname === `/api/v1/vms/${vmId}/runs`) {
      return jsonResponse(completedRun("resumed-output"));
    }
    throw new Error(`migrateFetchStub: unexpected ${method} ${pathname}`);
  }) as typeof fetch;
}

function migrateTestClient(fetchImpl: typeof fetch): Arker {
  return new Arker({
    apiKey: "ark_live_test",
    baseUrl: "https://test.invalid/api/",
    fetch: fetchImpl,
    retry: false,
  });
}

async function testMigrateExplicitKeysOverrideWinsOverDiscoveredEnviron(): Promise<void> {
  // The claude-code recipe declares keys=["ANTHROPIC_API_KEY",
  // "CLAUDE_CODE_OAUTH_TOKEN"]; the fixture process has ANTHROPIC_API_KEY set
  // in its environ. An explicit `keys` option must win outright (not merge)
  // — the documented escape hatch for auth mechanisms the recipe's declared
  // `keys` list doesn't cover (e.g. a file-based OAuth login, invisible to
  // /proc/<pid>/environ).
  const fake = await spawnFakeClaudeProcess({ ANTHROPIC_API_KEY: "sk-ant-test-demo-key" });
  try {
    await withHome(fake.home, async () => {
      const capture: { sessionBody?: { env?: unknown; cwd?: unknown } } = {};
      const client = migrateTestClient(migrateFetchStub(capture));
      const result = await migrate(client, {
        pid: fake.pid,
        doQuiesce: false,
        keys: { CLAUDE_CODE_OAUTH_TOKEN: "override-token" },
      });
      assert.equal(result.output, "resumed-output");
      assert.deepEqual(capture.sessionBody?.env, { CLAUDE_CODE_OAUTH_TOKEN: "override-token" });
    });
  } finally {
    killFakeProcess(fake);
  }
}

async function testMigrateAutoDiscoversDeclaredKeysFromEnviron(): Promise<void> {
  const fake = await spawnFakeClaudeProcess({ ANTHROPIC_API_KEY: "sk-ant-test-demo-key" });
  try {
    await withHome(fake.home, async () => {
      const capture: { sessionBody?: { env?: unknown; cwd?: unknown } } = {};
      const client = migrateTestClient(migrateFetchStub(capture));
      await migrate(client, { pid: fake.pid, doQuiesce: false });
      assert.deepEqual(capture.sessionBody?.env, { ANTHROPIC_API_KEY: "sk-ant-test-demo-key" });
    });
  } finally {
    killFakeProcess(fake);
  }
}

async function testMigrateAutoDiscoversClaudeCodeOauthTokenToo(): Promise<void> {
  // CLAUDE_CODE_OAUTH_TOKEN is the env var Claude Code reads for the
  // headless/CI auth path set up via `claude setup-token`; confirm it's
  // forwarded too when present (not just ANTHROPIC_API_KEY).
  const fake = await spawnFakeClaudeProcess({ CLAUDE_CODE_OAUTH_TOKEN: "sk-ant-oat01-test-demo-token" });
  try {
    await withHome(fake.home, async () => {
      const capture: { sessionBody?: { env?: unknown; cwd?: unknown } } = {};
      const client = migrateTestClient(migrateFetchStub(capture));
      await migrate(client, { pid: fake.pid, doQuiesce: false });
      assert.deepEqual(capture.sessionBody?.env, { CLAUDE_CODE_OAUTH_TOKEN: "sk-ant-oat01-test-demo-token" });
    });
  } finally {
    killFakeProcess(fake);
  }
}

async function testMigrateRaisesForUnrecognizedCommand(): Promise<void> {
  const proc = spawn("sleep", ["100"]);
  await new Promise((r) => setTimeout(r, 200));
  try {
    const client = migrateTestClient(migrateFetchStub({}));
    await assert.rejects(
      migrate(client, { pid: proc.pid!, doQuiesce: false }),
      /not a recognized migratable command/,
    );
  } finally {
    proc.kill("SIGKILL");
  }
}

// ── The bundled recipe file must not silently drift from the canonical copy
// python/src/arker/migrate.py loads. Both packages ship their own vendored
// copy (each is published/installed independently), so nothing enforces this
// at runtime — only this test, and only when both live side by side in a
// monorepo checkout (skips quietly outside one, e.g. against an installed
// npm package with no python/ directory around). ──────────────────────────

async function testCommandMigrationJsonStaysInSyncWithPythonCanonical(): Promise<void> {
  const canonical = new URL("../../python/src/arker/command_migration.json", import.meta.url);
  if (!existsSync(canonical)) return; // not a monorepo checkout — nothing to compare against
  const { readFileSync } = await import("node:fs");
  const pythonSide = JSON.parse(readFileSync(canonical, "utf8"));
  assert.deepEqual(
    loadConfig(),
    pythonSide,
    "typescript/src/command_migration.json has drifted from python/src/arker/command_migration.json",
  );
}

await testDetectArgvContains();
await testDetectArgvRegex();
await testDetectNoRecognizedKeyReturnsFalse();
await testCwdKeyMatchesClaudeCodesOwnDirectoryConvention();
await testSubstReplacesPlaceholdersAndExpandsHome();
await testSubstLeavesUnmatchedPlaceholdersUntouched();
await testFindSessionPicksNewestByDefault();
await testFindSessionPickOldestMtime();
await testFindSessionIdRegex();
await testFindSessionIdSessionPath();
await testFindSessionNoMatchesReturnsNull();
await testFindSessionRegexNoMatchFallsBackToStem();
await testFindSessionRecursiveDoubleStarMatchesAnyDepth();
await testQuiesceTrueWhenFileAbsent();
await testQuiesceSettlesOnceFileStopsGrowing();
await testQuiesceTimesOutIfFileKeepsGrowing();
await testDiscoverFindsClaudeCodeRecipeCwdAndSession();
await testDiscoverUnrecognizedCommandReturnsNullAndNoSession();
await testMigrateExplicitKeysOverrideWinsOverDiscoveredEnviron();
await testMigrateAutoDiscoversDeclaredKeysFromEnviron();
await testMigrateAutoDiscoversClaudeCodeOauthTokenToo();
await testMigrateRaisesForUnrecognizedCommand();
await testCommandMigrationJsonStaysInSyncWithPythonCanonical();

console.log("PASS migrate");
