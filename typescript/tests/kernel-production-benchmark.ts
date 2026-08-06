/** Live, stage-logged Kernel half of kernel-proxy-benchmark.ts. */
import { randomUUID } from "node:crypto";

import Kernel from "@onkernel/sdk";
import { WebSocket } from "ws";

if (!process.env.KERNEL_API_KEY) throw new Error("KERNEL_API_KEY is required");

const kernel = new Kernel({ apiKey: process.env.KERNEL_API_KEY, maxRetries: 0, timeout: 180_000 });
const name = `arker-kernel-reference-benchmark-${randomUUID().slice(0, 8)}`;
const simpleOnly = /^(?:1|true|yes)$/i.test(process.env.KERNEL_BENCH_SIMPLE ?? "");
const workloadTimeoutSeconds = Number(process.env.KERNEL_BENCH_WORKLOAD_TIMEOUT_SECONDS ?? "60");
const operationTimeoutSeconds = Number(process.env.KERNEL_BENCH_OPERATION_TIMEOUT_SECONDS ?? "30");
if (!Number.isFinite(workloadTimeoutSeconds) || workloadTimeoutSeconds <= 0) throw new Error("KERNEL_BENCH_WORKLOAD_TIMEOUT_SECONDS must be positive");
if (!Number.isFinite(operationTimeoutSeconds) || operationTimeoutSeconds <= 0) throw new Error("KERNEL_BENCH_OPERATION_TIMEOUT_SECONDS must be positive");
const decoder = new TextDecoder();
const now = () => Math.round(performance.now());
const log = (stage: string, started: number, data: Record<string, unknown> = {}) =>
  console.log(JSON.stringify({ provider: "kernel", stage, elapsed_ms: now() - started, ...data }));
const output = (value?: string) => decoder.decode(Buffer.from(value || "", "base64"));
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

let browserId: string | undefined;
try {
  let started = now();
  const browser = await kernel.browsers.create({
    name,
    headless: true,
    stealth: true,
    timeout_seconds: 1_800,
    viewport: { width: 1280, height: 720 },
  });
  browserId = browser.session_id;
  log("create", started, { browser_id: browserId });

  started = now();
  await bidiRoundTrip(browser.webdriver_ws_url);
  log("bidi", started);

  if (!simpleOnly) {
    started = now();
    const initialized = await kernel.browsers.playwright.execute(browserId, {
    code: `
      await page.setContent('<main id="root"></main>');
      await page.evaluate(() => {
        const root = document.querySelector('#root');
        for (let i = 0; i < 5000; i++) {
          const node = document.createElement('div');
          node.textContent = 'realistic-browser-node-' + i + '-' + 'x'.repeat(80);
          root.appendChild(node);
        }
      });
      for (let i = 0; i < 2; i++) {
        const extra = await context.newPage();
        await extra.setContent('<canvas width="1280" height="720"></canvas><p>' + 'content '.repeat(10000) + '</p>');
        await extra.evaluate(() => {
          const canvas = document.querySelector('canvas');
          const drawing = canvas.getContext('2d');
          drawing.fillStyle = '#4f46e5';
          drawing.fillRect(0, 0, canvas.width, canvas.height);
        });
      }
      return { pages: context.pages().length, nodes: await page.locator('*').count() };
    `,
      timeout_sec: workloadTimeoutSeconds,
    });
    log("workload-init", started, { response: initialized });
  }

  const operationMs: number[] = [];
  for (let index = 0; index < (simpleOnly ? 20 : 5); index += 1) {
    started = now();
    const result = await kernel.browsers.playwright.execute(browserId, {
      code: simpleOnly
        ? `return ${index};`
        : `return { index: ${index}, title: await page.title(), nodes: await page.locator('*').count() };`,
      timeout_sec: simpleOnly ? 30 : operationTimeoutSeconds,
    });
    const ms = now() - started;
    operationMs.push(ms);
    log("operation", started, { index, response: result });
  }
  console.log(JSON.stringify({
    provider: "kernel",
    stage: "operation-summary",
    operation_p50_ms: percentile(operationMs, 0.5),
    operation_p95_ms: percentile(operationMs, 0.95),
    operation_ms: operationMs,
  }));

  if (!simpleOnly) {
    started = now();
    const fiveSecondTimeout = await kernel.browsers.playwright.execute(browserId, {
      code: "return 5;",
      timeout_sec: 5,
    });
    log("timeout-scaling-5s", started, { response: fiveSecondTimeout });

    started = now();
    const defaultTimeout = await kernel.browsers.playwright.execute(browserId, {
      code: "return 60;",
    });
    log("timeout-scaling-default", started, { response: defaultTimeout });
  }

  const standbyMarker = randomUUID();
  await kernel.browsers.playwright.execute(browserId, {
    code: `globalThis.__kernelBenchmark=${JSON.stringify(standbyMarker)}; return true;`,
  });
  await new Promise((resolve) => setTimeout(resolve, 8_000));
  started = now();
  const resumed = await kernel.browsers.playwright.execute(browserId, {
    code: "return globalThis.__kernelBenchmark;",
  });
  if (!resumed.success || resumed.result !== standbyMarker) throw new Error("Kernel did not preserve browser state across standby");
  log("standby-resume", started);

  started = now();
  const resources = await kernel.browsers.process.exec(browserId, {
    command: "bash",
    args: ["-lc", [
      "grep -E '^(MemTotal|MemAvailable|SwapTotal|SwapFree):' /proc/meminfo",
      "ps -eo rss= | awk '{ total += $1 } END { printf \"rss_total_kib=%d\\n\", total }'",
      "ps -eo pid=,rss=,comm= --sort=-rss | head -20",
    ].join("; ")],
    timeout_sec: 30,
  });
  log("resources", started, { output: output(resources.stdout_b64) });
} finally {
  if (browserId) {
    const started = now();
    await kernel.browsers.deleteByID(browserId).catch((error) => log("delete-error", started, {
      error: error instanceof Error ? error.message.slice(0, 500) : String(error),
    }));
    log("delete", started);
  }
}
