import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { fileURLToPath } from "node:url";

type CliResult = {
  code: number | null;
  stdout: Buffer;
  stderr: string;
  stderrBytes: Buffer;
};

type CliOptions = {
  stdin?: string | Uint8Array;
  authenticated?: boolean;
};

type CapturedRequest = {
  method: string | undefined;
  url: string | undefined;
  body: unknown;
};

const packageRoot = fileURLToPath(new URL("..", import.meta.url));
const cliEntry = "dist/cli.js";
const cliRuntime = "node";

async function withServer(
  handler: (req: IncomingMessage, res: ServerResponse) => void | Promise<void>,
  fn: (baseUrl: string) => Promise<void>,
): Promise<void> {
  const server = createServer(handler);
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert.ok(address && typeof address === "object");
  try {
    await fn(`http://127.0.0.1:${address.port}/api`);
  } finally {
    server.close();
    await once(server, "close");
  }
}

async function withCapturedServer(
  responder: (request: CapturedRequest, res: ServerResponse) => void,
  fn: (baseUrl: string, requests: CapturedRequest[]) => Promise<void>,
): Promise<void> {
  const requests: CapturedRequest[] = [];
  await withServer(async (req, res) => {
    const request = {
      method: req.method,
      url: req.url,
      body: await readJson(req),
    };
    requests.push(request);
    res.setHeader("content-type", "application/json");
    responder(request, res);
  }, async (baseUrl) => fn(baseUrl, requests));
}

async function runCli(baseUrl: string | undefined, args: string[], options: CliOptions = {}): Promise<CliResult> {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    HOME: "/nonexistent/ark-202-cli-test-home",
    NODE_NO_WARNINGS: "1",
  };
  if (options.authenticated !== false) env.ARKER_API_KEY = "ark_live_test";
  else delete env.ARKER_API_KEY;
  if (baseUrl) {
    env.ARKER_BASE_URL = baseUrl;
    env.ARKER_CONTROL_BASE_URL = baseUrl;
  } else {
    delete env.ARKER_BASE_URL;
    delete env.ARKER_CONTROL_BASE_URL;
  }

  const child = spawn(cliRuntime, [cliEntry, ...args], {
    cwd: packageRoot,
    env,
    stdio: [options.stdin === undefined ? "ignore" : "pipe", "pipe", "pipe"],
  });
  if (options.stdin !== undefined) child.stdin!.end(options.stdin);
  const stdout: Buffer[] = [];
  const stderr: Buffer[] = [];
  child.stdout!.on("data", (chunk: Buffer) => { stdout.push(chunk); });
  child.stderr!.on("data", (chunk: Buffer) => { stderr.push(chunk); });
  const [code] = await once(child, "close") as [number | null];
  const stderrBytes = Buffer.concat(stderr);
  return {
    code,
    stdout: Buffer.concat(stdout),
    stderr: stderrBytes.toString("utf8"),
    stderrBytes,
  };
}

async function readJson(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  const text = Buffer.concat(chunks).toString("utf8");
  return text ? JSON.parse(text) : undefined;
}

function jsonResponse(res: ServerResponse, value: unknown, status = 200): void {
  res.statusCode = status;
  res.end(JSON.stringify(value));
}

function completedRun(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    state: "completed",
    stdout: "",
    stdout_encoding: "utf-8",
    stderr: "",
    stderr_encoding: "utf-8",
    exit_code: 0,
    ...overrides,
  };
}

function stdoutText(result: CliResult): string {
  return result.stdout.toString("utf8");
}

async function testRunOptionsStopAtRemoteCommand(): Promise<void> {
  await withCapturedServer((_request, res) => jsonResponse(res, completedRun()), async (baseUrl, requests) => {
    const result = await runCli(baseUrl, [
      "run",
      "--background",
      "--timeout",
      "1000",
      "vm_1",
      "npm",
      "--version",
    ]);
    assert.equal(result.code, 0, result.stderr);
    assert.deepEqual(requests, [{
      method: "POST",
      url: "/api/v1/vms/vm_1/runs",
      body: { background: true, timeout: 1000, command: "npm --version" },
    }]);
  });
}

async function testKnownFlagAfterRemoteCommandPassesThrough(): Promise<void> {
  await withCapturedServer((_request, res) => jsonResponse(res, completedRun()), async (baseUrl, requests) => {
    const result = await runCli(baseUrl, ["run", "vm_1", "echo", "hello", "--background"]);
    assert.equal(result.code, 0);
    assert.deepEqual(requests[0]?.body, { command: "echo hello --background" });
  });
}

async function testRunOptionAfterVmBeforeCommand(): Promise<void> {
  await withCapturedServer((_request, res) => jsonResponse(res, completedRun()), async (baseUrl, requests) => {
    const result = await runCli(baseUrl, ["run", "vm_1", "--session-idx", "0", "echo", "ok"]);
    assert.equal(result.code, 0);
    assert.deepEqual(requests[0]?.body, { session_idx: 0, command: "echo ok" });
  });
}

async function testRunOptionSeparator(): Promise<void> {
  await withCapturedServer((_request, res) => jsonResponse(res, completedRun()), async (baseUrl, requests) => {
    const result = await runCli(baseUrl, ["run", "vm_1", "--", "printf", "ok"]);
    assert.equal(result.code, 0);
    assert.deepEqual(requests[0]?.body, { command: "printf ok" });
  });
}

async function testRunPreservesArgumentBoundaries(): Promise<void> {
  await withCapturedServer((_request, res) => jsonResponse(res, completedRun()), async (baseUrl, requests) => {
    const result = await runCli(baseUrl, ["run", "vm_1", "printf", "%s", "hello world"]);
    assert.equal(result.code, 0);
    assert.deepEqual(requests[0]?.body, { command: "printf %s 'hello world'" });
  });
}

async function testUnknownRunOptionBeforeCommandFails(): Promise<void> {
  await withCapturedServer((_request, res) => jsonResponse(res, completedRun()), async (baseUrl, requests) => {
    const result = await runCli(baseUrl, ["run", "--backgroun", "vm_1", "echo", "ok"]);
    assert.equal(result.code, 1);
    assert.equal(requests.length, 0);
    assert.match(result.stderr, /unknown parameter "backgroun"/);
  });
}

async function testNestedRunStopsAtRemoteCommand(): Promise<void> {
  await withCapturedServer((_request, res) => jsonResponse(res, completedRun()), async (baseUrl, requests) => {
    const result = await runCli(baseUrl, ["vms", "run", "--background", "vm_1", "npm", "--version"]);
    assert.equal(result.code, 0, result.stderr);
    assert.deepEqual(requests[0]?.body, { background: true, command: "npm --version" });
  });
}

async function testKnownButIrrelevantNestedOptionsFail(): Promise<void> {
  for (const args of [
    ["vms", "get", "--background", "vm_1"],
    ["runs", "get", "--state", "failed", "vm_1", "run_1"],
    ["sessions", "get", "--cwd", "/tmp", "vm_1", "session_1"],
    ["syncs", "rm", "--path", "/mnt", "vm_1", "sync_1"],
    ["fs", "get", "--name", "data", "fs_1"],
  ]) {
    await withCapturedServer((_request, res) => jsonResponse(res, {}), async (baseUrl, requests) => {
      const result = await runCli(baseUrl, args);
      assert.equal(result.code, 1, args.join(" "));
      assert.equal(requests.length, 0, args.join(" "));
      assert.match(result.stderr, /is not valid for/, args.join(" "));
    });
  }
}

async function testInvalidNumbersFailBeforeRequest(): Promise<void> {
  for (const { args, flag } of [
    { args: ["run", "--timeout", "wat", "vm_1", "echo", "ok"], flag: "timeout" },
    { args: ["run", "--session-idx", "-1", "vm_1", "echo", "ok"], flag: "session-idx" },
    { args: ["run", "--time-to-background", "1.5", "vm_1", "echo", "ok"], flag: "time-to-background" },
    { args: ["ls", "--limit", "1001"], flag: "limit" },
    { args: ["fork", "--vcpu", "256", "ubuntu-full"], flag: "vcpu" },
    { args: ["update", "--memory-mib", "Infinity", "vm_1"], flag: "memory-mib" },
    { args: ["shell", "--rows", "0", "vm_1"], flag: "rows" },
  ]) {
    await withCapturedServer((_request, res) => jsonResponse(res, completedRun()), async (baseUrl, requests) => {
      const result = await runCli(baseUrl, args);
      assert.equal(result.code, 1);
      assert.equal(requests.length, 0);
      assert.match(result.stderr, new RegExp(flag));
    });
  }
}

async function testGlobalOptionsBeforeCommand(): Promise<void> {
  await withCapturedServer((_request, res) => jsonResponse(res, { vms: [] }), async (baseUrl, requests) => {
    const result = await runCli(baseUrl, ["--region", "us-west-2", "ls"]);
    assert.equal(result.code, 0);
    assert.equal(requests.length, 1);
    assert.match(requests[0]?.url ?? "", /region=us-west-2/);
  });
}

async function testHelpAndVersionAreLocalSuccesses(): Promise<void> {
  for (const args of [["--help"], ["-h"], ["run", "--help"]]) {
    const result = await runCli(undefined, args, { authenticated: false });
    assert.equal(result.code, 0, `${args.join(" ")} should succeed`);
    assert.match(stdoutText(result), /Usage:/);
    assert.equal(result.stderr, "");
  }
  for (const args of [["--version"], ["-v"]]) {
    const result = await runCli(undefined, args, { authenticated: false });
    assert.equal(result.code, 0, `${args.join(" ")} should succeed`);
    assert.match(stdoutText(result), /^arker 0\.8\.3\n$/);
    assert.equal(result.stderr, "");
  }
}

async function testRemovedSecretAndUrlFlagsFailLocally(): Promise<void> {
  for (const args of [
    ["--api-key", "secret", "ls"],
    ["--base-url", "http://localhost", "ls"],
    ["--control-base-url", "http://localhost", "ls"],
  ]) {
    const result = await runCli(undefined, args);
    assert.equal(result.code, 1);
    assert.match(result.stderr, /unknown parameter/);
  }
}

async function testHelpMatchesSupportedSurface(): Promise<void> {
  const result = await runCli(undefined, ["--help"], { authenticated: false });
  const help = stdoutText(result);
  assert.doesNotMatch(help, /network overrides/);
  assert.doesNotMatch(help, /--api-key|--base-url|--control-base-url|ssh-keys/);
  assert.match(help, /CLI options must appear before <command>/);
}

async function testRunJsonIncludesMemoryMetadata(): Promise<void> {
  let body: unknown;
  await withServer(async (req, res) => {
    body = await readJson(req);
    res.setHeader("content-type", "application/json");
    jsonResponse(res, completedRun({
      stdout: "hello\n",
      stderr: "warning\0",
      memory_requested_mib: 1024,
      memory_achieved_mib: 1536,
      memory_partial: true,
    }));
  }, async (baseUrl) => {
    const result = await runCli(baseUrl, ["run", "--json", "vm_1", "echo", "hello"]);
    assert.equal(result.code, 0);
    assert.equal(result.stderr, "");
    assert.deepEqual(body, { command: "echo hello" });
    const payload = JSON.parse(stdoutText(result));
    assert.equal(payload.stdout, "aGVsbG8K");
    assert.equal(payload.stdoutEncoding, "base64");
    assert.equal(payload.stderr, "d2FybmluZwA=");
    assert.equal(payload.stderrEncoding, "base64");
    assert.equal(payload.memoryRequestedMib, 1024);
    assert.equal(payload.memoryAchievedMib, 1536);
    assert.equal(payload.memoryPartial, true);
  });
}

async function testRunHumanWritesArbitraryBytes(): Promise<void> {
  await withCapturedServer((_request, res) => jsonResponse(res, completedRun({
    stdout: "/wD+",
    stdout_encoding: "base64",
    stderr: "gQD/",
    stderr_encoding: "base64",
  })), async (baseUrl) => {
    const result = await runCli(baseUrl, ["run", "vm_1", "binary"]);
    assert.equal(result.code, 0);
    assert.deepEqual(result.stdout, Buffer.from([0xff, 0x00, 0xfe]));
    assert.deepEqual(result.stderrBytes, Buffer.from([0x81, 0x00, 0xff]));
  });
}

async function testRunFailureReasonIsVisible(): Promise<void> {
  await withCapturedServer((_request, res) => jsonResponse(res, completedRun({
    state: "failed",
    exit_code: 1,
    fail_reason: "host disappeared",
  })), async (baseUrl) => {
    const result = await runCli(baseUrl, ["run", "vm_1", "false"]);
    assert.equal(result.code, 1);
    assert.equal(stdoutText(result), "");
    assert.equal(result.stderr, "arker: host disappeared\n");
  });
}

async function testRunsGetUsesRunFormatter(): Promise<void> {
  const response = completedRun({
    run_id: "run_1",
    stdout: "/wD+",
    stdout_encoding: "base64",
    stderr: "",
    stderr_encoding: "utf-8",
  });
  await withCapturedServer((_request, res) => jsonResponse(res, response), async (baseUrl) => {
    const human = await runCli(baseUrl, ["runs", "get", "vm_1", "run_1"]);
    assert.equal(human.code, 0);
    assert.deepEqual(human.stdout, Buffer.from([0xff, 0x00, 0xfe]));

    const json = await runCli(baseUrl, ["runs", "--json", "get", "vm_1", "run_1"]);
    assert.equal(json.code, 0);
    const payload = JSON.parse(stdoutText(json));
    assert.equal(payload.stdout, "/wD+");
    assert.equal(payload.stdoutEncoding, "base64");
  });
}

async function testRunHumanWarnsOnPartialMemory(): Promise<void> {
  await withCapturedServer((_request, res) => jsonResponse(res, completedRun({
    stdout: "hello\n",
    memory_requested_mib: 1024,
    memory_achieved_mib: 1536,
    memory_partial: true,
  })), async (baseUrl) => {
    const result = await runCli(baseUrl, ["run", "vm_1", "echo", "hello"]);
    assert.equal(result.code, 0);
    assert.equal(stdoutText(result), "hello\n");
    assert.match(result.stderr, /Memory target partially applied: requested 1024 MiB, achieved 1536 MiB\./);
  });
}

async function testEmptyPipedInputWritesZeroBytes(): Promise<void> {
  await withCapturedServer((_request, res) => jsonResponse(res, {
    results: [{ complete: true, written: true }],
  }), async (baseUrl, requests) => {
    const result = await runCli(baseUrl, ["sync", "vm_1", "/tmp/example.txt"], { stdin: "" });
    assert.equal(result.code, 0);
    assert.equal(stdoutText(result), "wrote 0 bytes to /tmp/example.txt\n");
    const requestBody = requests[0]?.body as { op?: unknown; writes?: Array<Record<string, unknown>> };
    assert.equal(typeof requestBody.writes?.[0]?.upload_id, "string");
    assert.deepEqual({
      ...requestBody,
      writes: requestBody.writes?.map((write) => ({ ...write, upload_id: "<generated>" })),
    }, {
      op: "write",
      writes: [{
        path: "/tmp/example.txt",
        size: 0,
        upload_id: "<generated>",
        content: "",
        start: 0,
        end: 0,
      }],
    });
  });
}

async function testStructuredErrorsDoNotRepeatCode(): Promise<void> {
  await withCapturedServer((_request, res) => jsonResponse(res, {
    code: "not_found",
    message: "VM missing",
  }, 404), async (baseUrl) => {
    const result = await runCli(baseUrl, ["run", "vm_missing", "true"]);
    assert.equal(result.code, 1);
    assert.equal(result.stderr, "arker: not_found: VM missing\n");
  });
}

async function testFalseMutationResultsExitNonzero(): Promise<void> {
  const cases = [
    { args: ["runs", "rm", "vm_1", "run_1"], response: { cancelled: false } },
    { args: ["sessions", "rm", "vm_1", "session_1"], response: { deleted: false } },
    { args: ["syncs", "rm", "vm_1", "sync_1"], response: { deleted: false } },
    { args: ["fs", "rm", "fs_1"], response: { deleted: false } },
  ];
  for (const testCase of cases) {
    await withCapturedServer((_request, res) => jsonResponse(res, testCase.response), async (baseUrl) => {
      const result = await runCli(baseUrl, testCase.args);
      assert.equal(result.code, 1, testCase.args.join(" "));
      assert.match(result.stderr, /failed/);
    });
  }
}

async function testRemainingHttpCommandSurface(): Promise<void> {
  const cases: Array<{
    name: string;
    args: string[];
    response: unknown;
    method: string;
    url: string;
    body?: unknown;
  }> = [
    {
      name: "vms get",
      args: ["vms", "get", "vm_1"],
      response: { vm_id: "vm_1", state: "idle" },
      method: "GET",
      url: "/api/v1/vms/vm_1",
    },
    {
      name: "vms rm",
      args: ["vms", "rm", "vm_1"],
      response: { deleted: true },
      method: "DELETE",
      url: "/api/v1/vms/vm_1",
    },
    {
      name: "vms fork",
      args: ["vms", "fork", "ubuntu-full"],
      response: { vm_id: "vm_child" },
      method: "POST",
      url: "/api/v1/fork",
    },
    {
      name: "vms update",
      args: ["vms", "update", "--memory-mib", "1024", "vm_1"],
      response: { vm_id: "vm_1", state: "idle", memory_mib: 1024 },
      method: "PATCH",
      url: "/api/v1/vms/vm_1",
      body: {
        resources: { vcpu: null, memory_mib: 1024, disk_mib: null },
        network: null,
      },
    },
    {
      name: "runs ls",
      args: ["runs", "ls", "vm_1"],
      response: { runs: [] },
      method: "GET",
      url: "/api/v1/vms/vm_1/runs",
    },
    {
      name: "sessions ls",
      args: ["sessions", "ls", "vm_1"],
      response: { sessions: [] },
      method: "GET",
      url: "/api/v1/vms/vm_1/sessions",
    },
    {
      name: "sessions get",
      args: ["sessions", "get", "vm_1", "session_1"],
      response: { session_id: "session_1", state: "idle", cwd: "/" },
      method: "GET",
      url: "/api/v1/vms/vm_1/sessions/session_1",
    },
    {
      name: "sessions create",
      args: ["sessions", "create", "--cwd", "/work", "vm_1"],
      response: { session_id: "session_1", state: "idle", cwd: "/work" },
      method: "POST",
      url: "/api/v1/vms/vm_1/sessions",
      body: { cwd: "/work" },
    },
    {
      name: "syncs ls",
      args: ["syncs", "ls", "vm_1"],
      response: { syncs: [] },
      method: "GET",
      url: "/api/v1/vms/vm_1/syncs",
    },
    {
      name: "syncs create",
      args: ["syncs", "create", "--filesystem-id", "fs_1", "--path", "/mnt", "vm_1"],
      response: { sync_id: "sync_1", filesystem_id: "fs_1", path: "/mnt" },
      method: "POST",
      url: "/api/v1/vms/vm_1/syncs",
      body: { filesystem_id: "fs_1", path: "/mnt" },
    },
    {
      name: "sync inline write",
      args: ["sync", "vm_1", "/tmp/file", "hello"],
      response: { results: [{ complete: true, written: true }] },
      method: "POST",
      url: "/api/v1/vms/vm_1/sync",
    },
    {
      name: "filesystems ls",
      args: ["fs", "ls"],
      response: { filesystems: [] },
      method: "GET",
      url: "/api/v1/filesystems",
    },
    {
      name: "filesystems create",
      args: ["fs", "create", "--name", "data"],
      response: { filesystem_id: "fs_1", name: "data" },
      method: "POST",
      url: "/api/v1/filesystems",
      body: { name: "data" },
    },
    {
      name: "filesystems get",
      args: ["fs", "get", "fs_1"],
      response: { filesystem_id: "fs_1", name: "data" },
      method: "GET",
      url: "/api/v1/filesystems/fs_1",
    },
  ];

  for (const testCase of cases) {
    await withCapturedServer((_request, res) => jsonResponse(res, testCase.response), async (baseUrl, requests) => {
      const result = await runCli(baseUrl, testCase.args);
      assert.equal(result.code, 0, `${testCase.name}: ${result.stderr}`);
      assert.equal(requests.length, 1, testCase.name);
      assert.equal(requests[0]?.method, testCase.method, testCase.name);
      assert.equal(requests[0]?.url, testCase.url, testCase.name);
      if (testCase.body !== undefined) assert.deepEqual(requests[0]?.body, testCase.body, testCase.name);
    });
  }
}

await testRunOptionsStopAtRemoteCommand();
await testKnownFlagAfterRemoteCommandPassesThrough();
await testRunOptionAfterVmBeforeCommand();
await testRunOptionSeparator();
await testRunPreservesArgumentBoundaries();
await testUnknownRunOptionBeforeCommandFails();
await testNestedRunStopsAtRemoteCommand();
await testKnownButIrrelevantNestedOptionsFail();
await testInvalidNumbersFailBeforeRequest();
await testGlobalOptionsBeforeCommand();
await testHelpAndVersionAreLocalSuccesses();
await testRemovedSecretAndUrlFlagsFailLocally();
await testHelpMatchesSupportedSurface();
await testRunJsonIncludesMemoryMetadata();
await testRunHumanWritesArbitraryBytes();
await testRunFailureReasonIsVisible();
await testRunsGetUsesRunFormatter();
await testRunHumanWarnsOnPartialMemory();
await testEmptyPipedInputWritesZeroBytes();
await testStructuredErrorsDoNotRepeatCode();
await testFalseMutationResultsExitNonzero();
await testRemainingHttpCommandSurface();

console.log("PASS cli");
