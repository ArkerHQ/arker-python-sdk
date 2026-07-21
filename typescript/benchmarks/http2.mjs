import assert from "node:assert/strict";
import http2 from "node:http2";
import os from "node:os";
import { once } from "node:events";
import { performance } from "node:perf_hooks";
import { fileURLToPath, pathToFileURL } from "node:url";

function argument(name, fallback) {
  const index = process.argv.indexOf(name);
  return index === -1 ? fallback : process.argv[index + 1];
}

const QUICK = process.argv.includes("--quick");
const JSON_ONLY = process.argv.includes("--json");
const ASSERT_INVARIANTS = process.argv.includes("--assert");
const QUIET = process.argv.includes("--quiet");
const SDK_PATH = argument("--sdk", fileURLToPath(new URL("../dist/index.js", import.meta.url)));
const { Arker } = await import(pathToFileURL(SDK_PATH).href);

const caseFilter = argument("--case");
const allCases = QUICK
  ? [
      { name: "sequential-small", requests: 200, concurrency: 1, payloadBytes: 16 },
      { name: "multiplex-8-small", requests: 400, concurrency: 8, payloadBytes: 16 },
    ]
  : [
      { name: "sequential-small", requests: 10_000, concurrency: 1, payloadBytes: 16 },
      { name: "multiplex-8-small", requests: 4_000, concurrency: 8, payloadBytes: 16 },
      { name: "multiplex-32-small", requests: 4_000, concurrency: 32, payloadBytes: 16 },
      { name: "sequential-1mib", requests: 100, concurrency: 1, payloadBytes: 1024 * 1024 },
      { name: "multiplex-8-1mib", requests: 100, concurrency: 8, payloadBytes: 1024 * 1024 },
      { name: "multiplex-8-chunked", requests: 500, concurrency: 8, payloadBytes: 64 * 1024, chunks: 16 },
    ];
const cases = caseFilter ? allCases.filter((entry) => entry.name === caseFilter) : allCases;
assert.ok(cases.length > 0, `unknown benchmark case: ${caseFilter}`);

const warnings = [];
process.on("warning", (warning) => {
  if (warning.name === "MaxListenersExceededWarning") warnings.push(warning);
});

function percentile(values, percentileValue) {
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.min(sorted.length - 1, Math.floor(sorted.length * percentileValue / 100));
  return sorted[index] ?? 0;
}

function round(value, digits = 2) {
  return Number(value.toFixed(digits));
}

function responseBody(payloadBytes) {
  return JSON.stringify({
    stdout: "x".repeat(payloadBytes),
    stdout_encoding: "utf-8",
    stderr: "",
    stderr_encoding: "utf-8",
    exit_code: 0,
  });
}

function forceGc() {
  if (globalThis.Bun?.gc) globalThis.Bun.gc(true);
  else if (globalThis.gc) globalThis.gc();
}

async function listen(server) {
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert.ok(address && typeof address === "object");
  return address.port;
}

function trackSessions(server) {
  const active = new Set();
  let opened = 0;
  server.on("session", (session) => {
    opened++;
    active.add(session);
    session.on("close", () => active.delete(session));
  });
  return { active, opened: () => opened };
}

async function shutdown(server, sessions) {
  for (const session of sessions.active) session.destroy();
  await new Promise((resolve) => server.close(resolve));
}

async function writeChunked(stream, body, chunks) {
  const chunkBytes = Math.ceil(body.length / chunks);
  for (let offset = 0; offset < body.length; offset += chunkBytes) {
    stream.write(body.slice(offset, offset + chunkBytes));
    await new Promise((resolve) => setImmediate(resolve));
  }
  stream.end();
}

async function runRequests(client, count, concurrency, latencies) {
  let next = 0;
  await Promise.all(Array.from({ length: concurrency }, async () => {
    while (true) {
      const requestIndex = next++;
      if (requestIndex >= count) return;
      const started = performance.now();
      await client.vm("vm_benchmark").run("printf x");
      latencies.push(performance.now() - started);
    }
  }));
}

async function runCase(config) {
  const body = responseBody(config.payloadBytes);
  const server = http2.createServer();
  const sessions = trackSessions(server);
  server.on("stream", (stream) => {
    stream.respond({ ":status": 200, "content-type": "application/json" });
    if (config.chunks) void writeChunked(stream, body, config.chunks).catch((error) => stream.destroy(error));
    else stream.end(body);
  });
  const port = await listen(server);
  const client = new Arker({
    apiKey: "ark_live_benchmark",
    baseUrl: `http://127.0.0.1:${port}/api`,
    retry: false,
  });

  try {
    const warningCountBefore = warnings.length;
    const warmupRequests = config.payloadBytes <= 64 * 1024
      ? Math.min(1_000, config.requests)
      : Math.min(20, config.requests);
    await runRequests(client, warmupRequests, config.concurrency, []);
    forceGc();
    const memoryBefore = process.memoryUsage();
    const cpuBefore = process.cpuUsage();
    const latencies = [];
    const windows = [];
    const windowSize = Math.max(config.concurrency, Math.min(500, Math.ceil(config.requests / 10)));
    const started = performance.now();

    for (let offset = 0; offset < config.requests; offset += windowSize) {
      const requests = Math.min(windowSize, config.requests - offset);
      const windowStarted = performance.now();
      await runRequests(client, requests, config.concurrency, latencies);
      const windowElapsedMs = performance.now() - windowStarted;
      windows.push(requests / (windowElapsedMs / 1000));
    }

    const elapsedMs = performance.now() - started;
    const cpu = process.cpuUsage(cpuBefore);
    forceGc();
    const memoryAfter = process.memoryUsage();
    const firstWindowRps = windows[0] ?? 0;
    const lastWindowRps = windows.at(-1) ?? 0;

    return {
      name: config.name,
      warmupRequests,
      requests: config.requests,
      concurrency: config.concurrency,
      payloadBytes: config.payloadBytes,
      chunks: config.chunks ?? 1,
      sessionsOpened: sessions.opened(),
      warningCount: warnings.length - warningCountBefore,
      elapsedMs: round(elapsedMs),
      requestsPerSecond: round(config.requests / (elapsedMs / 1000)),
      latencyMs: {
        p50: round(percentile(latencies, 50), 3),
        p95: round(percentile(latencies, 95), 3),
        p99: round(percentile(latencies, 99), 3),
      },
      cpuMicrosPerRequest: round((cpu.user + cpu.system) / config.requests),
      rssDeltaBytes: memoryAfter.rss - memoryBefore.rss,
      heapUsedDeltaBytes: memoryAfter.heapUsed - memoryBefore.heapUsed,
      firstWindowRps: round(firstWindowRps),
      lastWindowRps: round(lastWindowRps),
      lastToFirstThroughputRatio: firstWindowRps === 0 ? 0 : round(lastWindowRps / firstWindowRps, 4),
    };
  } finally {
    await shutdown(server, sessions);
  }
}

const results = [];
for (const benchmarkCase of cases) results.push(await runCase(benchmarkCase));

const report = {
  generatedAt: new Date().toISOString(),
  runtime: process.versions.bun ? `bun-${process.versions.bun}` : `node-${process.versions.node}`,
  sdkPath: SDK_PATH,
  platform: `${process.platform}-${process.arch}`,
  cpu: os.cpus()[0]?.model ?? "unknown",
  quick: QUICK,
  results,
};

if (ASSERT_INVARIANTS) {
  for (const result of results) {
    assert.equal(result.warningCount, 0, `${result.name} emitted listener warnings`);
    assert.equal(result.sessionsOpened, 1, `${result.name} opened ${result.sessionsOpened} sessions`);
  }
}

if (QUIET) {
  // Assertions above are the output contract for CI-sized runs.
} else if (JSON_ONLY) {
  console.log(JSON.stringify(report));
} else {
  console.log(JSON.stringify(report, null, 2));
}

process.exit(0);
