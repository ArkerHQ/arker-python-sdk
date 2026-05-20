/**
 * Unit tests for `@arker-ai/sdk/e2b` Phase A–E surface.
 */
import assert from "node:assert/strict";

import {
  CommandExitException,
  CommandHandle,
  FileType,
  type ProcessInfo,
  Sandbox,
  type SandboxInfo,
  wrapCommand,
} from "../src/e2b/index.js";
import { Sandbox as CISandbox } from "../src/e2b/code-interpreter/index.js";
import { runtimeFor } from "../src/e2b/code-interpreter/index.js";
import { FakeFetch, client } from "./_fake-fetch.js";

const BASE = "https://test.invalid/api";

function b64(s: string): string {
  return Buffer.from(s).toString("base64");
}

function completedRun(stdout = "", stderr = "", exitCode = 0): object {
  return {
    stdout: b64(stdout),
    stdout_encoding: "base64",
    stderr: b64(stderr),
    stderr_encoding: "base64",
    exit_code: exitCode,
    completed: true,
    type: "completed",
  };
}

function bgRun(runId: string): object {
  return { run_id: runId, completed: false, tunnels: [] };
}

function runStatus(runId: string, stdout = "", stderr = "", exitCode: number | null = null, completed = false): object {
  return {
    run_id: runId,
    stdout: b64(stdout),
    stdout_encoding: "base64",
    stderr: b64(stderr),
    stderr_encoding: "base64",
    exit_code: exitCode,
    completed,
    tunnels: [],
  };
}

function scriptFork(fetch: FakeFetch, vmId = "vm_child"): void {
  fetch.addJson(
    (m, u) => m === "POST" && u === `${BASE}/v1/vms/ubuntu/fork`,
    200,
    { vm_id: vmId, owner_id: "o", created_at: "now", sessions: [] },
  );
}

async function makeSandbox(fetch: FakeFetch, vmId = "vm_child"): Promise<Sandbox> {
  scriptFork(fetch, vmId);
  return Sandbox.create({ _arker: client(fetch) });
}

// ----- Phase A -----

async function testConstructorForksDefault(): Promise<void> {
  const fetch = new FakeFetch();
  const sbx = await makeSandbox(fetch);
  assert.equal(sbx.sandboxId, "vm_child");
}

async function testConnectAttachesWithoutFork(): Promise<void> {
  const fetch = new FakeFetch();
  const sbx = await Sandbox.create({ _arker: client(fetch), sandboxId: "vm_existing" });
  assert.equal(sbx.sandboxId, "vm_existing");
  assert.equal(fetch.calls.length, 0);
}

async function testCommandsRunHappy(): Promise<void> {
  const fetch = new FakeFetch();
  const sbx = await makeSandbox(fetch);
  fetch.addJson(
    (m, u) => m === "POST" && u === `${BASE}/v1/vms/vm_child/run`,
    200,
    completedRun("hello\n"),
  );
  const result = await sbx.commands.run("echo hello");
  assert.equal((result as { stdout: string }).stdout, "hello\n");
  assert.equal((result as { exitCode: number }).exitCode, 0);
}

async function testCommandsRunRaisesOnNonzero(): Promise<void> {
  const fetch = new FakeFetch();
  const sbx = await makeSandbox(fetch);
  fetch.addJson(
    (m, u) => m === "POST" && u === `${BASE}/v1/vms/vm_child/run`,
    200,
    completedRun("", "nope", 2),
  );
  await assert.rejects(() => sbx.commands.run("false"), CommandExitException);
}

async function testFilesWriteThenRead(): Promise<void> {
  const fetch = new FakeFetch();
  const sbx = await makeSandbox(fetch);
  fetch.addJson(
    (m, u) => m === "POST" && u === `${BASE}/v1/vms/vm_child/sync`,
    200,
    { results: [{ complete: true, written: true }] },
  );
  const entry = await sbx.files.write("/tmp/x.txt", "data");
  assert.deepEqual(entry, { name: "x.txt", type: FileType.File, path: "/tmp/x.txt" });

  fetch.addJson(
    (m, u) => m === "POST" && u === `${BASE}/v1/vms/vm_child/sync`,
    200,
    { content: "data", encoding: "utf-8" },
  );
  const got = await sbx.files.read("/tmp/x.txt");
  assert.equal(got, "data");
}

async function testKillCallsDelete(): Promise<void> {
  const fetch = new FakeFetch();
  const sbx = await makeSandbox(fetch);
  fetch.addJson(
    (m, u) => m === "DELETE" && u === `${BASE}/v1/vms/vm_child`,
    200,
    { deleted: true },
  );
  assert.equal(await sbx.kill(), true);
}

async function testEnvsInlinedIntoCommand(): Promise<void> {
  const fetch = new FakeFetch();
  const sbx = await Sandbox.create({ _arker: client(fetch), sandboxId: "vm_e", envs: { FOO: "bar" } });
  fetch.addJson(
    (m, u) => m === "POST" && u === `${BASE}/v1/vms/vm_e/run`,
    200,
    completedRun("ok"),
  );
  await sbx.commands.run("echo $FOO", { cwd: "/srv" });
  const body = JSON.parse(fetch.calls[0]!.body!);
  assert.match(body.command, /cd '\/srv' &&/);
  assert.match(body.command, /env 'FOO'='bar'/);
}

function testWrapCommand(): void {
  assert.equal(wrapCommand("ls"), "ls");
  assert.equal(wrapCommand("ls", "/tmp"), "cd '/tmp' && ls");
}

// ----- Phase B -----

async function testBackgroundRunReturnsHandle(): Promise<void> {
  const fetch = new FakeFetch();
  const sbx = await makeSandbox(fetch);
  fetch.addJson(
    (m, u) => m === "POST" && u === `${BASE}/v1/vms/vm_child/run`,
    200,
    bgRun("run_a"),
  );
  const h = await sbx.commands.run("sleep 5", { background: true });
  assert.ok(h instanceof CommandHandle);
  assert.equal((h as CommandHandle).pid, 1);
}

async function testHandleWaitPollsUntilComplete(): Promise<void> {
  const fetch = new FakeFetch();
  const sbx = await makeSandbox(fetch);
  fetch.addJson((m, u) => m === "POST" && u === `${BASE}/v1/vms/vm_child/run`, 200, bgRun("run_b"));
  const handle = (await sbx.commands.run("echo done", { background: true })) as CommandHandle;

  fetch.addJson((m, u) => m === "GET" && u.includes("/runs/run_b"), 200, runStatus("run_b", "part1", "", null, false));
  fetch.addJson((m, u) => m === "GET" && u.includes("/runs/run_b"), 200, runStatus("run_b", "part1done", "", 0, true));

  const chunks: string[] = [];
  const result = await handle.wait({ onStdout: (c) => chunks.push(c) });
  assert.equal(result.exitCode, 0);
  assert.equal(result.stdout, "part1done");
  assert.deepEqual(chunks, ["part1", "done"]);
}

async function testHandleKillCancels(): Promise<void> {
  const fetch = new FakeFetch();
  const sbx = await makeSandbox(fetch);
  fetch.addJson((m, u) => m === "POST" && u === `${BASE}/v1/vms/vm_child/run`, 200, bgRun("run_c"));
  const handle = (await sbx.commands.run("sleep 99", { background: true })) as CommandHandle;
  fetch.addJson((m, u) => m === "DELETE" && u.includes("/runs/run_c"), 200, { cancelled: true });
  assert.equal(await handle.kill(), true);
  assert.equal(sbx._bgRuns.size, 0);
}

async function testCommandsListAndConnect(): Promise<void> {
  const fetch = new FakeFetch();
  const sbx = await makeSandbox(fetch);
  fetch.addJson((m, u) => m === "POST" && u === `${BASE}/v1/vms/vm_child/run`, 200, bgRun("run_d"));
  const handle = (await sbx.commands.run("sleep 1", { background: true })) as CommandHandle;
  const listing: ProcessInfo[] = sbx.commands.list();
  assert.equal(listing.length, 1);
  assert.equal(listing[0]!.tag, "run_d");

  const reconnected = sbx.commands.connect(handle.pid);
  assert.equal(reconnected.pid, handle.pid);
}

// ----- Phase C -----

async function testFilesListParses(): Promise<void> {
  const fetch = new FakeFetch();
  const sbx = await makeSandbox(fetch);
  fetch.addJson(
    (m, u) => m === "POST" && u === `${BASE}/v1/vms/vm_child/run`,
    200,
    completedRun("readme.txt|f\nsrc|d\n"),
  );
  const entries = await sbx.files.list("/work");
  assert.deepEqual(entries, [
    { name: "readme.txt", type: FileType.File, path: "/work/readme.txt" },
    { name: "src", type: FileType.Dir, path: "/work/src" },
  ]);
}

async function testFilesExists(): Promise<void> {
  const fetch = new FakeFetch();
  const sbx = await makeSandbox(fetch);
  fetch.addJson((m, u) => m === "POST" && u === `${BASE}/v1/vms/vm_child/run`, 200, completedRun("", "", 0));
  assert.equal(await sbx.files.exists("/tmp"), true);
  fetch.addJson((m, u) => m === "POST" && u === `${BASE}/v1/vms/vm_child/run`, 200, completedRun("", "", 1));
  assert.equal(await sbx.files.exists("/nope"), false);
}

async function testFilesMakeDirAndRename(): Promise<void> {
  const fetch = new FakeFetch();
  const sbx = await makeSandbox(fetch);
  fetch.addJson((m, u) => m === "POST" && u === `${BASE}/v1/vms/vm_child/run`, 200, completedRun());
  assert.equal(await sbx.files.makeDir("/tmp/deep/nest"), true);
  fetch.addJson((m, u) => m === "POST" && u === `${BASE}/v1/vms/vm_child/run`, 200, completedRun());
  const entry = await sbx.files.rename("/a", "/b/c");
  assert.equal(entry.path, "/b/c");
}

// ----- Phase E (code interpreter) -----

async function testRunCodeHappy(): Promise<void> {
  const fetch = new FakeFetch();
  scriptFork(fetch, "vm_ci");
  const sbx = await CISandbox.create({ _arker: client(fetch) });
  fetch.addJson((m, u) => m === "POST" && u === `${BASE}/v1/vms/vm_ci/sync`, 200, { results: [{ complete: true, written: true }] });
  fetch.addJson((m, u) => m === "POST" && u === `${BASE}/v1/vms/vm_ci/run`, 200, completedRun("4\n"));
  fetch.addJson((m, u) => m === "POST" && u === `${BASE}/v1/vms/vm_ci/run`, 200, completedRun());  // cleanup rm
  const ex = await sbx.runCode("console.log(2+2)", { language: "js" });
  assert.equal(ex.text, "4\n");
  assert.equal(ex.error, null);
}

async function testSandboxListMapsToSandboxInfos(): Promise<void> {
  const fetch = new FakeFetch();
  fetch.addJson(
    (m, u) => m === "GET" && u === `${BASE}/v1/vms`,
    200,
    {
      vms: [
        {
          vm_id: "vm_a",
          owner_id: "o",
          created_at: "2026-01-01T00:00:00Z",
          state: "running",
          sessions: [],
          name: "alpha",
          source_golden: "ubuntu",
          last_activity: "2026-01-02T00:00:00Z",
        },
        {
          vm_id: "vm_b",
          owner_id: "o",
          created_at: "2026-01-03T00:00:00Z",
          state: "stopped",
          sessions: [],
        },
      ],
    },
  );
  const items: SandboxInfo[] = await Sandbox.list({ _arker: client(fetch) });
  assert.deepEqual(items, [
    {
      sandboxId: "vm_a",
      templateId: "ubuntu",
      name: "alpha",
      metadata: {},
      startedAt: "2026-01-01T00:00:00Z",
      endAt: "2026-01-02T00:00:00Z",
    },
    {
      sandboxId: "vm_b",
      templateId: null,
      name: null,
      metadata: {},
      startedAt: "2026-01-03T00:00:00Z",
      endAt: null,
    },
  ]);
}

async function testUnsupportedSurfacesThrow(): Promise<void> {
  const fetch = new FakeFetch();
  const sbx = await makeSandbox(fetch);

  await assert.rejects(() => sbx.commands.sendStdin(1, "x"), /commands\.sendStdin is not supported/);
  await assert.rejects(() => sbx.files.read("/x", { format: "stream" }), /format: 'stream'/);
  assert.throws(() => sbx.files.watchDir("/tmp"), /files\.watchDir is not supported/);
  await assert.rejects(() => sbx.pty.create({ rows: 24, cols: 80 }), /pty is not supported/);
  await assert.rejects(() => sbx.pty.sendStdin(1, new Uint8Array()), /pty is not supported/);
  await assert.rejects(() => sbx.pty.resize(1, { rows: 24, cols: 80 }), /pty is not supported/);
  await assert.rejects(() => sbx.pty.kill(1), /pty is not supported/);
}

async function testIsRunningTrueAndFalse(): Promise<void> {
  const fetch = new FakeFetch();
  const sbx = await makeSandbox(fetch);
  fetch.addJson(
    (m, u) => m === "GET" && u === `${BASE}/v1/vms/vm_child`,
    200,
    { vm_id: "vm_child", owner_id: "o", created_at: "now", state: "running", sessions: [] },
  );
  assert.equal(await sbx.isRunning(), true);

  fetch.addJson(
    (m, u) => m === "GET" && u === `${BASE}/v1/vms/vm_child`,
    404,
    { code: "not_found", message: "missing" },
  );
  assert.equal(await sbx.isRunning(), false);
}

function testSetTimeoutStoresLocally(): void {
  // Construct without _arker; sandboxId attaches without remote call.
  const fetch = new FakeFetch();
  // Use the synchronous _computer path: connect via _arker
  // (kept simple — purely an in-memory assertion).
  Sandbox.create({ _arker: client(fetch), sandboxId: "vm_x" }).then((sbx) => {
    const before = fetch.calls.length;
    sbx.setTimeout(300);
    assert.equal(fetch.calls.length, before);
    assert.equal(sbx.timeout, 300);
  });
}

function testRuntimeFor(): void {
  assert.deepEqual(runtimeFor("python"), ["python3", "py"]);
  assert.deepEqual(runtimeFor("ts"), ["ts-node", "ts"]);
  assert.deepEqual(runtimeFor("unknown"), ["python3", "py"]);
}

// ----- Run all -----

await testConstructorForksDefault();
await testConnectAttachesWithoutFork();
await testCommandsRunHappy();
await testCommandsRunRaisesOnNonzero();
await testFilesWriteThenRead();
await testKillCallsDelete();
await testEnvsInlinedIntoCommand();
testWrapCommand();
await testBackgroundRunReturnsHandle();
await testHandleWaitPollsUntilComplete();
await testHandleKillCancels();
await testCommandsListAndConnect();
await testFilesListParses();
await testFilesExists();
await testFilesMakeDirAndRename();
await testRunCodeHappy();
await testSandboxListMapsToSandboxInfos();
await testUnsupportedSurfacesThrow();
await testIsRunningTrueAndFalse();
testSetTimeoutStoresLocally();
testRuntimeFor();

console.log("PASS unit_e2b");
