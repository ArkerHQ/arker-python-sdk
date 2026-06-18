import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { once } from "node:events";
import { fileURLToPath } from "node:url";

type CliResult = {
  code: number | null;
  stdout: string;
  stderr: string;
};

async function withServer(
  handler: (req: IncomingMessage, res: ServerResponse) => void,
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

async function runCli(baseUrl: string, args: string[]): Promise<CliResult> {
  const child = spawn("tsx", ["src/cli.ts", ...args], {
    cwd: fileURLToPath(new URL("..", import.meta.url)),
    env: {
      ...process.env,
      ARKER_API_KEY: "ark_live_test",
      ARKER_BASE_URL: baseUrl,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk) => { stdout += chunk; });
  child.stderr.on("data", (chunk) => { stderr += chunk; });
  const [code] = await once(child, "close") as [number | null];
  return { code, stdout, stderr };
}

async function readJson(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

async function testRunJsonIncludesMemoryMetadata(): Promise<void> {
  let body: unknown;
  await withServer(async (req, res) => {
    assert.equal(req.method, "POST");
    assert.equal(req.url, "/api/v1/vms/vm_1/runs");
    body = await readJson(req);
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({
      stdout: "hello\n",
      stdout_encoding: "utf-8",
      stderr: "",
      stderr_encoding: "utf-8",
      exit_code: 0,
      memory_requested_mib: 1024,
      memory_achieved_mib: 1536,
      memory_partial: true,
    }));
  }, async (baseUrl) => {
    const result = await runCli(baseUrl, ["run", "vm_1", "echo", "hello", "--json"]);
    assert.equal(result.code, 0);
    assert.equal(result.stderr, "");
    assert.deepEqual(body, { command: "echo hello" });
    const payload = JSON.parse(result.stdout);
    assert.equal(payload.memoryRequestedMib, 1024);
    assert.equal(payload.memoryAchievedMib, 1536);
    assert.equal(payload.memoryPartial, true);
  });
}

async function testRunHumanWarnsOnPartialMemory(): Promise<void> {
  await withServer((_req, res) => {
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({
      stdout: "hello\n",
      stdout_encoding: "utf-8",
      stderr: "",
      stderr_encoding: "utf-8",
      exit_code: 0,
      memory_requested_mib: 1024,
      memory_achieved_mib: 1536,
      memory_partial: true,
    }));
  }, async (baseUrl) => {
    const result = await runCli(baseUrl, ["run", "vm_1", "echo", "hello"]);
    assert.equal(result.code, 0);
    assert.equal(result.stdout, "hello\n");
    assert.match(result.stderr, /Memory target partially applied: requested 1024 MiB, achieved 1536 MiB\./);
  });
}

await testRunJsonIncludesMemoryMetadata();
await testRunHumanWarnsOnPartialMemory();

console.log("PASS cli");
