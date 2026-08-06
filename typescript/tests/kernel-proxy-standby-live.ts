/**
 * Live adversarial standby/resume stress test for the Kernel proxy.
 *
 * Required: ARKER_API_KEY and KERNEL_PROXY_ARKER_SOURCE_ID. This uses the
 * automatic-standby default, repeatedly leaves the VM idle long enough to suspend,
 * then races all major
 * browser access paths on resume, restarts the proxy, and cleans its child VM.
 */
import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import Kernel from "@onkernel/sdk";
import { WebSocket } from "ws";

import { Arker } from "../src/index.js";
import { startKernelProxy } from "../src/kernel-proxy.js";

const arkerApiKey = process.env.ARKER_API_KEY;
const sourceVmId = process.env.KERNEL_PROXY_ARKER_SOURCE_ID;
if (!arkerApiKey) throw new Error("ARKER_API_KEY is required");
if (!sourceVmId) throw new Error("KERNEL_PROXY_ARKER_SOURCE_ID is required");

const arkerBaseUrl = process.env.ARKER_BASE_URL ?? "https://aws-us-east-1.arker.ai/api";
const cycles = Number(process.env.KERNEL_PROXY_STANDBY_CYCLES ?? "12");
if (!Number.isInteger(cycles) || cycles < 1 || cycles > 100) throw new Error("KERNEL_PROXY_STANDBY_CYCLES must be 1..100");
const configuredStandbyDelay = process.env.KERNEL_PROXY_STANDBY_DELAY_MS;
const proxyStandbyDelayMs = configuredStandbyDelay === undefined ? undefined : Number(configuredStandbyDelay);
if (proxyStandbyDelayMs !== undefined && (!Number.isInteger(proxyStandbyDelayMs) || proxyStandbyDelayMs < 0 || proxyStandbyDelayMs > 60_000)) {
  throw new Error("KERNEL_PROXY_STANDBY_DELAY_MS must be an integer from 0 to 60000");
}
const effectiveStandbyDelayMs = proxyStandbyDelayMs ?? 5_000;
const idleMs = Number(process.env.KERNEL_PROXY_STANDBY_IDLE_MS ?? String(effectiveStandbyDelayMs + 3_000));
if (!Number.isInteger(idleMs) || idleMs < effectiveStandbyDelayMs + 1_000 || idleMs > 300_000) {
  throw new Error("KERNEL_PROXY_STANDBY_IDLE_MS must be at least 1000 ms longer than the standby delay and no more than 300000");
}
const headed = /^(?:1|true|yes)$/i.test(process.env.KERNEL_PROXY_STANDBY_HEADED ?? "");
const stateDirectory = await mkdtemp(join(tmpdir(), "arker-kernel-standby-live-"));
const proxyKey = randomBytes(24).toString("base64url");
const signingSecret = randomBytes(32).toString("base64url");
const name = `kernel-standby-live-${randomUUID().slice(0, 8)}`;
const marker = `standby-${randomUUID()}`;
const latencies: number[] = [];
let browserId: string | undefined;
let proxy: Awaited<ReturnType<typeof startKernelProxy>> | undefined;
let kernel: Kernel | undefined;

const percentile = (values: number[], fraction: number): number => {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(sorted.length * fraction) - 1))] ?? 0;
};
const output = (value?: string) => Buffer.from(value || "", "base64").toString();
const progress = (stage: string, details: Record<string, unknown> = {}) => console.log(JSON.stringify({ stage, ...details }));

async function websocketRoundTrip(url: string, request: Record<string, unknown>, expectedId: number): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(url);
    const timer = setTimeout(() => {
      socket.terminate();
      reject(new Error(`WebSocket timeout for ${url}`));
    }, 30_000);
    socket.once("open", () => socket.send(JSON.stringify(request)));
    socket.on("message", (data) => {
      const message = JSON.parse(Buffer.from(data as Uint8Array).toString()) as Record<string, unknown>;
      if (message.id !== expectedId) return;
      clearTimeout(timer);
      socket.close();
      if (message.error) reject(new Error(JSON.stringify(message.error)));
      else resolve(message);
    });
    socket.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
  });
}

async function openProxy(): Promise<void> {
  proxy = await startKernelProxy({
    arkerApiKey,
    arkerBaseUrl,
    apiKey: proxyKey,
    signingSecret,
    sourceVmId,
    sourceLayers: ["disk", "memory"],
    stateDirectory,
    automaticStandby: true,
    ...(proxyStandbyDelayMs === undefined ? {} : { standbyDelayMs: proxyStandbyDelayMs }),
    host: "127.0.0.1",
    port: 0,
  });
  const address = proxy.server.address();
  if (!address || typeof address === "string") throw new Error("proxy did not bind");
  kernel = new Kernel({ apiKey: proxyKey, baseURL: `http://127.0.0.1:${address.port}`, maxRetries: 0, timeout: 300_000 });
}

async function exerciseCycle(index: number): Promise<void> {
  assert(kernel && browserId);
  const browser = await kernel.browsers.retrieve(browserId);
  const started = performance.now();
  const operationMs: Record<string, number> = {};
  const measured = async <T>(name: string, operation: () => Promise<T>): Promise<T> => {
    const operationStarted = performance.now();
    try { return await operation(); }
    finally { operationMs[name] = Number((performance.now() - operationStarted).toFixed(2)); }
  };
  const [file, processResult, playwright, cdp, bidi] = await Promise.all([
    measured("filesystem_ms", () => kernel!.browsers.fs.readFile(browserId!, { path: "/tmp/kernel-standby-marker" })),
    measured("process_ms", () => kernel!.browsers.process.exec(browserId!, {
      command: "bash",
      args: ["-lc", [
        "set -e",
        "test -x /opt/arker-kernel/start-services.sh",
        "test -d /opt/arker-kernel/node_modules/playwright-core",
        "test -x /usr/local/bin/chromedriver",
        "dpkg-query -W >/dev/null",
        "test \"$(cat /tmp/kernel-standby-marker)\" = \"$EXPECTED\"",
        "printf durable",
      ].join("; ")],
      env: { EXPECTED: marker },
    })),
    measured("playwright_ms", () => kernel!.browsers.playwright.execute(browserId!, {
      code: `return {memory:globalThis.__arkerStandbyMarker,local:await page.evaluate(()=>localStorage.getItem("arker-standby"))};`,
    })),
    measured("cdp_ms", () => websocketRoundTrip(browser.cdp_ws_url, { id: 1, method: "Browser.getVersion" }, 1)),
    measured("bidi_ms", () => websocketRoundTrip(browser.webdriver_ws_url, { id: 2, method: "session.status", params: {} }, 2)),
  ]);
  const elapsed = performance.now() - started;
  latencies.push(elapsed);
  assert.equal(Buffer.from(await file.arrayBuffer()).toString(), marker);
  assert.equal(processResult.exit_code, 0, output(processResult.stderr_b64));
  assert.equal(output(processResult.stdout_b64), "durable");
  assert.equal(playwright.success, true, String(playwright.error || "Playwright resume failed"));
  assert.deepEqual(playwright.result, { memory: marker, local: marker });
  assert((cdp.result as Record<string, unknown>)?.product);
  assert.equal(typeof (bidi.result as Record<string, unknown>)?.ready, "boolean");
  progress("resume-cycle", { cycle: index, ms: Number(elapsed.toFixed(2)), ...operationMs });
}

try {
  await openProxy();
  assert(kernel);
  const createStarted = performance.now();
  const browser = await kernel.browsers.create({
    name,
    headless: !headed,
    stealth: true,
    timeout_seconds: 1_800,
    viewport: { width: 1280, height: 720 },
  });
  browserId = browser.session_id;
  progress("browser-created", { browser_id: browserId, headed, ms: Number((performance.now() - createStarted).toFixed(2)) });
  await kernel.browsers.fs.writeFile(browserId, Buffer.from(marker), { path: "/tmp/kernel-standby-marker" });
  const initialized = await kernel.browsers.playwright.execute(browserId, {
    code: `globalThis.__arkerStandbyMarker=${JSON.stringify(marker)}; await page.goto("https://example.com"); await page.evaluate(value=>localStorage.setItem("arker-standby",value),${JSON.stringify(marker)}); return true;`,
  });
  assert.equal(initialized.result, true);
  progress("state-initialized");

  for (let cycle = 1; cycle <= cycles; cycle += 1) {
    await new Promise((resolve) => setTimeout(resolve, idleMs));
    await exerciseCycle(cycle);
  }

  const proxyInternals = proxy as unknown as {
    poolFillQueues: Map<string, Promise<void>>;
    serverSockets: Set<unknown>;
    webSockets: { clients: Set<unknown> };
    streamingResponses: Set<unknown>;
  };
  progress("proxy-close-start", {
    pool_fills: proxyInternals.poolFillQueues.size,
    sockets: proxyInternals.serverSockets.size,
    websocket_clients: proxyInternals.webSockets.clients.size,
    streams: proxyInternals.streamingResponses.size,
  });
  const closeWatchdog = setInterval(() => progress("proxy-close-wait", {
    pool_fills: proxyInternals.poolFillQueues.size,
    sockets: proxyInternals.serverSockets.size,
    websocket_clients: proxyInternals.webSockets.clients.size,
    streams: proxyInternals.streamingResponses.size,
  }), 5_000);
  closeWatchdog.unref?.();
  await proxy!.close().finally(() => clearInterval(closeWatchdog));
  proxy = undefined;
  progress("proxy-closed-mid-session");
  await openProxy();
  await exerciseCycle(cycles + 1);
  progress("proxy-restart-verified");

  await kernel!.browsers.deleteByID(browserId);
  browserId = undefined;
  const sorted = [...latencies].sort((a, b) => a - b);
  progress("summary", {
    cycles: latencies.length,
    min_ms: Number((sorted[0] ?? 0).toFixed(2)),
    p50_ms: Number(percentile(latencies, 0.5).toFixed(2)),
    p95_ms: Number(percentile(latencies, 0.95).toFixed(2)),
    max_ms: Number((sorted.at(-1) ?? 0).toFixed(2)),
  });
  console.log("PASS repeated Arker standby/resume parity");
} finally {
  if (browserId && kernel) await kernel.browsers.deleteByID(browserId).catch(() => undefined);
  await proxy?.close().catch(() => undefined);
  if (browserId) {
    const arker = new Arker({ apiKey: arkerApiKey, baseUrl: arkerBaseUrl, controlBaseUrl: arkerBaseUrl });
    const vm = await arker.getVm(browserId).catch(() => undefined);
    await vm?.delete().catch(() => undefined);
  }
  await rm(stateDirectory, { recursive: true, force: true });
}
