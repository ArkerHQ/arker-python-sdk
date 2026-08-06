/**
 * Live parity test for the Kernel browser compatibility proxy.
 *
 * Required: ARKER_API_KEY
 * Optional: KERNEL_PROXY_LIVE_SESSION_ID reuses (and preserves) a browser.
 *
 * This is intentionally not part of the default unit suite because a fresh
 * run forks a temporary Arker VM and installs CloakBrowser in it.
 */
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import Kernel from "@onkernel/sdk";
import { WebSocket } from "ws";

import { Arker } from "../src/index.js";
import { startKernelProxy } from "../src/kernel-proxy.js";

if (!process.env.ARKER_API_KEY) throw new Error("ARKER_API_KEY is required");

const proxyKey = randomBytes(24).toString("base64url");
const signingSecret = randomBytes(32).toString("base64url");
const proxyStateDirectory = await mkdtemp(join(tmpdir(), "arker-kernel-proxy-live-"));
const automaticStandbySetting = process.env.KERNEL_PROXY_AUTOMATIC_STANDBY;
const automaticStandby = automaticStandbySetting === undefined || !/^(0|false|no)$/i.test(automaticStandbySetting);
const proxyOptions = {
  arkerApiKey: process.env.ARKER_API_KEY,
  arkerBaseUrl: process.env.ARKER_BASE_URL ?? "https://aws-us-east-1.arker.ai/api",
  apiKey: proxyKey,
  signingSecret,
  sourceVmName: process.env.KERNEL_PROXY_ARKER_SOURCE ?? "ubuntu-full",
  sourceVmId: process.env.KERNEL_PROXY_ARKER_SOURCE_ID,
  sourceLayers: process.env.KERNEL_PROXY_ARKER_SOURCE_ID ? (["disk", "memory"] as Array<"disk" | "memory">) : undefined,
  sourcePlatforms: (process.env.KERNEL_PROXY_ARKER_PLATFORMS ?? "icelake").split(","),
  setupScriptPath: process.env.KERNEL_PROXY_SETUP_SCRIPT,
  host: "127.0.0.1",
  port: 0,
  stateDirectory: proxyStateDirectory,
  automaticStandby,
};
let proxy = await startKernelProxy(proxyOptions);
let proxyRunning = true;
const address = proxy.server.address();
assert(address && typeof address === "object");
const proxyPort = address.port;
const baseURL = `http://127.0.0.1:${address.port}`;
let kernel = new Kernel({ apiKey: proxyKey, baseURL, maxRetries: 0, timeout: 180_000 });
let browserId = process.env.KERNEL_PROXY_LIVE_SESSION_ID;
const ownsBrowser = !browserId;
const ownedBrowserName = ownsBrowser ? `kernel-proxy-live-${randomUUID().slice(0, 8)}` : undefined;
const headed = /^(1|true|yes)$/i.test(process.env.KERNEL_PROXY_LIVE_HEADED || "");
let ownedProfileId: string | undefined;
let ownedExtensionId: string | undefined;
let ownedProxyId: string | undefined;
let ownedPoolId: string | undefined;
let ownedPoolSessionId: string | undefined;
const progress = (stage: string) => console.log(`[kernel-proxy-live] ${stage}${browserId ? ` (${browserId})` : ""}`);

const output = (value?: string) => Buffer.from(value || "", "base64").toString();

async function assertGuestRuntimeDurable(kernel: Kernel, browserId: string, stage: string): Promise<void> {
  const result = await kernel.browsers.process.exec(browserId, {
    command: "bash",
    args: ["-lc", [
      "test -x /opt/arker-kernel/start-services.sh",
      "test -x /opt/arker-kernel/start-playwright-runner.sh",
      "test -f /opt/arker-kernel/playwright-runner.mjs",
      "test -d /opt/arker-kernel/node_modules/playwright-core",
      "dpkg-query -W >/dev/null",
    ].join(" && ")],
  });
  assert.equal(result.exit_code, 0, `${stage} guest runtime was not durable: ${output(result.stderr_b64)}`);
}

function toneWavDataURL(): string {
  const sampleRate = 48_000;
  const sampleCount = Math.floor(sampleRate * 2.5);
  const wav = Buffer.alloc(44 + sampleCount * 2);
  wav.write("RIFF", 0);
  wav.writeUInt32LE(wav.length - 8, 4);
  wav.write("WAVEfmt ", 8);
  wav.writeUInt32LE(16, 16);
  wav.writeUInt16LE(1, 20);
  wav.writeUInt16LE(1, 22);
  wav.writeUInt32LE(sampleRate, 24);
  wav.writeUInt32LE(sampleRate * 2, 28);
  wav.writeUInt16LE(2, 32);
  wav.writeUInt16LE(16, 34);
  wav.write("data", 36);
  wav.writeUInt32LE(sampleCount * 2, 40);
  for (let index = 0; index < sampleCount; index += 1) {
    wav.writeInt16LE(Math.round(Math.sin(2 * Math.PI * 440 * index / sampleRate) * 12_000), 44 + index * 2);
  }
  return `data:audio/wav;base64,${wav.toString("base64")}`;
}

async function cdpRoundTrip(url: string): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(url);
    const timer = setTimeout(() => {
      socket.terminate();
      reject(new Error("CDP WebSocket timed out"));
    }, 15_000);
    socket.on("open", () => socket.send(JSON.stringify({ id: 1, method: "Browser.getVersion" })));
    socket.on("message", (data) => {
      const message = JSON.parse(Buffer.from(data as Uint8Array).toString()) as { id?: number; result?: Record<string, unknown>; error?: unknown };
      if (message.id !== 1) return;
      clearTimeout(timer);
      socket.close();
      if (message.error) reject(new Error(JSON.stringify(message.error)));
      else resolve(message.result || {});
    });
    socket.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
  });
}

async function bidiRoundTrip(url: string): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(url);
    const timer = setTimeout(() => {
      socket.terminate();
      reject(new Error("WebDriver BiDi WebSocket timed out"));
    }, 15_000);
    socket.on("open", () => socket.send(JSON.stringify({ id: 1, method: "session.status", params: {} })));
    socket.on("message", (data) => {
      const message = JSON.parse(Buffer.from(data as Uint8Array).toString()) as { id?: number; result?: Record<string, unknown>; error?: unknown };
      if (message.id !== 1) return;
      clearTimeout(timer);
      socket.close();
      if (message.error) reject(new Error(JSON.stringify(message.error)));
      else resolve(message.result || {});
    });
    socket.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
  });
}

async function assertLiveView(url: string, whileConnected?: () => Promise<void>): Promise<void> {
  const view = new URL(url);
  const response = await fetch(view);
  assert.equal(response.status, 200);
  assert.match(await response.text(), /noVNC/i);
  const path = view.searchParams.get("path");
  assert(path);
  const websocketURL = `${view.protocol === "https:" ? "wss:" : "ws:"}//${view.host}/${path}`;
  await new Promise<void>((resolve, reject) => {
    const socket = new WebSocket(websocketURL, "binary");
    let greetingHandled = false;
    const timer = setTimeout(() => {
      socket.terminate();
      reject(new Error("noVNC WebSocket timed out"));
    }, 15_000);
    socket.on("message", async (data) => {
      if (greetingHandled) return;
      greetingHandled = true;
      const greeting = Buffer.from(data as Uint8Array).toString("ascii");
      clearTimeout(timer);
      try {
        assert.match(greeting, /^RFB 003\./);
        await whileConnected?.();
        socket.once("close", () => resolve());
        socket.close();
      } catch (error) {
        socket.terminate();
        reject(error);
      }
    });
    socket.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
  });
}

async function runPythonParity(python: string, browserId: string): Promise<void> {
  const child = spawn(python, [new URL("./kernel-proxy-live.py", import.meta.url).pathname], {
    env: {
      ...process.env,
      KERNEL_API_KEY: proxyKey,
      KERNEL_BASE_URL: baseURL,
      KERNEL_SESSION_ID: browserId,
    },
    stdio: "inherit",
  });
  const exitCode = await new Promise<number | null>((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", resolve);
  });
  assert.equal(exitCode, 0, "Kernel Python parity process failed");
}

try {
  if (!browserId) {
    const browser = await kernel.browsers.create({
      name: ownedBrowserName,
      headless: !headed,
      stealth: true,
      timeout_seconds: 900,
      viewport: { width: 1280, height: 720 },
      tags: { suite: "kernel-proxy-live" },
      telemetry: {
        enabled: true,
        browser: {
          console: { enabled: true },
          network: { enabled: true },
          page: { enabled: true },
          interaction: { enabled: true },
          screenshot: { enabled: true },
        },
      },
    });
    browserId = browser.session_id;
    progress("browser-created");
  }
  assert(browserId);

  const browser = await kernel.browsers.retrieve(browserId);
  assert.equal(browser.session_id, browserId);
  assert.match(browser.cdp_ws_url, /jwt=/);
  assert.match(String((await cdpRoundTrip(browser.cdp_ws_url)).product), /Chrome|Chromium/i);
  assert.notEqual(browser.webdriver_ws_url, browser.cdp_ws_url);
  assert.equal(typeof (await bidiRoundTrip(browser.webdriver_ws_url)).ready, "boolean");
  const standbyMarker = `standby-${randomUUID()}`;
  const markedStandbyState = await kernel.browsers.playwright.execute(browserId, {
    code: `globalThis.__arkerStandbyMarker = ${JSON.stringify(standbyMarker)}; return globalThis.__arkerStandbyMarker;`,
  });
  assert.equal(markedStandbyState.result, standbyMarker);
  await new Promise((resolve) => setTimeout(resolve, 8_000));
  const standbyResumeStarted = performance.now();
  const [standbyCDP, standbyBiDi, standbyState] = await Promise.all([
    cdpRoundTrip(browser.cdp_ws_url),
    bidiRoundTrip(browser.webdriver_ws_url),
    kernel.browsers.playwright.execute(browserId, { code: "return globalThis.__arkerStandbyMarker;" }),
  ]);
  assert.match(String(standbyCDP.product), /Chrome|Chromium/i);
  assert.equal(typeof standbyBiDi.ready, "boolean");
  assert.equal(standbyState.result, standbyMarker);
  console.log(`[kernel-proxy-live] ${automaticStandby ? "standby-resume" : "idle-roundtrip"}-ms=${(performance.now() - standbyResumeStarted).toFixed(2)}`);
  await assertGuestRuntimeDurable(kernel, browserId, "post-standby");
  if (headed) {
    assert(browser.browser_live_view_url);
    await assertLiveView(browser.browser_live_view_url, async () => {
      await assert.rejects(
        () => kernel.browsers.update(browserId!, { viewport: { width: 1260, height: 710 } }),
        (error: { status?: number }) => error.status === 409,
      );
      const forced = await kernel.browsers.update(browserId!, { viewport: { width: 1260, height: 710, force: true } });
      assert.deepEqual(forced.viewport, { width: 1260, height: 710 });
    });
  }
  if (ownsBrowser) {
    const originalName = browser.name!;
    const updatedName = `${originalName}-renamed`;
    const updated = await kernel.browsers.update(browserId, {
      name: updatedName,
      tags: { suite: "kernel-proxy-live", updated: "true" },
      telemetry: {
        enabled: true,
        browser: {
          console: { enabled: true }, network: { enabled: true }, page: { enabled: true },
          interaction: { enabled: true }, screenshot: { enabled: true },
        },
      },
      viewport: { width: 1280, height: 720 },
      disable_default_proxy: true,
    });
    assert.equal(updated.name, updatedName);
    assert.equal(updated.tags?.updated, "true");
    assert.equal(updated.telemetry?.browser?.control?.enabled, true);
    assert.equal(updated.telemetry?.browser?.connection?.enabled, true);
    assert.equal((await kernel.browsers.retrieve(updatedName)).session_id, browserId);
    await assert.rejects(kernel.browsers.retrieve(originalName));
  }
  progress("browser-retrieve-update-cdp");
  let foundBrowserThroughPagination = false;
  for await (const item of kernel.browsers.list({ limit: 1 })) {
    if (item.session_id !== browserId) continue;
    foundBrowserThroughPagination = true;
    break;
  }
  assert(foundBrowserThroughPagination, "browser was not found through Kernel offset pagination");
  if (ownsBrowser) {
    assert((await kernel.browsers.list({ tags: { suite: "kernel-proxy-live" } })).items.some((item) => item.session_id === browserId));
  }
  progress("browser-list");

  const exec = await kernel.browsers.process.exec(browserId, {
    command: "node",
    args: ["-e", "process.stdout.write(process.env.PARITY + ':' + process.cwd())"],
    cwd: "/tmp",
    env: { PARITY: "typescript" },
  });
  assert.equal(output(exec.stdout_b64), "typescript:/tmp");

  const spawned = await kernel.browsers.process.spawn(browserId, { command: "bash", args: ["-lc", "sleep 0.25; printf spawned"], timeout_sec: 10 });
  for (let attempt = 0; attempt < 50; attempt += 1) {
    if ((await kernel.browsers.process.status(spawned.process_id!, { id: browserId })).state === "exited") break;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  let streamed = "";
  for await (const event of await kernel.browsers.process.stdoutStream(spawned.process_id!, { id: browserId })) {
    if (event.data_b64) streamed += output(event.data_b64);
  }
  assert.equal(streamed, "spawned");

  const incrementalProcess = await kernel.browsers.process.spawn(browserId, {
    command: "bash",
    args: ["-lc", "printf first; sleep 1.5; printf second"],
    timeout_sec: 10,
  });
  const incrementalChunks: string[] = [];
  for await (const event of await kernel.browsers.process.stdoutStream(incrementalProcess.process_id!, { id: browserId })) {
    if (event.data_b64) incrementalChunks.push(output(event.data_b64));
  }
  assert.deepEqual(incrementalChunks, ["first", "second"]);

  const killed = await kernel.browsers.process.spawn(browserId, { command: "sleep", args: ["60"], timeout_sec: 120 });
  await kernel.browsers.process.kill(killed.process_id!, { id: browserId, signal: "TERM" });
  assert.equal((await kernel.browsers.process.status(killed.process_id!, { id: browserId })).state, "exited");
  for (let index = 0; index < 8; index += 1) {
    const process = await kernel.browsers.process.spawn(browserId, { command: "sleep", args: ["60"], timeout_sec: 120 });
    await kernel.browsers.process.kill(process.process_id!, { id: browserId, signal: index % 2 ? "KILL" : "TERM" });
    assert.equal((await kernel.browsers.process.status(process.process_id!, { id: browserId })).state, "exited");
  }
  const concurrentProcesses = await Promise.all(Array.from({ length: 4 }, () =>
    kernel.browsers.process.spawn(browserId!, { command: "sleep", args: ["60"], timeout_sec: 120 })));
  await Promise.all(concurrentProcesses.map((process) =>
    kernel.browsers.process.kill(process.process_id!, { id: browserId!, signal: "TERM" })));
  assert.deepEqual(await Promise.all(concurrentProcesses.map(async (process) =>
    (await kernel.browsers.process.status(process.process_id!, { id: browserId! })).state)),
  ["exited", "exited", "exited", "exited"]);
  progress("process-lifecycle");

  const pty = await kernel.browsers.process.spawn(browserId, { command: "cat", allocate_tty: true, timeout_sec: 60 });
  const ptyInput = Buffer.from("pty-live\n");
  await kernel.browsers.process.stdin(pty.process_id!, { id: browserId, data_b64: ptyInput.toString("base64") });
  await kernel.browsers.process.resize(pty.process_id!, { id: browserId, cols: 100, rows: 40 });
  await new Promise((resolve) => setTimeout(resolve, 200));
  await kernel.browsers.process.kill(pty.process_id!, { id: browserId, signal: "TERM" });
  progress("process-pty");

  const root = "/tmp/kernel-proxy-live";
  await kernel.browsers.fs.deleteDirectory(browserId, { path: root }).catch(() => undefined);
  await kernel.browsers.fs.createDirectory(browserId, { path: root, mode: "0750" });
  const watch = await kernel.browsers.fs.watch.start(browserId, { path: root, recursive: true });
  assert(watch.watch_id);
  const firstWatchEvent = (async () => {
    for await (const event of await kernel.browsers.fs.watch.events(watch.watch_id!, { id: browserId })) return event;
    throw new Error("filesystem watch ended before an event");
  })();
  await new Promise((resolve) => setTimeout(resolve, 250));
  await kernel.browsers.process.exec(browserId, { command: "bash", args: ["-lc", `printf guest-watch > ${root}/guest-originated.txt`] });
  await kernel.browsers.fs.writeFile(browserId, Buffer.from("filesystem"), { path: `${root}/input.txt`, mode: "0640" });
  await kernel.browsers.fs.createDirectory(browserId, { path: `${root}/default-directory` });
  assert.match((await kernel.browsers.fs.fileInfo(browserId, { path: `${root}/default-directory` })).mode, /rwxr-xr-x$/);
  await kernel.browsers.fs.writeFile(browserId, Buffer.from("default-file"), { path: `${root}/default-file.txt` });
  assert.match((await kernel.browsers.fs.fileInfo(browserId, { path: `${root}/default-file.txt` })).mode, /rw-r--r--$/);
  const watched = await Promise.race([
    firstWatchEvent,
    new Promise<never>((_, reject) => setTimeout(() => reject(new Error("filesystem watch timed out")), 5_000)),
  ]);
  assert.equal(watched.path, `${root}/guest-originated.txt`);
  assert.equal(watched.type, "CREATE");
  await kernel.browsers.fs.watch.stop(watch.watch_id, { id: browserId });
  assert.equal(await (await kernel.browsers.fs.readFile(browserId, { path: `${root}/input.txt` })).text(), "filesystem");
  assert.equal((await kernel.browsers.fs.fileInfo(browserId, { path: `${root}/input.txt` })).size_bytes, 10);
  assert((await kernel.browsers.fs.listFiles(browserId, { path: root })).some((item) => item.name === "input.txt"));
  assert((await (await kernel.browsers.fs.downloadDirZip(browserId, { path: root })).arrayBuffer()).byteLength > 0);
  await kernel.browsers.fs.upload(browserId, {
    files: [{ dest_path: `${root}/uploaded.txt`, file: new File(["uploaded"], "uploaded.txt") }],
  });
  await kernel.browsers.fs.move(browserId, { src_path: `${root}/uploaded.txt`, dest_path: `${root}/moved.txt` });
  await kernel.browsers.fs.setFilePermissions(browserId, { path: `${root}/moved.txt`, mode: "0600", owner: "root", group: "root" });
  assert.equal(await (await kernel.browsers.fs.readFile(browserId, { path: `${root}/moved.txt` })).text(), "uploaded");
  assert.match((await kernel.browsers.fs.fileInfo(browserId, { path: `${root}/moved.txt` })).mode, /rw-------$/);
  const zipBytes = Buffer.from("UEsDBBQAAAAIAGeqBV2bSTjgDAAAAAwAAAARAAAAYXJjaGl2ZS1lbnRyeS50eHRLLErOyCxL1c0BEgBQSwECFAMUAAAACABnqgVdm0k44AwAAAAMAAAAEQAAAAAAAAAAAAAAgAEAAAAAYXJjaGl2ZS1lbnRyeS50eHRQSwUGAAAAAAEAAQA/AAAAOwAAAAAA", "base64");
  await kernel.browsers.fs.uploadZip(browserId, {
    dest_path: `${root}/unzipped`,
    zip_file: new File([zipBytes], "fixture.zip", { type: "application/zip" }),
  });
  const archiveEntry = `${root}/unzipped/archive-entry.txt`;
  assert.equal(await (await kernel.browsers.fs.readFile(browserId, { path: archiveEntry })).text(), "archive-live");
  await kernel.browsers.fs.deleteFile(browserId, { path: archiveEntry });
  await assert.rejects(kernel.browsers.fs.readFile(browserId, { path: archiveEntry }));
  progress("filesystem-and-watch");
  await assertGuestRuntimeDurable(kernel, browserId, "post-filesystem");
  await new Promise((resolve) => setTimeout(resolve, 8_000));
  assert.equal(
    await (await kernel.browsers.fs.readFile(browserId, { path: `${root}/input.txt` })).text(),
    "filesystem",
    `guest /tmp contents did not survive ${automaticStandby ? "automatic standby" : "the idle interval"}`,
  );
  await assertGuestRuntimeDurable(kernel, browserId, "post-filesystem-standby");

  const logLines: string[] = [];
  for await (const event of await kernel.browsers.logs.stream(browserId, {
    source: "path", path: `${root}/input.txt`, follow: false,
  })) if (event.message) logLines.push(event.message);
  assert.deepEqual(logLines, ["filesystem"]);
  await kernel.browsers.process.exec(browserId, { command: "bash", args: ["-lc", `: > ${root}/follow.log`] });
  const followedLog = (async () => {
    for await (const event of await kernel.browsers.logs.stream(browserId!, {
      source: "path", path: `${root}/follow.log`, follow: true,
    })) return event;
    throw new Error("follow log stream ended before an event");
  })();
  await new Promise((resolve) => setTimeout(resolve, 250));
  await kernel.browsers.process.exec(browserId, { command: "bash", args: ["-lc", `printf 'follow-live\\n' >> ${root}/follow.log`] });
  assert.equal(await (await kernel.browsers.fs.readFile(browserId, { path: `${root}/follow.log` })).text(), "follow-live\n");
  const followed = await Promise.race([
    followedLog,
    new Promise<never>((_, reject) => setTimeout(() => reject(new Error("follow log stream timed out")), 5_000)),
  ]);
  assert.equal(followed.event, "log");
  assert.equal(followed.message, "follow-live");
  const telemetryConfigResult = await kernel.browsers.process.exec(browserId, {
    command: "python3",
    args: ["-c", "import json; b=json.load(open('/opt/arker-kernel/config.json'))['telemetry']['browser']; print(json.dumps({k:v.get('enabled') for k,v in b.items()}))"],
  });
  const guestTelemetryConfig = JSON.parse(output(telemetryConfigResult.stdout_b64)) as Record<string, boolean>;
  for (const category of ["console", "network", "page", "interaction", "screenshot"]) assert.equal(guestTelemetryConfig[category], true);
  const telemetryExecution = await kernel.browsers.playwright.execute(browserId, {
    code: "await page.goto('https://example.com'); await page.evaluate(() => console.log('arker-telemetry-live')); await page.goto('data:text/html,<button id=telemetry>telemetry</button>'); await page.locator('#telemetry').click(); await new Promise(resolve => setTimeout(resolve, 250)); return true;",
  });
  assert.equal(telemetryExecution.result, true, `telemetry Playwright execution failed: ${JSON.stringify(telemetryExecution)}`);
  await new Promise((resolve) => setTimeout(resolve, 1_500));
  const telemetryPage = await kernel.browsers.telemetry.events(browserId, { limit: 1_000, since: "5m" });
  assert(telemetryPage.items.length > 0);
  const telemetryKinds = telemetryPage.items.map((item) => ({
    category: item.event.category,
    type: item.event.type,
    data: item.event.type === "monitor_init_failed" ? item.event.data : undefined,
  }));
  assert(
    telemetryPage.items.some((item) => item.event.category === "console" && item.event.type === "console_log"),
    `missing console telemetry: ${JSON.stringify(telemetryKinds)}`,
  );
  assert(telemetryPage.items.some((item) => item.event.category === "page"));
  assert(telemetryPage.items.some((item) => item.event.category === "network"));
  assert(telemetryPage.items.some((item) => item.event.category === "interaction"));
  let replayedTelemetry: { seq?: number } | undefined;
  for await (const event of await kernel.browsers.telemetry.stream(browserId, { replay: "all" })) {
    replayedTelemetry = event;
    break;
  }
  assert(replayedTelemetry?.seq);
  progress("logs-and-telemetry");

  const playwright = await kernel.browsers.playwright.execute(browserId, {
    code: "await page.goto('https://example.com'); return await page.title();",
  });
  assert.equal(playwright.success, true);
  assert.equal(playwright.result, "Example Domain");
  for (let index = 0; index < 40; index += 1) {
    const sequential = await kernel.browsers.playwright.execute(browserId, { code: `return ${index} + 1;` });
    assert.equal(sequential.result, index + 1);
  }
  const concurrent = await Promise.all(Array.from({ length: 8 }, (_, index) =>
    kernel.browsers.playwright.execute(browserId!, { code: `return ${index} * ${index};` })));
  assert.deepEqual(concurrent.map((result) => result.result), [0, 1, 4, 9, 16, 25, 36, 49]);
  const timedOutPlaywright = await kernel.browsers.playwright.execute(browserId, {
    code: "await new Promise(() => {});",
    timeout_sec: 1,
  });
  assert.equal(timedOutPlaywright.success, false);
  assert.match(timedOutPlaywright.error || "", /timed out/i);
  const recoveredPlaywright = await kernel.browsers.playwright.execute(browserId, { code: "return 40 + 2;" });
  assert.equal(recoveredPlaywright.result, 42);
  const curl = await kernel.browsers.curl(browserId, { url: "https://example.com", response_encoding: "utf8" });
  assert.equal(curl.status, 200);
  assert.match(curl.body!, /Example Domain/);
  assert.equal((await kernel.browsers.fetch(browserId, "https://example.com")).status, 200);

  const echoServer = await kernel.browsers.process.spawn(browserId, {
    command: "node",
    args: ["-e", "require('http').createServer((req,res)=>{const chunks=[];req.on('data',chunk=>chunks.push(chunk));req.on('end',()=>res.end(req.url==='/auth'?Buffer.from(req.headers.authorization||''):Buffer.concat(chunks)))}).listen(18765,'127.0.0.1')"],
    timeout_sec: 120,
  });
  try {
    for (let attempt = 0; attempt < 30; attempt += 1) {
      const ready = await kernel.browsers.process.exec(browserId, { command: "bash", args: ["-lc", "if curl -fsS http://127.0.0.1:18765 -o /dev/null 2>/dev/null; then printf ready; else printf wait; fi"] });
      if (output(ready.stdout_b64) === "ready") break;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    const binaryBody = new Uint8Array([0, 255, 1, 128, 65]);
    const echoed = await kernel.browsers.fetch(browserId, "http://127.0.0.1:18765/echo", { method: "POST", body: binaryBody });
    assert.deepEqual(new Uint8Array(await echoed.arrayBuffer()), binaryBody);
    const authorized = await kernel.browsers.fetch(browserId, "http://127.0.0.1:18765/auth", {
      headers: { authorization: "Bearer target-live-token" },
    });
    assert.equal(await authorized.text(), "Bearer target-live-token");
  } finally {
    await kernel.browsers.process.kill(echoServer.process_id!, { id: browserId, signal: "TERM" });
  }
  progress("playwright-curl-fetch");

  const screenshot = Buffer.from(await (await kernel.browsers.computer.captureScreenshot(browserId)).arrayBuffer());
  assert.equal(screenshot.subarray(0, 4).toString("hex"), "89504e47");
  const region = Buffer.from(await (await kernel.browsers.computer.captureScreenshot(browserId, {
    region: { x: 0, y: 0, width: 64, height: 64 },
  })).arrayBuffer());
  assert.equal(region.subarray(0, 4).toString("hex"), "89504e47");

  const initializedComputerPage = await kernel.browsers.playwright.execute(browserId, { code: `
    await page.goto('about:blank', { waitUntil: 'commit', timeout: 10000 });
    await page.evaluate(() => {
      document.body.innerHTML = \`<style>
        body { margin: 0; height: 2400px }
        #input { position: absolute; left: 20px; top: 20px; width: 220px; height: 30px }
        #button { position: absolute; left: 20px; top: 80px; width: 180px; height: 40px }
        #drag { position: absolute; left: 20px; top: 150px; width: 300px; height: 80px }
      </style><input id="input"><button id="button">target</button><div id="drag"></div>\`;
      globalThis.__computer = { clicks: 0, downs: 0, ups: 0, moves: 0, wheels: 0, context: 0, aux: 0, shifted: false };
      const state = globalThis.__computer;
      const button = document.querySelector('#button');
      button.addEventListener('click', (event) => { if (event.button === 0) state.clicks++; });
      button.addEventListener('mousedown', (event) => { state.downs++; state.shifted ||= event.shiftKey; });
      button.addEventListener('mouseup', (event) => { state.ups++; state.shifted ||= event.shiftKey; });
      button.addEventListener('contextmenu', (event) => { event.preventDefault(); state.context++; });
      button.addEventListener('auxclick', (event) => { event.preventDefault(); state.aux++; });
      document.addEventListener('mousemove', (event) => { state.moves++; state.shifted ||= event.shiftKey; });
      document.addEventListener('wheel', (event) => { state.wheels++; state.shifted ||= event.shiftKey; });
      document.addEventListener('keydown', (event) => { state.shifted ||= event.shiftKey; });
    });
    return true;
  ` });
  assert.equal(initializedComputerPage.success, true, String(initializedComputerPage.error));
  const initializedComputerState = await kernel.browsers.playwright.execute(browserId, { code: "return await page.evaluate(() => globalThis.__computer);" });
  assert.equal(initializedComputerState.success, true, String(initializedComputerState.error));
  assert.equal((initializedComputerState.result as { clicks: number }).clicks, 0);

  await kernel.browsers.computer.moveMouse(browserId, { x: 50, y: 40, smooth: true, duration_ms: 64, hold_keys: ["Shift"] });
  await kernel.browsers.computer.clickMouse(browserId, { x: 50, y: 40 });
  await kernel.browsers.computer.typeText(browserId, { text: "alpha", delay: 2 });
  await kernel.browsers.computer.pressKey(browserId, { keys: ["Ctrl+A"], duration: 20 });
  await kernel.browsers.computer.typeText(browserId, { text: "bravo" });
  await kernel.browsers.computer.pressKey(browserId, { keys: ["Right"], hold_keys: ["Shift"] });
  await kernel.browsers.computer.clickMouse(browserId, { x: 50, y: 100, num_clicks: 2, hold_keys: ["Shift"] });
  await kernel.browsers.computer.clickMouse(browserId, { x: 50, y: 100, button: "right" });
  await kernel.browsers.computer.clickMouse(browserId, { x: 50, y: 100, button: "middle" });
  await kernel.browsers.computer.clickMouse(browserId, { x: 50, y: 100, click_type: "down", hold_keys: ["Shift"] });
  await kernel.browsers.computer.clickMouse(browserId, { x: 50, y: 100, click_type: "up", hold_keys: ["Shift"] });
  await kernel.browsers.computer.scroll(browserId, { x: 100, y: 300, delta_x: 1, delta_y: 2, hold_keys: ["Shift"] });
  await kernel.browsers.computer.dragMouse(browserId, {
    path: [[30, 170], [130, 190], [260, 180]], button: "left", delay: 10, smooth: true, duration_ms: 96, hold_keys: ["Shift"],
  });
  assert.deepEqual(await kernel.browsers.computer.getMousePosition(browserId), { x: 260, y: 180 });

  await kernel.browsers.computer.writeClipboard(browserId, { text: "clipboard-live" });
  assert.equal((await kernel.browsers.computer.readClipboard(browserId)).text, "clipboard-live");
  assert.equal((await kernel.browsers.computer.setCursorVisibility(browserId, { hidden: true })).ok, true);
  assert.equal((await kernel.browsers.computer.setCursorVisibility(browserId, { hidden: false })).ok, true);

  const computer = await kernel.browsers.playwright.execute(browserId, {
    code: "return { value: await page.locator('#input').inputValue(), state: await page.evaluate(() => globalThis.__computer) };",
  });
  assert.equal(computer.success, true);
  assert.equal((computer.result as { value: string }).value, "bravo");
  const computerState = (computer.result as { state: Record<string, number | boolean> }).state;
  assert(computerState, JSON.stringify(computer.result));
  // Two repeated clicks plus the separately issued down/up pair.
  assert.equal(computerState.clicks, 3);
  assert((computerState.downs as number) >= 3 && (computerState.ups as number) >= 3);
  assert((computerState.moves as number) >= 4);
  assert((computerState.wheels as number) >= 1);
  assert.equal(computerState.context, 1);
  assert((computerState.aux as number) >= 1);
  assert.equal(computerState.shifted, true);

  await kernel.browsers.playwright.execute(browserId, { code: "await page.evaluate(() => scrollTo(0, 0)); await page.locator('#input').focus(); return true;" });
  await kernel.browsers.computer.batch(browserId, {
    actions: [
      { type: "move_mouse", move_mouse: { x: 60, y: 40, smooth: true, duration_ms: 32 } },
      { type: "click_mouse", click_mouse: { x: 60, y: 40 } },
      { type: "press_key", press_key: { keys: ["Ctrl+A"] } },
      { type: "type_text", type_text: { text: "batch" } },
      { type: "scroll", scroll: { x: 100, y: 300, delta_y: 1 } },
      { type: "drag_mouse", drag_mouse: { path: [[30, 170], [80, 190]], steps_per_segment: 2, step_delay_ms: 1 } },
      { type: "set_cursor", set_cursor: { hidden: false } },
      { type: "sleep", sleep: { duration_ms: 5 } },
    ],
  });
  const batchValue = await kernel.browsers.playwright.execute(browserId, { code: "return await page.locator('#input').inputValue();" });
  assert.equal(batchValue.result, "batch");
  progress("computer-actions");

  await kernel.browsers.playwright.execute(browserId, { code: "await page.goto('https://example.com/?one'); await page.goto('https://example.com/?two'); return page.url();" });
  await kernel.browsers.computer.clickMouse(browserId, { x: 0, y: 0, button: "back" });
  assert.match(String((await kernel.browsers.playwright.execute(browserId, { code: "return page.url();" })).result), /[?&]one/);
  await kernel.browsers.computer.clickMouse(browserId, { x: 0, y: 0, button: "forward" });
  assert.match(String((await kernel.browsers.playwright.execute(browserId, { code: "return page.url();" })).result), /[?&]two/);

  if (!headed) {
    const rejectedReplay = await fetch(`${baseURL}/browsers/${encodeURIComponent(browserId)}/replays`, {
      method: "POST",
      headers: { authorization: `Bearer ${proxyKey}`, "content-type": "application/json" },
      body: "{}",
    });
    assert.equal(rejectedReplay.status, 400);
  } else {
    const replaysBeforeResize = new Set((await kernel.browsers.replays.list(browserId)).map((item) => item.replay_id));
    const replay = await kernel.browsers.replays.start(browserId, { framerate: 2, max_duration_in_seconds: 10 });
    await new Promise((resolve) => setTimeout(resolve, 700));
    await assert.rejects(
      () => kernel.browsers.update(browserId!, { viewport: { width: 1180, height: 700 } }),
      (error: { status?: number }) => error.status === 409,
    );
    const resized = await kernel.browsers.update(browserId, { viewport: { width: 1180, height: 700, force: true } });
    assert.deepEqual(resized.viewport, { width: 1180, height: 700 });
    const resizeSegments = (await kernel.browsers.replays.list(browserId))
      .filter((item) => !replaysBeforeResize.has(item.replay_id));
    assert.equal(resizeSegments.length, 2);
    assert(resizeSegments.find((item) => item.replay_id === replay.replay_id)?.finished_at);
    const restartedSegment = resizeSegments.find((item) => item.finished_at === null);
    assert(restartedSegment?.replay_id && restartedSegment.replay_id !== replay.replay_id);
    await new Promise((resolve) => setTimeout(resolve, 700));
    await kernel.browsers.replays.stop(restartedSegment.replay_id, { id: browserId });
    assert((await (await kernel.browsers.replays.download(replay.replay_id!, { id: browserId })).arrayBuffer()).byteLength > 1_000);
    assert((await (await kernel.browsers.replays.download(restartedSegment.replay_id, { id: browserId })).arrayBuffer()).byteLength > 1_000);

    // Exercise max-duration finalization and the race between explicit stop and
    // download while the timer-triggered ffmpeg job is already completing.
    const automaticReplay = await kernel.browsers.replays.start(browserId, { framerate: 2, max_duration_in_seconds: 1 });
    await new Promise((resolve) => setTimeout(resolve, 1_100));
    const [, automaticReplayBytes] = await Promise.all([
      kernel.browsers.replays.stop(automaticReplay.replay_id!, { id: browserId }),
      kernel.browsers.replays.download(automaticReplay.replay_id!, { id: browserId })
        .then((response) => response.arrayBuffer()),
    ]);
    assert(automaticReplayBytes.byteLength > 1_000);
    const finalizedReplay = (await kernel.browsers.replays.list(browserId))
      .find((item) => item.replay_id === automaticReplay.replay_id);
    assert(finalizedReplay?.finished_at);
    for (let cycle = 0; cycle < 2; cycle += 1) {
      const repeatedReplay = await kernel.browsers.replays.start(browserId, { framerate: 2, max_duration_in_seconds: 3 });
      await new Promise((resolve) => setTimeout(resolve, 600));
      await kernel.browsers.replays.stop(repeatedReplay.replay_id!, { id: browserId });
      assert((await (await kernel.browsers.replays.download(repeatedReplay.replay_id!, { id: browserId })).arrayBuffer()).byteLength > 1_000);
      const postReplay = await kernel.browsers.process.exec(browserId, { command: "printf", args: [`post-replay-${cycle}`] });
      assert.equal(output(postReplay.stdout_b64), `post-replay-${cycle}`);
    }
    const audioReplay = await kernel.browsers.replays.start(browserId, {
      framerate: 5,
      max_duration_in_seconds: 5,
      record_audio: true,
    });
    const tone = await kernel.browsers.playwright.execute(browserId, {
      code: `
        await page.evaluate(() => {
          document.querySelector('#tone')?.remove();
          const button = document.createElement('button');
          button.id = 'tone';
          button.textContent = 'tone';
          (document.body || document.documentElement).append(button);
          button.addEventListener('click', () => {
            const audio = new Audio(${JSON.stringify(toneWavDataURL())});
            const ended = new Promise((resolve, reject) => {
              audio.addEventListener('ended', resolve, { once: true });
              audio.addEventListener('error', () => reject(audio.error || new Error('audio playback failed')), { once: true });
            });
            globalThis.__arkerToneDone = audio.play().then(() => ended);
          }, { once: true });
        });
        await page.locator('#tone').click();
        return await page.evaluate(() => Boolean(globalThis.__arkerToneDone));
      `,
    });
    assert.equal(tone.success, true, `tone playback failed: ${JSON.stringify(tone)}`);
    assert.equal(tone.result, true, `tone playback returned unexpectedly: ${JSON.stringify(tone)}`);
    const audioRoute = await kernel.browsers.process.exec(browserId, {
      command: "bash",
      args: ["-lc", "for _ in $(seq 1 50); do PULSE_SERVER=unix:/run/arker-pulse/native pactl list short sink-inputs 2>/dev/null | grep -q . && exit 0; sleep 0.05; done; PULSE_SERVER=unix:/run/arker-pulse/native pactl list short sinks >&2 || true; exit 1"],
    });
    assert.equal(audioRoute.exit_code, 0, `CloakBrowser did not emit audio to PulseAudio: ${output(audioRoute.stderr_b64)}`);
    const toneFinished = await kernel.browsers.playwright.execute(browserId, {
      code: "await page.evaluate(() => globalThis.__arkerToneDone); return true;",
    });
    assert.equal(toneFinished.result, true, `tone completion failed: ${JSON.stringify(toneFinished)}`);
    await kernel.browsers.replays.stop(audioReplay.replay_id!, { id: browserId });
    const audioReplayBytes = Buffer.from(await (await kernel.browsers.replays.download(audioReplay.replay_id!, { id: browserId })).arrayBuffer());
    const audioReplayAtoms = audioReplayBytes.toString("latin1");
    assert(audioReplayBytes.length > 1_000);
    assert(audioReplayAtoms.includes("soun"), "audio replay is missing an MP4 sound track");
    assert(audioReplayAtoms.includes("mp4a"), "audio replay is missing an AAC codec descriptor");
    const decodedAudio = spawnSync("ffmpeg", [
      "-nostdin", "-hide_banner", "-loglevel", "error", "-i", "pipe:0",
      "-map", "0:a:0", "-f", "s16le", "-ac", "1", "-ar", "48000", "pipe:1",
    ], { input: audioReplayBytes, maxBuffer: 20 * 1024 * 1024 });
    assert.equal(decodedAudio.status, 0, `ffmpeg could not decode replay audio: ${decodedAudio.stderr.toString()}`);
    let energy = 0;
    for (let index = 0; index + 1 < decodedAudio.stdout.length; index += 2) {
      const sample = decodedAudio.stdout.readInt16LE(index);
      energy += sample * sample;
    }
    const rms = Math.sqrt(energy / Math.max(1, decodedAudio.stdout.length / 2));
    assert(rms > 100, `captured replay audio was effectively silent (RMS ${rms})`);
  }
  progress("replays");

  const extensionZip = Buffer.from("UEsDBBQAAAAIAHOqBV060pKOQQAAAEYAAAANAAAAbWFuaWZlc3QuanNvbqtWyk3My0xLLS6JL0stKs7Mz1OyMtZRykvMTVWyUnIsyk4tUvBOLcpLzVFwy6woKS1KVdJRgqtUMtQz0DNQqgUAUEsBAhQDFAAAAAgAc6oFXTrSko5BAAAARgAAAA0AAAAAAAAAAAAAAIABAAAAAG1hbmlmZXN0Lmpzb25QSwUGAAAAAAEAAQA7AAAAbAAAAAAA", "base64");
  await kernel.browsers.loadExtensions(browserId, {
    extensions: [{ name: "kernel-live-fixture", zip_file: new File([extensionZip], "extension.zip", { type: "application/zip" }) }],
  });
  const restarted = await kernel.browsers.retrieve(browserId);
  assert.match(String((await cdpRoundTrip(restarted.cdp_ws_url)).product), /Chrome|Chromium/i);
  assert.equal(typeof (await bidiRoundTrip(restarted.webdriver_ws_url)).ready, "boolean");
  const postExtension = await kernel.browsers.playwright.execute(browserId, { code: "return 6 * 7;" });
  assert.equal(postExtension.result, 42);
  progress("extension-restart");

  const preRestartCDP = restarted.cdp_ws_url;
  await proxy.close();
  proxyRunning = false;
  proxy = await startKernelProxy({ ...proxyOptions, port: proxyPort });
  proxyRunning = true;
  kernel = new Kernel({ apiKey: proxyKey, baseURL, maxRetries: 0, timeout: 180_000 });
  const recoveredBrowser = await kernel.browsers.retrieve(browserId);
  assert.equal(recoveredBrowser.session_id, browserId);
  assert((await kernel.browsers.list({ limit: 100 })).items.some((item) => item.session_id === browserId));
  assert.match(String((await cdpRoundTrip(preRestartCDP)).product), /Chrome|Chromium/i);
  assert.equal(typeof (await bidiRoundTrip(recoveredBrowser.webdriver_ws_url)).ready, "boolean");
  const recoveredExecution = await kernel.browsers.playwright.execute(browserId, { code: "return 'proxy-restarted';" });
  assert.equal(recoveredExecution.result, "proxy-restarted");

  if (process.env.KERNEL_PROXY_LIVE_PYTHON) {
    await runPythonParity(process.env.KERNEL_PROXY_LIVE_PYTHON, browserId);
  }
  progress("proxy-restart-and-python");

  await kernel.browsers.fs.deleteDirectory(browserId, { path: root });
  const completedBrowserId = browserId;

  if (ownsBrowser) {
    const suffix = randomUUID().slice(0, 8);
    const profile = await kernel.profiles.create({ name: `kernel-live-profile-${suffix}` });
    ownedProfileId = profile.id;
    const storedExtension = await kernel.extensions.upload({
      name: `kernel-live-extension-${suffix}`,
      file: new File([extensionZip], "stored-extension.zip", { type: "application/zip" }),
    });
    ownedExtensionId = storedExtension.id;
    const customProxy = await kernel.proxies.create({
      type: "custom",
      name: `kernel-live-proxy-${suffix}`,
      protocol: "http",
      bypass_hosts: ["localhost", "127.0.0.1"],
      config: { host: "proxy.example.invalid", port: 8080, username: "live-user", password: "live-password" },
    });
    assert(customProxy.id);
    ownedProxyId = customProxy.id;
    assert.equal((customProxy.config as { has_password?: boolean }).has_password, true);
    assert.equal("password" in (customProxy.config as object), false);
    assert((await kernel.profiles.list({ name: profile.name! })).items.some((item) => item.id === profile.id));
    assert((await kernel.extensions.list({ query: storedExtension.id })).items.some((item) => item.id === storedExtension.id));
    assert((await kernel.proxies.list({ query: customProxy.id })).items.some((item) => item.id === customProxy.id));
    assert.deepEqual(Buffer.from(await (await kernel.extensions.download(storedExtension.id)).arrayBuffer()), extensionZip);
    progress("control-resources-created");

    const profiled = await kernel.browsers.update(browserId, { profile: { id: profile.id, save_changes: true } });
    assert.equal(profiled.profile?.id, profile.id);
    progress("profile-attached");
    const marker = `profile-${randomUUID()}`;
    const cookieExpires = Math.floor(Date.now() / 1_000) + 86_400;
    const storedProfileState = await kernel.browsers.playwright.execute(browserId, {
      code: `await page.goto("https://example.com"); await context.addCookies([{name:"arker_profile",value:${JSON.stringify(marker)},url:"https://example.com",expires:${cookieExpires}}]); return (await context.cookies("https://example.com")).find(cookie=>cookie.name==="arker_profile")?.value;`,
    });
    assert.equal(storedProfileState.result, marker);
    progress("profile-state-written");
    const proxied = await kernel.browsers.update(browserId, { proxy_id: customProxy.id });
    assert.equal(proxied.proxy_id, customProxy.id);
    progress("proxy-attached");
    const proxyConfigCheck = await kernel.browsers.process.exec(browserId, {
      command: "python3",
      args: ["-c", "import json,os; q=json.load(open('/opt/arker-kernel/config.json')); assert q['proxy']['host']=='proxy.example.invalid'; assert os.path.isfile(q['proxy']['extensionPath']+'/manifest.json')"],
    });
    assert.equal(proxyConfigCheck.exit_code, 0, output(proxyConfigCheck.stderr_b64));
    progress("proxy-config-verified");

    await kernel.browsers.deleteByID(browserId);
    browserId = undefined;
    progress("profile-browser-deleted");
    const tarProfile = Buffer.from(await (await kernel.profiles.download(profile.id, { format: "tar" })).arrayBuffer());
    const zstdProfile = Buffer.from(await (await kernel.profiles.download(profile.id)).arrayBuffer());
    assert(tarProfile.length > 1_024);
    assert.equal(zstdProfile.subarray(0, 4).toString("hex"), "28b52ffd");
    progress("profile-archive-downloaded");

    const pool = await kernel.browserPools.create({
      size: 1,
      name: `kernel-live-pool-${suffix}`,
      headless: true,
      timeout_seconds: 300,
      profile: { id: profile.id },
      extensions: [{ id: storedExtension.id }],
      proxy_id: customProxy.id,
    });
    ownedPoolId = pool.id;
    progress("browser-pool-created");
    const pooled = await kernel.browserPools.acquire(pool.id, { acquire_timeout_seconds: 180, name: `kernel-live-lease-${suffix}` });
    ownedPoolSessionId = pooled.session_id;
    progress("browser-pool-acquired");
    assert.equal(pooled.pool?.id, pool.id);
    assert.equal(pooled.profile?.id, profile.id);
    assert.equal(pooled.proxy_id, customProxy.id);
    assert.equal((await cdpRoundTrip(pooled.cdp_ws_url)).product !== undefined, true);
    const pooledState = await kernel.browsers.playwright.execute(pooled.session_id, {
      code: `return (await context.cookies("https://example.com")).find(cookie=>cookie.name==="arker_profile")?.value;`,
    });
    assert.equal(pooledState.result, marker);
    const storedExtensionCheck = await kernel.browsers.process.exec(pooled.session_id, {
      command: "bash",
      args: ["-lc", `test -f /opt/arker-kernel/extensions/stored-${storedExtension.id}/manifest.json && grep -q -- '--proxy-server=http://proxy.example.invalid:8080' /opt/arker-kernel/config.json`],
    });
    assert.equal(storedExtensionCheck.exit_code, 0, output(storedExtensionCheck.stderr_b64));
    await kernel.browserPools.release(pool.id, { session_id: pooled.session_id });
    progress("browser-pool-released");
    const reacquired = await kernel.browserPools.acquire(pool.id, { acquire_timeout_seconds: 5 });
    assert.equal(reacquired.session_id, pooled.session_id);
    await kernel.browserPools.release(pool.id, { session_id: reacquired.session_id });
    await kernel.browserPools.delete(pool.id);
    ownedPoolId = undefined;
    ownedPoolSessionId = undefined;
    await kernel.proxies.delete(customProxy.id);
    ownedProxyId = undefined;
    await kernel.extensions.delete(storedExtension.id);
    ownedExtensionId = undefined;
    await kernel.profiles.delete(profile.id);
    ownedProfileId = undefined;
    progress("profiles-extensions-proxies-pools");
  }

  console.log(`PASS Kernel TypeScript live parity (${completedBrowserId})`);
} finally {
  if (ownedPoolId) await kernel.browserPools.delete(ownedPoolId, { force: true }).catch(() => undefined);
  if (ownedPoolSessionId) {
    await kernel.browsers.deleteByID(ownedPoolSessionId).catch(async () => {
      const arker = new Arker({ apiKey: process.env.ARKER_API_KEY!, baseUrl: proxyOptions.arkerBaseUrl, controlBaseUrl: proxyOptions.arkerBaseUrl });
      const vm = await arker.getVm(ownedPoolSessionId!).catch(() => undefined);
      await vm?.delete().catch(() => undefined);
    });
  }
  if (ownedProxyId) await kernel.proxies.delete(ownedProxyId).catch(() => undefined);
  if (ownedExtensionId) await kernel.extensions.delete(ownedExtensionId).catch(() => undefined);
  if (ownedProfileId) await kernel.profiles.delete(ownedProfileId).catch(() => undefined);
  if (ownsBrowser && browserId) {
    await kernel.browsers.deleteByID(browserId).catch(async () => {
      const arker = new Arker({
        apiKey: process.env.ARKER_API_KEY!,
        baseUrl: proxyOptions.arkerBaseUrl,
        controlBaseUrl: proxyOptions.arkerBaseUrl,
      });
      const vm = await arker.getVm(browserId!).catch(() => undefined);
      await vm?.delete().catch(() => undefined);
    });
  }
  if (proxyRunning) await proxy.close();
  if (ownedBrowserName) {
    // A timed-out fork request can finish after the client has lost the VM ID.
    // Sweep only this run's cryptographically random exact name plus our
    // metadata marker, leaving every pre-existing VM untouched.
    const arker = new Arker({
      apiKey: process.env.ARKER_API_KEY!,
      baseUrl: proxyOptions.arkerBaseUrl,
      controlBaseUrl: proxyOptions.arkerBaseUrl,
    });
    for (let attempt = 0; attempt < 6; attempt += 1) {
      const vms = [];
      let cursor: string | undefined;
      do {
        const page = await arker.listVms(cursor ? { cursor, limit: 100 } : { limit: 100 })
          .catch(() => ({ vms: [], nextCursor: null }));
        vms.push(...page.vms);
        cursor = page.nextCursor ?? undefined;
      } while (cursor);
      const owned = vms.filter((vm) => (vm.name === ownedBrowserName || String(vm.name || "").startsWith(`${ownedBrowserName}-setup-`))
        && String((vm as unknown as { description?: unknown }).description || "").startsWith("arker-kernel-v1:"));
      await Promise.all(owned.map((vm) => vm.delete().catch(() => undefined)));
      if (owned.length === 0 && attempt > 0) break;
      await new Promise((resolve) => setTimeout(resolve, 1_000));
    }
  }
  await rm(proxyStateDirectory, { recursive: true, force: true });
}
