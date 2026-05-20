/**
 * Unit tests for `@arker-ai/sdk/daytona` Phases A–D surface.
 */
import assert from "node:assert/strict";

import { Arker } from "../src/index.js";
import {
  Daytona,
  type ExecuteResponse,
  FileSystemError,
  type Match,
  SandboxNotFoundError,
  SandboxState,
  type Session,
  SessionNotFoundError,
} from "../src/daytona/index.js";

const BASE = "https://test.invalid/api";

type FetchCall = { url: string; method: string; body?: string };
type FetchScript = { predicate: (m: string, u: string) => boolean; response: Response };

class FakeFetch {
  readonly calls: FetchCall[] = [];
  private readonly script: FetchScript[] = [];

  addJson(predicate: FetchScript["predicate"], status: number, body: unknown): void {
    this.script.push({
      predicate,
      response: new Response(JSON.stringify(body), {
        status,
        headers: { "content-type": "application/json" },
      }),
    });
  }

  fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    const method = init?.method ?? "GET";
    const body = typeof init?.body === "string" ? init.body : undefined;
    this.calls.push({ url, method, body });

    const index = this.script.findIndex((entry) => entry.predicate(method, url));
    assert.notEqual(index, -1, `no scripted response for ${method} ${url}`);
    return this.script.splice(index, 1)[0]!.response;
  };
}

function makeArker(fetch: FakeFetch): Arker {
  return new Arker({
    apiKey: "ark_live_test",
    baseUrl: "https://test.invalid/api/",
    fetch: fetch.fetch,
    retry: false,
  });
}

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

function scriptFork(fetch: FakeFetch, vmId = "vm_daytona"): void {
  fetch.addJson(
    (m, u) => m === "POST" && u === `${BASE}/v1/vms/base/fork`,
    200,
    { vm_id: vmId, owner_id: "o", created_at: "now", sessions: [{ session_id: "s0", state: "ready", cwd: "/home/user" }] },
  );
}

function addShell(fetch: FakeFetch, vmId: string, stdout = "", stderr = "", exitCode = 0): void {
  fetch.addJson(
    (m, u) => m === "POST" && u === `${BASE}/v1/vms/${vmId}/run`,
    200,
    completedRun(stdout, stderr, exitCode),
  );
}

async function makeSandbox(fetch: FakeFetch, vmId = "vm_daytona") {
  scriptFork(fetch, vmId);
  const d = new Daytona({ apiKey: "ark_live_test" }, { _arker: makeArker(fetch) });
  return d.create();
}

// ----- Client -----

async function testCreateForks(): Promise<void> {
  const fetch = new FakeFetch();
  const sbx = await makeSandbox(fetch);
  assert.equal(sbx.id, "vm_daytona");
}

async function testGetReturnsSandbox(): Promise<void> {
  const fetch = new FakeFetch();
  fetch.addJson(
    (m, u) => m === "GET" && u === `${BASE}/v1/vms/vm_x`,
    200,
    { vm_id: "vm_x", owner_id: "o", created_at: "now", state: "running", sessions: [], source_golden: "base" },
  );
  const d = new Daytona({ apiKey: "x" }, { _arker: makeArker(fetch) });
  const sbx = await d.get("vm_x");
  assert.equal(sbx.id, "vm_x");
}

async function testGetRaisesNotFound(): Promise<void> {
  const fetch = new FakeFetch();
  fetch.addJson(
    (m, u) => m === "GET" && u === `${BASE}/v1/vms/missing`,
    404,
    { code: "not_found", message: "no such vm" },
  );
  const d = new Daytona({ apiKey: "x" }, { _arker: makeArker(fetch) });
  await assert.rejects(() => d.get("missing"), SandboxNotFoundError);
}

async function testList(): Promise<void> {
  const fetch = new FakeFetch();
  fetch.addJson(
    (m, u) => m === "GET" && u === `${BASE}/v1/vms`,
    200,
    {
      vms: [
        { vm_id: "vm_a", owner_id: "o", created_at: "now", state: "running", sessions: [], source_golden: "base" },
        { vm_id: "vm_b", owner_id: "o", created_at: "now", state: "running", sessions: [] },
      ],
    },
  );
  const d = new Daytona({ apiKey: "x" }, { _arker: makeArker(fetch) });
  const items = await d.list();
  assert.deepEqual(items.map((s) => s.id), ["vm_a", "vm_b"]);
}

async function testRemove(): Promise<void> {
  const fetch = new FakeFetch();
  fetch.addJson(
    (m, u) => m === "DELETE" && u === `${BASE}/v1/vms/vm_x`,
    200,
    { deleted: true },
  );
  const d = new Daytona({ apiKey: "x" }, { _arker: makeArker(fetch) });
  await d.remove("vm_x");
}

// ----- Process -----

async function testExecReturnsResponse(): Promise<void> {
  const fetch = new FakeFetch();
  const sbx = await makeSandbox(fetch);
  addShell(fetch, "vm_daytona", "hi\n");
  const resp: ExecuteResponse = await sbx.process.exec("echo hi");
  assert.equal(resp.exitCode, 0);
  assert.equal(resp.result, "hi\n");
  assert.equal(resp.artifacts?.stdout, "hi\n");
}

async function testExecInlinesCwdAndEnv(): Promise<void> {
  const fetch = new FakeFetch();
  const sbx = await makeSandbox(fetch);
  addShell(fetch, "vm_daytona");
  await sbx.process.exec("ls", { cwd: "/srv", env: { X: "1" } });
  const body = JSON.parse(fetch.calls[fetch.calls.length - 1]!.body!);
  assert.match(body.command, /cd '\/srv' &&/);
  assert.match(body.command, /env 'X'='1'/);
}

async function testCodeRunPython(): Promise<void> {
  const fetch = new FakeFetch();
  const sbx = await makeSandbox(fetch);
  fetch.addJson(
    (m, u) => m === "POST" && u === `${BASE}/v1/vms/vm_daytona/sync`,
    200,
    { results: [{ complete: true, written: true }] },
  );
  addShell(fetch, "vm_daytona", "4\n");
  addShell(fetch, "vm_daytona"); // cleanup rm
  const resp = await sbx.process.codeRun("print(2+2)");
  assert.equal(resp.result, "4\n");
}

// ----- Filesystem -----

async function testListFiles(): Promise<void> {
  const fetch = new FakeFetch();
  const sbx = await makeSandbox(fetch);
  addShell(
    fetch,
    "vm_daytona",
    "readme.txt|f|42|644|alice|users|1735776000.0\nsrc|d|4096|755|alice|users|1735776100.0\n",
  );
  const entries = await sbx.fs.listFiles("/work");
  assert.equal(entries.length, 2);
  assert.equal(entries[0]!.name, "readme.txt");
  assert.equal(entries[0]!.size, 42);
  assert.equal(entries[1]!.isDir, true);
  assert.equal(entries[1]!.mode, 0o755);
}

async function testCreateFolderAndDelete(): Promise<void> {
  const fetch = new FakeFetch();
  const sbx = await makeSandbox(fetch);
  addShell(fetch, "vm_daytona"); // mkdir
  await sbx.fs.createFolder("/work/new", "700");
  let body = JSON.parse(fetch.calls[fetch.calls.length - 1]!.body!);
  assert.equal(body.command, "mkdir -m '700' -p '/work/new'");

  addShell(fetch, "vm_daytona"); // rm
  await sbx.fs.deleteFile("/work/junk", true);
  body = JSON.parse(fetch.calls[fetch.calls.length - 1]!.body!);
  assert.equal(body.command, "rm -rf '/work/junk'");
}

async function testFindFiles(): Promise<void> {
  const fetch = new FakeFetch();
  const sbx = await makeSandbox(fetch);
  addShell(fetch, "vm_daytona", "/work/a.py:3:def foo():\n/work/b.py:17:def foo_bar():\n");
  const matches: Match[] = await sbx.fs.findFiles("/work", "def foo");
  assert.deepEqual(matches, [
    { file: "/work/a.py", line: 3, content: "def foo():" },
    { file: "/work/b.py", line: 17, content: "def foo_bar():" },
  ]);
}

async function testUploadDownloadBytes(): Promise<void> {
  const fetch = new FakeFetch();
  const sbx = await makeSandbox(fetch);
  fetch.addJson(
    (m, u) => m === "POST" && u === `${BASE}/v1/vms/vm_daytona/sync`,
    200,
    { results: [{ complete: true, written: true }] },
  );
  await sbx.fs.uploadFile(new TextEncoder().encode("payload"), "/tmp/y.bin");

  fetch.addJson(
    (m, u) => m === "POST" && u === `${BASE}/v1/vms/vm_daytona/sync`,
    200,
    { content: b64("hello"), encoding: "base64" },
  );
  const data = await sbx.fs.downloadFile("/tmp/x");
  assert.equal(new TextDecoder().decode(data), "hello");
}

async function testGetFileInfoFailsOnMissing(): Promise<void> {
  const fetch = new FakeFetch();
  const sbx = await makeSandbox(fetch);
  addShell(fetch, "vm_daytona", "", "no such", 1);
  await assert.rejects(() => sbx.fs.getFileInfo("/nope"), FileSystemError);
}

// ----- Sessions -----

async function testSessionListReflectsRemote(): Promise<void> {
  const fetch = new FakeFetch();
  const sbx = await makeSandbox(fetch);
  sbx.process.createSession("s1");
  fetch.addJson(
    (m, u) => m === "GET" && u === `${BASE}/v1/vms/vm_daytona`,
    200,
    {
      vm_id: "vm_daytona",
      owner_id: "o",
      created_at: "now",
      state: "running",
      sessions: [{ session_id: "s1", state: "ready", cwd: "/home/user" }],
    },
  );
  const sessions: Session[] = await sbx.process.listSessions();
  const s1 = sessions.find((s) => s.sessionId === "s1");
  assert.ok(s1);
  assert.equal(s1!.state, "ready");
}

async function testExecuteSessionCommandSync(): Promise<void> {
  const fetch = new FakeFetch();
  const sbx = await makeSandbox(fetch);
  sbx.process.createSession("s1");
  addShell(fetch, "vm_daytona", "ok\n");
  const resp = await sbx.process.executeSessionCommand("s1", { command: "echo ok" });
  assert.equal(resp.output, "ok\n");
  assert.equal(resp.exitCode, 0);

  // Cached logs (no extra HTTP call)
  const before = fetch.calls.length;
  const logs = await sbx.process.getSessionCommandLogs("s1", resp.cmdId);
  assert.equal(logs.stdout, "ok\n");
  assert.equal(fetch.calls.length, before);
}

async function testExecuteSessionCommandAsync(): Promise<void> {
  const fetch = new FakeFetch();
  const sbx = await makeSandbox(fetch);
  sbx.process.createSession("s2");
  fetch.addJson(
    (m, u) => m === "POST" && u === `${BASE}/v1/vms/vm_daytona/run`,
    200,
    { run_id: "run_async", completed: false, tunnels: [] },
  );
  const resp = await sbx.process.executeSessionCommand("s2", { command: "sleep 1", runAsync: true });
  assert.equal(resp.cmdId, "run_async");
  assert.equal(resp.output, null);
}

async function testGetSessionRaisesMissing(): Promise<void> {
  const fetch = new FakeFetch();
  const sbx = await makeSandbox(fetch);
  fetch.addJson(
    (m, u) => m === "GET" && u === `${BASE}/v1/vms/vm_daytona`,
    200,
    { vm_id: "vm_daytona", owner_id: "o", created_at: "now", state: "running", sessions: [] },
  );
  await assert.rejects(() => sbx.process.getSession("missing"), SessionNotFoundError);
}

// ----- Sandbox state -----

async function testSandboxState(): Promise<void> {
  const fetch = new FakeFetch();
  const sbx = await makeSandbox(fetch);
  fetch.addJson(
    (m, u) => m === "GET" && u === `${BASE}/v1/vms/vm_daytona`,
    200,
    { vm_id: "vm_daytona", owner_id: "o", created_at: "now", state: "running", sessions: [] },
  );
  assert.equal(await sbx.getState(), SandboxState.Started);
}

async function testSetLabelsLocal(): Promise<void> {
  const fetch = new FakeFetch();
  const sbx = await makeSandbox(fetch);
  const before = fetch.calls.length;
  const labels = sbx.setLabels({ env: "test" });
  assert.deepEqual(labels, { env: "test" });
  assert.equal(fetch.calls.length, before);
}

async function testStartStopAreNoops(): Promise<void> {
  const fetch = new FakeFetch();
  const sbx = await makeSandbox(fetch);
  const before = fetch.calls.length;
  await sbx.start();
  await sbx.stop();
  await sbx.archive();
  assert.equal(fetch.calls.length, before);
}

async function testUnsupportedSurfacesThrow(): Promise<void> {
  const fetch = new FakeFetch();
  const sbx = await makeSandbox(fetch);
  await assert.rejects(() => sbx.fs.searchFiles("/x", "y"), /searchFiles is not implemented/);
  await assert.rejects(() => sbx.fs.replaceInFiles([], "a", "b"), /replaceInFiles is not implemented/);
  await assert.rejects(() => sbx.process.createPtySession(), /PTY sessions/);
  await assert.rejects(() => sbx.process.sendSessionCommandInput("s", "c", "x"), /sendSessionCommandInput is not implemented/);
  await assert.rejects(() => sbx.process.getEntrypointSession(), /entrypoint/);
}

// ----- Run -----

await testCreateForks();
await testGetReturnsSandbox();
await testGetRaisesNotFound();
await testList();
await testRemove();
await testExecReturnsResponse();
await testExecInlinesCwdAndEnv();
await testCodeRunPython();
await testListFiles();
await testCreateFolderAndDelete();
await testFindFiles();
await testUploadDownloadBytes();
await testGetFileInfoFailsOnMissing();
await testSessionListReflectsRemote();
await testExecuteSessionCommandSync();
await testExecuteSessionCommandAsync();
await testGetSessionRaisesMissing();
await testSandboxState();
await testSetLabelsLocal();
await testStartStopAreNoops();
await testUnsupportedSurfacesThrow();

console.log("PASS unit_daytona");
