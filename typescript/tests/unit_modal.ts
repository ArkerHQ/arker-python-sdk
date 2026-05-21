/** Unit tests for `@arker-ai/sdk/modal` Phases A-D. */
import assert from "node:assert/strict";

import { Arker } from "../src/index.js";
import {
  ContainerProcess,
  type FileInfo,
  Image,
  NotFoundError,
  Sandbox,
  SandboxError,
} from "../src/modal/index.js";

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

function scriptFork(fetch: FakeFetch, template = "base", vmId = "vm_modal"): void {
  fetch.addJson(
    (m, u) => m === "POST" && u === `${BASE}/v1/vms/${template}/fork`,
    200,
    { vm_id: vmId, owner_id: "o", created_at: "now", sessions: [] },
  );
}

async function makeSandbox(fetch: FakeFetch, vmId = "vm_modal"): Promise<Sandbox> {
  scriptFork(fetch, "base", vmId);
  return Sandbox.create({ _arker: makeArker(fetch) });
}

// ----- Lifecycle -----

async function testCreateForksDefault(): Promise<void> {
  const fetch = new FakeFetch();
  const sbx = await makeSandbox(fetch);
  assert.equal(sbx.objectId, "vm_modal");
}

async function testCreateWithImageFromRegistry(): Promise<void> {
  const fetch = new FakeFetch();
  scriptFork(fetch, "my-image", "vm_img");
  const sbx = await Sandbox.create({
    image: Image.fromRegistry("my-image"),
    _arker: makeArker(fetch),
  });
  assert.equal(sbx.objectId, "vm_img");
}

async function testCreateIgnoresModalKwargs(): Promise<void> {
  const fetch = new FakeFetch();
  scriptFork(fetch);
  const sbx = await Sandbox.create({
    app: null,
    cpu: 2,
    memory: 4096,
    gpu: "T4",
    cloud: "aws",
    region: "us-west-2",
    blockNetwork: true,
    encryptedPorts: [8080],
    idleTimeout: 60,
    experimentalOptions: { foo: "bar" },
    _arker: makeArker(fetch),
  });
  assert.equal(sbx.objectId, "vm_modal");
}

async function testFromIdAttachesWithoutFork(): Promise<void> {
  const fetch = new FakeFetch();
  const sbx = await Sandbox.fromId("vm_existing", { _arker: makeArker(fetch) });
  assert.equal(sbx.objectId, "vm_existing");
  assert.equal(fetch.calls.length, 0);
}

async function testFromIdEmptyThrows(): Promise<void> {
  await assert.rejects(() => Sandbox.fromId(""), SandboxError);
}

async function testFromNameThrows(): Promise<void> {
  await assert.rejects(() => Sandbox.fromName("app", "name"), /not implemented/);
}

async function testTerminateCallsDelete(): Promise<void> {
  const fetch = new FakeFetch();
  const sbx = await makeSandbox(fetch);
  fetch.addJson(
    (m, u) => m === "DELETE" && u === `${BASE}/v1/vms/vm_modal`,
    200,
    { deleted: true },
  );
  // No entrypoint → returncode is null (matches modal).
  const code = await sbx.terminate();
  assert.equal(code, null);
}

// ----- Execution -----

async function testExecReturnsContainerProcess(): Promise<void> {
  const fetch = new FakeFetch();
  const sbx = await makeSandbox(fetch);
  fetch.addJson(
    (m, u) => m === "POST" && u === `${BASE}/v1/vms/vm_modal/run`,
    200,
    bgRun("run_a"),
  );
  const proc = await sbx.exec(["echo", "hello"]);
  assert.ok(proc instanceof ContainerProcess);
  const body = JSON.parse(fetch.calls[fetch.calls.length - 1]!.body!);
  assert.match(body.command, /'echo' 'hello'$/);
  assert.equal(body.background, true);
}

async function testExecInlinesEnvAndWorkdir(): Promise<void> {
  const fetch = new FakeFetch();
  const sbx = await makeSandbox(fetch);
  fetch.addJson(
    (m, u) => m === "POST" && u === `${BASE}/v1/vms/vm_modal/run`,
    200,
    bgRun("run_b"),
  );
  await sbx.exec(["ls"], { env: { K: "V" }, workdir: "/srv" });
  const body = JSON.parse(fetch.calls[fetch.calls.length - 1]!.body!);
  assert.match(body.command, /cd '\/srv' &&/);
  assert.match(body.command, /env 'K'='V'/);
}

async function testExecNoArgsThrows(): Promise<void> {
  const fetch = new FakeFetch();
  const sbx = await makeSandbox(fetch);
  await assert.rejects(() => sbx.exec([]));
}

async function testProcessWaitAndReadStdout(): Promise<void> {
  const fetch = new FakeFetch();
  const sbx = await makeSandbox(fetch);
  fetch.addJson(
    (m, u) => m === "POST" && u === `${BASE}/v1/vms/vm_modal/run`,
    200,
    bgRun("run_w"),
  );
  const proc = await sbx.exec(["echo", "hi"]);
  fetch.addJson(
    (m, u) => m === "GET" && u.includes("/runs/run_w"),
    200,
    runStatus("run_w", "hello\n", "", 0, true),
  );
  const out = await proc.stdout.read();
  assert.equal(out, "hello\n");
  assert.equal(proc.returncode, 0);
}

async function testStdinWriteThrows(): Promise<void> {
  const fetch = new FakeFetch();
  const sbx = await makeSandbox(fetch);
  fetch.addJson(
    (m, u) => m === "POST" && u === `${BASE}/v1/vms/vm_modal/run`,
    200,
    bgRun("run_s"),
  );
  const proc = await sbx.exec(["cat"]);
  await assert.rejects(() => proc.stdin.write(new Uint8Array([1, 2])), /stdin/);
}

// ----- Filesystem -----

async function testFilesystemReadAndWrite(): Promise<void> {
  const fetch = new FakeFetch();
  const sbx = await makeSandbox(fetch);
  fetch.addJson(
    (m, u) => m === "POST" && u === `${BASE}/v1/vms/vm_modal/sync`,
    200,
    { results: [{ complete: true, written: true }] },
  );
  await sbx.filesystem.writeText("payload", "/tmp/x");
  fetch.addJson(
    (m, u) => m === "POST" && u === `${BASE}/v1/vms/vm_modal/sync`,
    200,
    { content: "data", encoding: "utf-8" },
  );
  assert.equal(await sbx.filesystem.readText("/tmp/x"), "data");
}

async function testFilesystemListFiles(): Promise<void> {
  const fetch = new FakeFetch();
  const sbx = await makeSandbox(fetch);
  fetch.addJson(
    (m, u) => m === "POST" && u === `${BASE}/v1/vms/vm_modal/run`,
    200,
    // path|kind|size|mode|UID|GID|mtime|symlink
    completedRun(
      "/work/readme.txt|f|42|644|1000|1000|1735776000.0|\n" +
      "/work/src|d|4096|755|1000|1000|1735776100.0|\n",
    ),
  );
  const entries: FileInfo[] = await sbx.filesystem.listFiles("/work");
  assert.equal(entries.length, 2);
  assert.equal(entries[0]!.path, "/work/readme.txt");
  assert.equal(entries[0]!.name, "readme.txt");
  assert.equal(entries[0]!.size, 42);
  assert.equal(entries[0]!.mode, 0o644);
  assert.equal(entries[0]!.permissions, "0644");
  assert.equal(entries[0]!.isFile(), true);
  assert.equal(entries[1]!.isDir(), true);
}

async function testFilesystemStatRaisesNotFound(): Promise<void> {
  const fetch = new FakeFetch();
  const sbx = await makeSandbox(fetch);
  fetch.addJson(
    (m, u) => m === "POST" && u === `${BASE}/v1/vms/vm_modal/run`,
    200,
    completedRun("", "find: '/nope': No such file or directory", 1),
  );
  await assert.rejects(() => sbx.filesystem.stat("/nope"), NotFoundError);
}

async function testFilesystemMakeDirectoryAndRemove(): Promise<void> {
  const fetch = new FakeFetch();
  const sbx = await makeSandbox(fetch);
  fetch.addJson((m, u) => m === "POST" && u === `${BASE}/v1/vms/vm_modal/run`, 200, completedRun());
  await sbx.filesystem.makeDirectory("/work/new");
  let body = JSON.parse(fetch.calls[fetch.calls.length - 1]!.body!);
  assert.equal(body.command, "mkdir -p '/work/new'");

  fetch.addJson((m, u) => m === "POST" && u === `${BASE}/v1/vms/vm_modal/run`, 200, completedRun());
  await sbx.filesystem.remove("/tmp/junk", { recursive: true });
  body = JSON.parse(fetch.calls[fetch.calls.length - 1]!.body!);
  assert.equal(body.command, "rm -rf '/tmp/junk'");
}

// ----- Tags + listing + unsupported -----

function testSetGetTagsLocal(): void {
  const fetch = new FakeFetch();
  makeSandbox(fetch).then((sbx) => {
    sbx.setTags({ env: "test" });
    assert.deepEqual(sbx.getTags(), { env: "test" });
  });
}

async function testSandboxListReturnsList(): Promise<void> {
  const fetch = new FakeFetch();
  fetch.addJson(
    (m, u) => m === "GET" && u === `${BASE}/v1/vms`,
    200,
    {
      vms: [
        { vm_id: "vm_a", owner_id: "o", created_at: "now", state: "running", sessions: [] },
        { vm_id: "vm_b", owner_id: "o", created_at: "now", state: "running", sessions: [] },
      ],
    },
  );
  const items = await Sandbox.list({ _arker: makeArker(fetch) });
  assert.deepEqual(items.map((s) => s.objectId), ["vm_a", "vm_b"]);
}

async function testUnsupportedSurfaceThrows(): Promise<void> {
  const fetch = new FakeFetch();
  const sbx = await makeSandbox(fetch);
  await assert.rejects(() => sbx.tunnels(), /tunnels/);
  await assert.rejects(() => sbx.snapshotFilesystem(), /snapshotFilesystem/);
  await assert.rejects(() => sbx.mountImage("/", null), /mountImage/);
  await assert.rejects(() => sbx.createConnectToken(), /createConnectToken/);
  await assert.rejects(() => sbx.reloadVolumes(), /reloadVolumes/);
  assert.throws(() => sbx.open("/tmp/x"), /Sandbox.open is deprecated/);
  assert.throws(() => sbx.stdout, /Sandbox.stdout is not supported/);
}

// ----- Run -----

await testCreateForksDefault();
await testCreateWithImageFromRegistry();
await testCreateIgnoresModalKwargs();
await testFromIdAttachesWithoutFork();
await testFromIdEmptyThrows();
await testFromNameThrows();
await testTerminateCallsDelete();
await testExecReturnsContainerProcess();
await testExecInlinesEnvAndWorkdir();
await testExecNoArgsThrows();
await testProcessWaitAndReadStdout();
await testStdinWriteThrows();
await testFilesystemReadAndWrite();
await testFilesystemListFiles();
await testFilesystemStatRaisesNotFound();
await testFilesystemMakeDirectoryAndRemove();
testSetGetTagsLocal();
await testSandboxListReturnsList();
await testUnsupportedSurfaceThrows();

console.log("PASS unit_modal");
