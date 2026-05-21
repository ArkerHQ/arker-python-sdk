/** Unit tests for `@arker-ai/sdk/codesandbox`. */
import assert from "node:assert/strict";

import { Arker } from "../src/index.js";
import {
  CodeSandbox,
  type Command,
  CommandError,
  type FSStatResult,
  type ReaddirEntry,
  type Sandbox,
  SandboxNotFoundError,
} from "../src/codesandbox/index.js";

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
        status, headers: { "content-type": "application/json" },
      }),
    });
  }
  fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    const method = init?.method ?? "GET";
    const body = typeof init?.body === "string" ? init.body : undefined;
    this.calls.push({ url, method, body });
    const i = this.script.findIndex((e) => e.predicate(method, url));
    assert.notEqual(i, -1, `no scripted response for ${method} ${url}`);
    return this.script.splice(i, 1)[0]!.response;
  };
}

function makeArker(f: FakeFetch): Arker {
  return new Arker({ apiKey: "ark_live_test", baseUrl: "https://test.invalid/api/", fetch: f.fetch, retry: false });
}

function b64(s: string): string { return Buffer.from(s).toString("base64"); }

function completedRun(stdout = "", stderr = "", exitCode = 0): object {
  return {
    stdout: b64(stdout), stdout_encoding: "base64",
    stderr: b64(stderr), stderr_encoding: "base64",
    exit_code: exitCode, completed: true, type: "completed",
  };
}

function bgRun(runId: string): object {
  return { run_id: runId, completed: false, tunnels: [] };
}

function scriptFork(f: FakeFetch, vmId = "vm_csb"): void {
  f.addJson(
    (m, u) => m === "POST" && u === `${BASE}/v1/vms/base/fork`,
    200,
    { vm_id: vmId, owner_id: "o", created_at: "now", sessions: [] },
  );
}

async function makeSandboxAndClient(f: FakeFetch): Promise<{ sandbox: Sandbox; client: import("../src/codesandbox/index.js").SandboxClient }> {
  scriptFork(f);
  const csb = new CodeSandbox(undefined, { _arker: makeArker(f) });
  const sandbox = await csb.sandboxes.create();
  const client = await sandbox.connect();
  return { sandbox, client };
}

// ----- Lifecycle -----

async function testCreate(): Promise<void> {
  const f = new FakeFetch();
  scriptFork(f);
  const csb = new CodeSandbox(undefined, { _arker: makeArker(f) });
  const sbx = await csb.sandboxes.create();
  assert.equal(sbx.id, "vm_csb");
  assert.equal(sbx.bootupType, "FORK");
}

async function testCreateWithTemplateId(): Promise<void> {
  const f = new FakeFetch();
  f.addJson(
    (m, u) => m === "POST" && u === `${BASE}/v1/vms/my-template/fork`,
    200,
    { vm_id: "vm_t", owner_id: "o", created_at: "now", sessions: [] },
  );
  const csb = new CodeSandbox(undefined, { _arker: makeArker(f) });
  const sbx = await csb.sandboxes.create({ id: "my-template", title: "vm-test" });
  assert.equal(sbx.id, "vm_t");
}

async function testGetReturnsMetadataInfo(): Promise<void> {
  // codesandbox: sandboxes.get(id) returns SandboxInfo, not a connectable Sandbox.
  const f = new FakeFetch();
  f.addJson(
    (m, u) => m === "GET" && u === `${BASE}/v1/vms/vm_x`,
    200,
    { vm_id: "vm_x", owner_id: "o", created_at: "2026-01-15T10:30:00Z", state: "running", sessions: [], name: "my-sandbox" },
  );
  const csb = new CodeSandbox(undefined, { _arker: makeArker(f) });
  const info = await csb.sandboxes.get("vm_x");
  assert.equal(info.id, "vm_x");
  assert.equal(info.title, "my-sandbox");
  // createdAt is a real Date.
  assert.ok(info.createdAt instanceof Date);
}

async function testGet404Throws(): Promise<void> {
  const f = new FakeFetch();
  f.addJson(
    (m, u) => m === "GET" && u === `${BASE}/v1/vms/missing`,
    404,
    { code: "not_found", message: "no" },
  );
  const csb = new CodeSandbox(undefined, { _arker: makeArker(f) });
  await assert.rejects(() => csb.sandboxes.get("missing"), SandboxNotFoundError);
}

async function testResumeSetsBootupResume(): Promise<void> {
  const f = new FakeFetch();
  f.addJson(
    (m, u) => m === "GET" && u === `${BASE}/v1/vms/vm_x`,
    200,
    { vm_id: "vm_x", owner_id: "o", created_at: "now", state: "running", sessions: [] },
  );
  const csb = new CodeSandbox(undefined, { _arker: makeArker(f) });
  const sbx = await csb.sandboxes.resume("vm_x");
  assert.equal(sbx.bootupType, "RESUME");
}

async function testDelete(): Promise<void> {
  const f = new FakeFetch();
  f.addJson((m, u) => m === "DELETE" && u === `${BASE}/v1/vms/vm_x`, 200, { deleted: true });
  const csb = new CodeSandbox(undefined, { _arker: makeArker(f) });
  await csb.sandboxes.delete("vm_x");
}

async function testListPaginated(): Promise<void> {
  const f = new FakeFetch();
  f.addJson(
    (m, u) => m === "GET" && u === `${BASE}/v1/vms`,
    200,
    {
      vms: Array.from({ length: 3 }, (_, i) => ({
        vm_id: `vm_${i}`, owner_id: "o", created_at: "now",
        state: "running", sessions: [], name: `sandbox-${i}`,
      })),
    },
  );
  const csb = new CodeSandbox(undefined, { _arker: makeArker(f) });
  const resp = await csb.sandboxes.list({ pagination: { page: 1, pageSize: 2 } });
  assert.equal(resp.totalCount, 3);
  assert.equal(resp.sandboxes.length, 2);
  assert.equal(resp.pagination?.nextPage, 2);
}

async function testListTagsThrows(): Promise<void> {
  const f = new FakeFetch();
  const csb = new CodeSandbox(undefined, { _arker: makeArker(f) });
  await assert.rejects(() => csb.sandboxes.list({ tags: ["sdk"] }), /tags/);
}

// ----- Sandbox + SandboxClient -----

async function testConnectReturnsClient(): Promise<void> {
  const f = new FakeFetch();
  const { sandbox, client } = await makeSandboxAndClient(f);
  assert.equal(client._sandbox, sandbox);
}

async function testUpdateTierThrows(): Promise<void> {
  const f = new FakeFetch();
  scriptFork(f);
  const csb = new CodeSandbox(undefined, { _arker: makeArker(f) });
  const sbx = await csb.sandboxes.create();
  await assert.rejects(() => sbx.updateTier(null), /updateTier/);
}

// ----- Commands -----

async function testRunReturnsOutputString(): Promise<void> {
  const f = new FakeFetch();
  const { client } = await makeSandboxAndClient(f);
  f.addJson(
    (m, u) => m === "POST" && u === `${BASE}/v1/vms/vm_csb/run`,
    200, completedRun("hello\n"),
  );
  const out = await client.commands.run("echo hello");
  assert.equal(out, "hello\n");
}

async function testRunArrayForm(): Promise<void> {
  const f = new FakeFetch();
  const { client } = await makeSandboxAndClient(f);
  f.addJson(
    (m, u) => m === "POST" && u === `${BASE}/v1/vms/vm_csb/run`,
    200, completedRun("ok"),
  );
  await client.commands.run(["python", "-c", "print(1)"]);
  const body = JSON.parse(f.calls[f.calls.length - 1]!.body!);
  // TS shellQuote always wraps in single quotes; Python's shlex.quote
  // leaves alphanumerics unquoted. Different but equivalent.
  assert.equal(body.command, "'python' '-c' 'print(1)'");
}

async function testRunThrowsCommandError(): Promise<void> {
  const f = new FakeFetch();
  const { client } = await makeSandboxAndClient(f);
  f.addJson(
    (m, u) => m === "POST" && u === `${BASE}/v1/vms/vm_csb/run`,
    200, completedRun("", "boom", 2),
  );
  await assert.rejects(
    () => client.commands.run("false"),
    (err: unknown) => err instanceof CommandError && err.exitCode === 2 && err.output.includes("boom"),
  );
}

async function testRunBackgroundReturnsCommand(): Promise<void> {
  const f = new FakeFetch();
  const { client } = await makeSandboxAndClient(f);
  f.addJson(
    (m, u) => m === "POST" && u === `${BASE}/v1/vms/vm_csb/run`,
    200, bgRun("run_bg"),
  );
  const cmd: Command = await client.commands.runBackground("sleep 5", { name: "long" });
  assert.equal(cmd.name, "long");
  assert.equal(cmd.status, "RUNNING");
  assert.equal(client.commands.get("long"), cmd);
  assert.deepEqual(await client.commands.getAll(), [cmd]);
}

// ----- Filesystem -----

async function testWriteThenReadText(): Promise<void> {
  const f = new FakeFetch();
  const { client } = await makeSandboxAndClient(f);
  f.addJson(
    (m, u) => m === "POST" && u === `${BASE}/v1/vms/vm_csb/sync`,
    200, { results: [{ complete: true, written: true }] },
  );
  await client.fs.writeTextFile("/sandbox/x.txt", "data");
  f.addJson(
    (m, u) => m === "POST" && u === `${BASE}/v1/vms/vm_csb/sync`,
    200, { content: "data", encoding: "utf-8" },
  );
  assert.equal(await client.fs.readTextFile("/sandbox/x.txt"), "data");
}

async function testReaddirParses(): Promise<void> {
  const f = new FakeFetch();
  const { client } = await makeSandboxAndClient(f);
  f.addJson(
    (m, u) => m === "POST" && u === `${BASE}/v1/vms/vm_csb/run`,
    200, completedRun("readme.txt|f\nsrc|d\nlinky|l\n"),
  );
  const entries: ReaddirEntry[] = await client.fs.readdir("/sandbox");
  // codesandbox: type is "file" | "directory" only; symlinks carry isSymlink: true.
  assert.deepEqual(entries, [
    { name: "readme.txt", type: "file", isSymlink: false },
    { name: "src", type: "directory", isSymlink: false },
    { name: "linky", type: "file", isSymlink: true },
  ]);
}

async function testStatParses(): Promise<void> {
  const f = new FakeFetch();
  const { client } = await makeSandboxAndClient(f);
  f.addJson(
    (m, u) => m === "POST" && u === `${BASE}/v1/vms/vm_csb/run`,
    200, completedRun("f|42|1735776100.0|1735776000.0|1735776200.0\n"),
  );
  const info: FSStatResult = await client.fs.stat("/sandbox/x.txt");
  assert.equal(info.type, "file");
  assert.equal(info.size, 42);
  assert.equal(info.mtime, 1735776100);
}

async function testMkdirRecursive(): Promise<void> {
  const f = new FakeFetch();
  const { client } = await makeSandboxAndClient(f);
  f.addJson((m, u) => m === "POST" && u === `${BASE}/v1/vms/vm_csb/run`, 200, completedRun());
  await client.fs.mkdir("/sandbox/deep", true);
  const body = JSON.parse(f.calls[f.calls.length - 1]!.body!);
  assert.equal(body.command, "mkdir -p '/sandbox/deep'");
}

async function testCopyRecursive(): Promise<void> {
  const f = new FakeFetch();
  const { client } = await makeSandboxAndClient(f);
  f.addJson((m, u) => m === "POST" && u === `${BASE}/v1/vms/vm_csb/run`, 200, completedRun());
  await client.fs.copy("/src", "/dst", true);
  const body = JSON.parse(f.calls[f.calls.length - 1]!.body!);
  // Default overwrite=false → `cp -r -n` (no clobber, matches codesandbox).
  assert.equal(body.command, "cp -r -n '/src' '/dst'");
}

async function testWatchThrows(): Promise<void> {
  const f = new FakeFetch();
  const { client } = await makeSandboxAndClient(f);
  assert.throws(() => client.fs.watch("/sandbox"), /watch/);
}

// ----- Unsupported namespaces -----

async function testShellsThrows(): Promise<void> {
  const f = new FakeFetch();
  const { client } = await makeSandboxAndClient(f);
  // @ts-expect-error — accessing namespace stub
  assert.throws(() => client.shells.run("ls"), /shells/);
}

async function testPortsThrows(): Promise<void> {
  const f = new FakeFetch();
  const { client } = await makeSandboxAndClient(f);
  // @ts-expect-error — accessing namespace stub
  assert.throws(() => client.ports.list(), /ports/);
}

async function testHostsThrows(): Promise<void> {
  const f = new FakeFetch();
  const csb = new CodeSandbox(undefined, { _arker: makeArker(f) });
  // @ts-expect-error — accessing namespace stub
  assert.throws(() => csb.hosts.token(), /hosts/);
}

async function testListPaginationAlwaysPresent(): Promise<void> {
  const f = new FakeFetch();
  f.addJson(
    (m, u) => m === "GET" && u === `${BASE}/v1/vms`,
    200,
    {
      vms: Array.from({ length: 3 }, (_, i) => ({
        vm_id: `vm_${i}`, owner_id: "o", created_at: "now",
        state: "running", sessions: [],
      })),
    },
  );
  const csb = new CodeSandbox(undefined, { _arker: makeArker(f) });
  // No pagination arg — pagination should still be returned.
  const resp = await csb.sandboxes.list();
  assert.ok(resp.pagination);
  assert.equal(resp.pagination.currentPage, 1);
  assert.equal(resp.hasMore, false);
}

async function testListUnsupportedFiltersThrow(): Promise<void> {
  const f = new FakeFetch();
  const csb = new CodeSandbox(undefined, { _arker: makeArker(f) });
  await assert.rejects(() => csb.sandboxes.list({ status: "running" }), /status/);
  await assert.rejects(() => csb.sandboxes.list({ orderBy: "updated_at" }), /orderBy/);
  await assert.rejects(() => csb.sandboxes.list({ direction: "asc" }), /direction/);
}

async function testStatHasIsSymlink(): Promise<void> {
  const f = new FakeFetch();
  const { client } = await makeSandboxAndClient(f);
  f.addJson(
    (m, u) => m === "POST" && u === `${BASE}/v1/vms/vm_csb/run`,
    200, completedRun("l|10|1735776100.0|1735776000.0|1735776200.0\n"),
  );
  const info = await client.fs.stat("/sandbox/link");
  assert.equal(info.isSymlink, true);
  // type is the resolved kind ("file" as best-effort), not "symlink".
  assert.equal(info.type, "file");
}

async function testWriteFileOverwriteFalseThrowsWhenExists(): Promise<void> {
  const f = new FakeFetch();
  const { client } = await makeSandboxAndClient(f);
  // test -e returns 0 → encode as stdout="0\n"
  f.addJson((m, u) => m === "POST" && u === `${BASE}/v1/vms/vm_csb/run`, 200, completedRun("0\n"));
  await assert.rejects(
    () => client.fs.writeTextFile("/x.txt", "data", { overwrite: false }),
    /overwrite=false/,
  );
}

async function testRenameDefaultNoClobber(): Promise<void> {
  const f = new FakeFetch();
  const { client } = await makeSandboxAndClient(f);
  f.addJson((m, u) => m === "POST" && u === `${BASE}/v1/vms/vm_csb/run`, 200, completedRun());
  await client.fs.rename("/a", "/b");
  const body = JSON.parse(f.calls[f.calls.length - 1]!.body!);
  assert.equal(body.command, "mv -n '/a' '/b'");
}

async function testCreateWithNonDefaultPrivacyWarns(): Promise<void> {
  const f = new FakeFetch();
  scriptFork(f);
  const csb = new CodeSandbox(undefined, { _arker: makeArker(f) });
  // Capture console.warn output.
  const originalWarn = console.warn;
  const warnings: string[] = [];
  console.warn = (...args: unknown[]) => { warnings.push(args.join(" ")); };
  try {
    await csb.sandboxes.create({ privacy: "private" });
  } finally {
    console.warn = originalWarn;
  }
  assert.ok(warnings.some((w) => w.includes("privacy")));
}

// ----- Run all -----

await testCreate();
await testCreateWithTemplateId();
await testGetReturnsMetadataInfo();
await testGet404Throws();
await testResumeSetsBootupResume();
await testDelete();
await testListPaginated();
await testListTagsThrows();
await testConnectReturnsClient();
await testUpdateTierThrows();
await testRunReturnsOutputString();
await testRunArrayForm();
await testRunThrowsCommandError();
await testRunBackgroundReturnsCommand();
await testWriteThenReadText();
await testReaddirParses();
await testStatParses();
await testMkdirRecursive();
await testCopyRecursive();
await testWatchThrows();
await testShellsThrows();
await testPortsThrows();
await testHostsThrows();
await testListPaginationAlwaysPresent();
await testListUnsupportedFiltersThrow();
await testStatHasIsSymlink();
await testWriteFileOverwriteFalseThrowsWhenExists();
await testRenameDefaultNoClobber();
await testCreateWithNonDefaultPrivacyWarns();

console.log("PASS unit_codesandbox");
