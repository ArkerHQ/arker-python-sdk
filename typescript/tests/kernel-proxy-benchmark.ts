/**
 * Live benchmark for the prepared-source path.
 *
 * Required: ARKER_API_KEY and KERNEL_PROXY_ARKER_SOURCE_ID.
 * Optional: KERNEL_PROXY_BENCH_MEMORY_MIB (default: 1024).
 */
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
const memoryCases = (process.env.KERNEL_PROXY_BENCH_MEMORY_MIB ?? "1024")
  .split(",")
  .map(Number)
  .filter((value) => Number.isInteger(value) && value >= 128);
if (memoryCases.length === 0) throw new Error("KERNEL_PROXY_BENCH_MEMORY_MIB has no valid values");
const setupMemoryMib = Number(process.env.KERNEL_PROXY_BENCH_SETUP_MEMORY_MIB ?? "4096");
if (!Number.isInteger(setupMemoryMib) || setupMemoryMib < 128) throw new Error("KERNEL_PROXY_BENCH_SETUP_MEMORY_MIB must be an integer of at least 128");
const stress = /^(?:1|true|yes)$/i.test(process.env.KERNEL_PROXY_BENCH_STRESS ?? "");
const arker = new Arker({ apiKey: arkerApiKey, baseUrl: arkerBaseUrl, controlBaseUrl: arkerBaseUrl });
const source = await arker.getVm(sourceVmId);
console.log(JSON.stringify({
  provider: "arker",
  stage: "source",
  source_vm_id: source.id,
  min_memory_mib: source.min_memory_mib ?? null,
  resources: source.resources ?? null,
}));

const percentile = (values: number[], fraction: number): number => {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(sorted.length * fraction) - 1))] ?? 0;
};

async function bidiRoundTrip(url: string): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const socket = new WebSocket(url);
    const timer = setTimeout(() => { socket.terminate(); reject(new Error("BiDi timeout")); }, 15_000);
    socket.once("open", () => socket.send(JSON.stringify({ id: 1, method: "session.status", params: {} })));
    socket.on("message", (data) => {
      const message = JSON.parse(Buffer.from(data as Uint8Array).toString()) as { id?: number; error?: unknown };
      if (message.id !== 1) return;
      clearTimeout(timer);
      socket.close();
      if (message.error) reject(new Error(JSON.stringify(message.error)));
      else resolve();
    });
    socket.once("error", reject);
  });
}

for (const memoryMib of memoryCases) {
  const stateDirectory = await mkdtemp(join(tmpdir(), "arker-kernel-benchmark-"));
  const proxyKey = randomBytes(24).toString("base64url");
  const proxy = await startKernelProxy({
    arkerApiKey,
    arkerBaseUrl,
    apiKey: proxyKey,
    signingSecret: randomBytes(32).toString("base64url"),
    sourceVmId,
    sourceLayers: ["disk", "memory"],
    setupMemoryMib,
    runtimeMemoryMib: memoryMib,
    runtimeVcpu: 1,
    // This benchmark isolates hot-path latency. Standby/resume latency is
    // covered independently by kernel-proxy-standby-live.ts.
    automaticStandby: false,
    stateDirectory,
    host: "127.0.0.1",
    port: 0,
  });
  const address = proxy.server.address();
  if (!address || typeof address === "string") throw new Error("proxy did not bind");
  const kernel = new Kernel({
    apiKey: proxyKey,
    baseURL: `http://127.0.0.1:${address.port}`,
    maxRetries: 0,
    timeout: 300_000,
  });
  const name = `kernel-benchmark-${memoryMib}-${randomUUID().slice(0, 8)}`;
  let browserId: string | undefined;
  try {
    const createStarted = performance.now();
    const browser = await kernel.browsers.create({
      name,
      headless: true,
      stealth: true,
      timeout_seconds: 900,
      viewport: { width: 1280, height: 720 },
    });
    browserId = browser.session_id;
    const createMs = performance.now() - createStarted;
    const bidiStarted = performance.now();
    await bidiRoundTrip(browser.webdriver_ws_url);
    const bidiMs = performance.now() - bidiStarted;
    let workloadMs: number | undefined;
    if (stress) {
      const workloadStarted = performance.now();
      const workload = await kernel.browsers.playwright.execute(browserId, {
        code: `
          await page.evaluate(() => {
            document.documentElement.innerHTML = '<head></head><body><main id="root"></main></body>';
            const root = document.querySelector('#root');
            for (let i = 0; i < 5000; i++) {
              const node = document.createElement('div');
              node.textContent = 'realistic-browser-node-' + i + '-' + 'x'.repeat(80);
              root.appendChild(node);
            }
          });
          for (let i = 0; i < 2; i++) {
            const extra = await context.newPage();
            await extra.evaluate(() => {
              document.body.innerHTML = '<canvas width="1280" height="720"></canvas><p></p>';
              document.querySelector('p').textContent = 'content '.repeat(10000);
              const canvas = document.querySelector('canvas');
              const drawing = canvas.getContext('2d');
              drawing.fillStyle = '#4f46e5';
              drawing.fillRect(0, 0, canvas.width, canvas.height);
            });
          }
          return { pages: context.pages().length, nodes: await page.locator('*').count() };
        `,
        timeout_sec: 60,
      });
      workloadMs = performance.now() - workloadStarted;
      if (!workload.success || Number((workload.result as { pages?: unknown } | undefined)?.pages) < 3) {
        throw new Error(`stress workload failed: ${JSON.stringify(workload).slice(0, 800)}`);
      }
    }
    const operationMs: number[] = [];
    for (let index = 0; index < 20; index += 1) {
      const started = performance.now();
      const result = await kernel.browsers.playwright.execute(browserId, {
        code: stress
          ? `return { index: ${index}, title: await page.title(), nodes: await page.locator('*').count() };`
          : `return ${index};`,
        timeout_sec: 30,
      });
      if (!result.success || (stress
        ? (result.result as { index?: unknown } | undefined)?.index !== index
        : result.result !== index)) throw new Error(`Playwright operation ${index} failed`);
      operationMs.push(performance.now() - started);
    }
    const stateMarker = randomUUID();
    await kernel.browsers.playwright.execute(browserId, {
      code: `globalThis.__arkerBenchmark=${JSON.stringify(stateMarker)}; return true;`,
    });
    await new Promise((resolve) => setTimeout(resolve, 8_000));
    const idleStarted = performance.now();
    const idle = await kernel.browsers.playwright.execute(browserId, { code: "return globalThis.__arkerBenchmark;" });
    const idleMs = performance.now() - idleStarted;
    if (idle.result !== stateMarker) throw new Error("browser state was not preserved across the idle interval");
    const resources = await kernel.browsers.process.exec(browserId, {
      command: "bash",
      args: ["-lc", [
        "grep -E '^(MemTotal|MemAvailable|SwapTotal|SwapFree):' /proc/meminfo",
        "printf '%s\\n' '[swap-devices]'",
        "cat /proc/swaps",
        "printf '%s\\n' '[cgroup]'",
        "for f in memory.current memory.peak memory.max memory.swap.current memory.swap.max memory.events; do p=/sys/fs/cgroup/$f; if test -r $p; then printf '%s=' $f; tr '\\n' ',' < $p; printf '\\n'; fi; done",
        "ps -eo rss= | awk '{ total += $1 } END { printf \"rss_total_kib=%d\\n\", total }'",
        "ps -eo rss=,comm= --sort=-rss | head -12",
      ].join("; ")],
    });
    console.log(JSON.stringify({
      provider: "arker",
      stage: "prepared-source",
      memory_mib: memoryMib,
      vcpu: 1,
      stress,
      ok: true,
      create_ms: Number(createMs.toFixed(2)),
      bidi_ms: Number(bidiMs.toFixed(2)),
      ...(workloadMs === undefined ? {} : { workload_ms: Number(workloadMs.toFixed(2)) }),
      operation_p50_ms: Number(percentile(operationMs, 0.5).toFixed(2)),
      operation_p95_ms: Number(percentile(operationMs, 0.95).toFixed(2)),
      operation_ms: operationMs.map((value) => Number(value.toFixed(2))),
      hot_idle_roundtrip_ms: Number(idleMs.toFixed(2)),
      resources: Buffer.from(resources.stdout_b64 || "", "base64").toString(),
    }));
  } catch (error) {
    console.log(JSON.stringify({
      provider: "arker",
      stage: "prepared-source",
      memory_mib: memoryMib,
      vcpu: 1,
      ok: false,
      error: error instanceof Error ? error.message.slice(0, 1_000) : String(error),
    }));
  } finally {
    if (browserId) await kernel.browsers.deleteByID(browserId).catch(async () => {
      const vm = await arker.getVm(browserId!).catch(() => undefined);
      await vm?.delete().catch(() => undefined);
    });
    await proxy.close();
    await rm(stateDirectory, { recursive: true, force: true });
  }
}
