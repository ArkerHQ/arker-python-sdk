/**
 * Focused live test for durable Kernel control resources.
 *
 * Required: ARKER_API_KEY and KERNEL_PROXY_ARKER_SOURCE_ID. The source must be
 * a prepared, awake CloakBrowser VM that supports disk+memory forks. Every
 * child VM and local state directory created here is removed in finally.
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash, randomBytes, randomUUID } from "node:crypto";
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
const headed = /^(1|true|yes)$/i.test(process.env.KERNEL_PROXY_CONTROL_HEADED || "");
const suffix = randomUUID().slice(0, 8);
const browserName = `kernel-control-live-${suffix}`;
const stateDirectory = await mkdtemp(join(tmpdir(), "arker-kernel-control-live-"));
const proxyKey = randomBytes(24).toString("base64url");
const upstreamProxyUsername = `control-${suffix}`;
const upstreamProxyPassword = randomBytes(24).toString("base64url");
const upstreamProxyPort = 20_000 + (randomBytes(2).readUInt16BE(0) % 20_000);
const proxy = await startKernelProxy({
  arkerApiKey,
  arkerBaseUrl,
  apiKey: proxyKey,
  signingSecret: randomBytes(32).toString("base64url"),
  sourceVmId,
  sourceLayers: ["disk", "memory"],
  sourceVmName: process.env.KERNEL_PROXY_ARKER_SOURCE ?? "ubuntu-full",
  sourcePlatforms: (process.env.KERNEL_PROXY_ARKER_PLATFORMS ?? "icelake").split(","),
  stateDirectory,
  automaticStandby: false,
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
const arker = new Arker({ apiKey: arkerApiKey, baseUrl: arkerBaseUrl, controlBaseUrl: arkerBaseUrl });
const extensionArchive = Buffer.from(
  "UEsDBBQAAAAIAHOqBV060pKOQQAAAEYAAAANAAAAbWFuaWZlc3QuanNvbqtWyk3My0xLLS6JL0stKs7Mz1OyMtZRykvMTVWyUnIsyk4tUvBOLcpLzVFwy6woKS1KVdJRgqtUMtQz0DNQqgUAUEsBAhQDFAAAAAgAc6oFXTrSko5BAAAARgAAAA0AAAAAAAAAAAAAAIABAAAAAG1hbmlmZXN0Lmpzb25QSwUGAAAAAAEAAQA7AAAAbAAAAAAA",
  "base64",
);
const ownedVmIds = new Set<string>();
let browserId: string | undefined;
let profileId: string | undefined;
let extensionId: string | undefined;
let customProxyId: string | undefined;
let unavailableProxyId: string | undefined;
let poolId: string | undefined;
let poolSessionId: string | undefined;
const progress = (stage: string, details: Record<string, unknown> = {}) => {
  console.log(JSON.stringify({ stage, ...details }));
};
const output = (value?: string) => Buffer.from(value || "", "base64").toString();

async function assertBrowserProtocols(browser: { cdp_ws_url: string; webdriver_ws_url: string }): Promise<void> {
  const roundTrip = (url: string, message: Record<string, unknown>, id: number) => new Promise<void>((resolve, reject) => {
    const socket = new WebSocket(url);
    const timer = setTimeout(() => { socket.terminate(); reject(new Error(`WebSocket timeout for ${url}`)); }, 30_000);
    socket.once("open", () => socket.send(JSON.stringify(message)));
    socket.on("message", (data) => {
      const response = JSON.parse(Buffer.from(data as Uint8Array).toString()) as { id?: number; error?: unknown };
      if (response.id !== id) return;
      clearTimeout(timer);
      socket.close();
      if (response.error) reject(new Error(JSON.stringify(response.error)));
      else resolve();
    });
    socket.once("error", (error) => { clearTimeout(timer); reject(error); });
  });
  await Promise.all([
    roundTrip(browser.cdp_ws_url, { id: 1, method: "Browser.getVersion" }, 1),
    roundTrip(browser.webdriver_ws_url, { id: 2, method: "session.status", params: {} }, 2),
  ]);
}

function authenticatedProxyServer(username: string, password: string, port: number): string {
  const credentials = Buffer.from(`${username}:${password}`).toString("base64");
  return String.raw`
import { appendFileSync, writeFileSync } from "node:fs";
import http from "node:http";
import net from "node:net";

const expected = ${JSON.stringify(`Basic ${credentials}`)};
writeFileSync("/tmp/arker-auth-proxy.log", "");
const log = (event) => appendFileSync("/tmp/arker-auth-proxy.log", event + "\n");
const authorized = (request) => request.headers["proxy-authorization"] === expected;
const challenge = (socket) => {
  log("rejected");
  socket.end('HTTP/1.1 407 Proxy Authentication Required\r\nProxy-Authenticate: Basic realm="arker-test"\r\nConnection: close\r\n\r\n');
};

const server = http.createServer((request, response) => {
  if (!authorized(request)) {
    response.writeHead(407, { "Proxy-Authenticate": 'Basic realm="arker-test"', Connection: "close" });
    response.end();
    log("rejected");
    return;
  }
  let target;
  try { target = new URL(request.url); }
  catch { response.writeHead(400).end(); return; }
  log("accepted-http " + target.hostname + ":" + (target.port || 80));
  const headers = { ...request.headers };
  delete headers["proxy-authorization"];
  delete headers["proxy-connection"];
  const upstream = http.request(target, { method: request.method, headers }, (upstreamResponse) => {
    response.writeHead(upstreamResponse.statusCode || 502, upstreamResponse.headers);
    upstreamResponse.pipe(response);
  });
  upstream.on("error", () => response.writeHead(502).end());
  request.pipe(upstream);
});

server.on("connect", (request, client, head) => {
  if (!authorized(request)) return challenge(client);
  const separator = request.url.lastIndexOf(":");
  const host = request.url.slice(0, separator);
  const port = Number(request.url.slice(separator + 1)) || 443;
  log("accepted-connect " + host + ":" + port);
  const upstream = net.connect(port, host);
  upstream.once("connect", () => {
    client.write("HTTP/1.1 200 Connection Established\r\n\r\n");
    if (head.length) upstream.write(head);
    upstream.pipe(client);
    client.pipe(upstream);
  });
  upstream.once("error", () => client.end("HTTP/1.1 502 Bad Gateway\r\nConnection: close\r\n\r\n"));
  client.once("error", () => upstream.destroy());
});

server.listen(${port}, "0.0.0.0", () => log("ready"));
`;
}

function assertZstdRoundTrip(compressed: Buffer, expected: Buffer): void {
  const script = String.raw`
import ctypes, ctypes.util, hashlib, json, sys
payload = sys.stdin.buffer.read()
library = ctypes.CDLL(ctypes.util.find_library("zstd") or "libzstd.so.1")
library.ZSTD_getFrameContentSize.argtypes = [ctypes.c_void_p, ctypes.c_size_t]
library.ZSTD_getFrameContentSize.restype = ctypes.c_ulonglong
library.ZSTD_decompress.argtypes = [ctypes.c_void_p, ctypes.c_size_t, ctypes.c_void_p, ctypes.c_size_t]
library.ZSTD_decompress.restype = ctypes.c_size_t
source = ctypes.create_string_buffer(payload)
size = library.ZSTD_getFrameContentSize(source, len(payload))
assert size not in (0xffffffffffffffff, 0xfffffffffffffffe)
target = ctypes.create_string_buffer(size)
written = library.ZSTD_decompress(target, size, source, len(payload))
assert written == size
decoded = target.raw[:written]
print(json.dumps({"bytes": len(decoded), "sha256": hashlib.sha256(decoded).hexdigest()}))
`;
  const result = spawnSync("python3", ["-c", script], { input: compressed, encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr || "libzstd decompression failed");
  const decoded = JSON.parse(result.stdout) as { bytes: number; sha256: string };
  assert.equal(decoded.bytes, expected.length);
  assert.equal(decoded.sha256, createHash("sha256").update(expected).digest("hex"));
}

try {
  const profile = await kernel.profiles.create({ name: `control-profile-${suffix}` });
  profileId = profile.id;
  const extension = await kernel.extensions.upload({
    name: `control-extension-${suffix}`,
    file: new File([extensionArchive], "fixture.zip", { type: "application/zip" }),
  });
  extensionId = extension.id;
  const customProxy = await kernel.proxies.create({
    type: "custom",
    name: `control-proxy-${suffix}`,
    protocol: "http",
    bypass_hosts: ["<-loopback>"],
    config: { host: "127.0.0.1", port: upstreamProxyPort, username: upstreamProxyUsername, password: upstreamProxyPassword },
  });
  assert(customProxy.id);
  customProxyId = customProxy.id;
  assert.equal((customProxy.config as { has_password?: boolean }).has_password, true);
  assert.equal("password" in (customProxy.config as object), false);
  const unavailableProxy = await kernel.proxies.create({
    type: "custom",
    name: `control-proxy-wrong-auth-${suffix}`,
    protocol: "http",
    bypass_hosts: ["<-loopback>"],
    config: { host: "127.0.0.1", port: upstreamProxyPort, username: upstreamProxyUsername, password: "deliberately-wrong" },
  });
  assert(unavailableProxy.id);
  unavailableProxyId = unavailableProxy.id;
  progress("resources-created", { profile_id: profileId, extension_id: extensionId, proxy_id: customProxyId });
  const chromeStoreArchive = Buffer.from(await (await kernel.extensions.downloadFromChromeStore({
    url: "https://chromewebstore.google.com/detail/ublock-origin/cjpalhdlnbpafiamejdnhcphjbkeiagm",
    os: "linux",
  })).arrayBuffer());
  assert.equal(chromeStoreArchive.subarray(0, 2).toString("ascii"), "PK");
  progress("chrome-store-extension-downloaded", { zip_bytes: chromeStoreArchive.length });

  const createdStarted = performance.now();
  const browser = await kernel.browsers.create({
    name: browserName,
    headless: !headed,
    stealth: true,
    timeout_seconds: 900,
    viewport: { width: 1280, height: 720 },
  });
  browserId = browser.session_id;
  ownedVmIds.add(browserId);
  progress("browser-created", { browser_id: browserId, create_ms: Math.round(performance.now() - createdStarted) });
  await kernel.browsers.fs.writeFile(browserId, Buffer.from(authenticatedProxyServer(upstreamProxyUsername, upstreamProxyPassword, upstreamProxyPort)), {
    path: "/tmp/arker-auth-proxy.mjs",
    mode: "0600",
  });
  const launchedProxy = await kernel.browsers.process.exec(browserId, {
    command: "bash",
    args: ["-lc", "setsid node /tmp/arker-auth-proxy.mjs >/tmp/arker-auth-proxy.stderr 2>&1 </dev/null &"],
  });
  assert.equal(launchedProxy.exit_code, 0, output(launchedProxy.stderr_b64));
  const readyProxy = await kernel.browsers.process.exec(browserId, {
    command: "bash",
    args: ["-lc", "for _ in $(seq 1 100); do grep -q '^ready$' /tmp/arker-auth-proxy.log 2>/dev/null && exit 0; sleep 0.1; done; cat /tmp/arker-auth-proxy.stderr >&2; exit 1"],
  });
  assert.equal(readyProxy.exit_code, 0, output(readyProxy.stderr_b64));
  progress("authenticated-proxy-ready", { guest_port: upstreamProxyPort });

  const profileStarted = performance.now();
  const profiled = await kernel.browsers.update(browserId, { profile: { id: profileId, save_changes: true } });
  assert.equal(profiled.profile?.id, profileId);
  await assertBrowserProtocols(profiled);
  progress("profile-attached", { update_ms: Math.round(performance.now() - profileStarted) });
  const marker = `profile-${randomUUID()}`;
  const cookieExpires = Math.floor(Date.now() / 1_000) + 86_400;
  const stored = await kernel.browsers.playwright.execute(browserId, {
    code: `await page.goto("https://example.com"); await context.addCookies([{name:"arker_profile",value:${JSON.stringify(marker)},url:"https://example.com",expires:${cookieExpires}}]); return (await context.cookies("https://example.com")).find(cookie=>cookie.name==="arker_profile")?.value;`,
  });
  assert.equal(stored.result, marker);
  progress("profile-state-written");

  const rejectedProxy = await kernel.browsers.update(browserId, { proxy_id: unavailableProxyId });
  assert.equal(rejectedProxy.proxy_id, unavailableProxyId);
  const rejectedNavigation = await kernel.browsers.playwright.execute(browserId, {
    code: `await page.goto("https://example.com/?arker-proxy-wrong=${suffix}", { waitUntil: "domcontentloaded", timeout: 15000 }); return true;`,
    timeout_sec: 20,
  });
  assert.equal(rejectedNavigation.success, false, `wrong proxy credentials unexpectedly navigated: ${JSON.stringify(rejectedNavigation)}`);
  const rejectedEvents = await kernel.browsers.process.exec(browserId, {
    command: "bash",
    args: ["-lc", "grep -c '^rejected$' /tmp/arker-auth-proxy.log"],
  });
  assert.equal(rejectedEvents.exit_code, 0, output(rejectedEvents.stderr_b64));
  assert(Number(output(rejectedEvents.stdout_b64).trim()) >= 1);
  progress("authenticated-proxy-wrong-credentials-rejected");

  const proxyStarted = performance.now();
  const proxied = await kernel.browsers.update(browserId, { proxy_id: customProxyId });
  assert.equal(proxied.proxy_id, customProxyId);
  progress("proxy-attached", { update_ms: Math.round(performance.now() - proxyStarted) });
  const proxyConfig = await kernel.browsers.process.exec(browserId, {
    command: "python3",
    args: ["-c", "import json,os,sys; q=json.load(open('/opt/arker-kernel/config.json')); assert q['proxy']['host']=='127.0.0.1'; assert q['proxy']['port']==int(sys.argv[1]); assert os.path.isfile(q['proxy']['extensionPath']+'/manifest.json')", String(upstreamProxyPort)],
  });
  assert.equal(proxyConfig.exit_code, 0, output(proxyConfig.stderr_b64));
  const proxiedNavigation = await kernel.browsers.playwright.execute(browserId, {
    code: `await page.goto("https://example.com/?arker-proxy=${suffix}", { waitUntil: "domcontentloaded" }); return { title: await page.title(), url: page.url() };`,
  });
  if (proxiedNavigation.success !== true) {
    const diagnostics = await kernel.browsers.process.exec(browserId, {
      command: "bash",
      args: ["-lc", "printf '%s\\n' PROXY_EVENTS; tail -n 30 /tmp/arker-auth-proxy.log 2>/dev/null; printf '%s\\n' EXTENSION_DIRS; find /opt/arker-kernel/extensions -maxdepth 1 -type d -name 'proxy-auth-*' -printf '%f\\n' 2>/dev/null; printf '%s\\n' CHROME_PROCESSES; pgrep -af 'cloakbrowser|chrome' | sed -E 's/(proxy-server=[^ ]+)/proxy-server=<redacted>/g'"],
    });
    progress("authenticated-proxy-navigation-failed", {
      result: proxiedNavigation,
      diagnostics: output(diagnostics.stdout_b64),
    });
  }
  assert.deepEqual(proxiedNavigation.result, { title: "Example Domain", url: `https://example.com/?arker-proxy=${suffix}` });
  const proxyEvents = await kernel.browsers.process.exec(browserId, {
    command: "bash",
    args: ["-lc", "grep -c '^accepted-connect example.com:443$' /tmp/arker-auth-proxy.log"],
  });
  assert.equal(proxyEvents.exit_code, 0, output(proxyEvents.stderr_b64));
  const acceptedConnects = Number(output(proxyEvents.stdout_b64).trim());
  assert(acceptedConnects >= 1, `expected a browser CONNECT, got ${output(proxyEvents.stdout_b64)}`);
  progress("authenticated-proxy-navigation-verified", { accepted_connects: acceptedConnects });

  const direct = await kernel.browsers.update(browserId, { proxy_id: "" });
  assert.equal(direct.proxy_id, undefined);
  await assertBrowserProtocols(direct);
  const directConfig = await kernel.browsers.process.exec(browserId, {
    command: "python3",
    args: ["-c", "import json,os; q=json.load(open('/opt/arker-kernel/config.json')); assert 'proxy' not in q; assert not any(name.startswith('proxy-auth') for name in os.listdir('/opt/arker-kernel/extensions')); assert not os.path.exists('/usr/local/share/ca-certificates/arker-kernel-proxy.crt')"],
  });
  assert.equal(directConfig.exit_code, 0, output(directConfig.stderr_b64));
  const directNavigation = await kernel.browsers.playwright.execute(browserId, {
    code: `await page.goto("https://example.com/?arker-direct=${suffix}", { waitUntil: "domcontentloaded" }); return page.url();`,
  });
  assert.equal(directNavigation.result, `https://example.com/?arker-direct=${suffix}`);
  progress("proxy-detached-and-protocols-refreshed");

  await kernel.browsers.deleteByID(browserId);
  ownedVmIds.delete(browserId);
  browserId = undefined;
  progress("browser-deleted-and-profile-saved");
  const tar = Buffer.from(await (await kernel.profiles.download(profileId, { format: "tar" })).arrayBuffer());
  const zstd = Buffer.from(await (await kernel.profiles.download(profileId)).arrayBuffer());
  assert(tar.length > 1_024);
  assert.equal(zstd.subarray(0, 4).toString("hex"), "28b52ffd");
  assertZstdRoundTrip(zstd, tar);
  progress("profile-zstd-verified", { tar_bytes: tar.length, zstd_bytes: zstd.length });

  const pool = await kernel.browserPools.create({
    size: 1,
    name: `control-pool-${suffix}`,
    headless: true,
    timeout_seconds: 300,
    profile: { id: profileId },
    extensions: [{ id: extensionId }],
    proxy_id: customProxyId,
    refresh_on_profile_update: false,
    start_url: "https://example.com/pool-start",
    telemetry: { enabled: true, browser: { network: { enabled: true } } },
  });
  poolId = pool.id;
  const originalPoolTelemetry = (pool.browser_pool_config as Record<string, any>).telemetry;
  const normalizedPool = await kernel.browserPools.update(poolId, { start_url: "", telemetry: {} });
  const normalizedPoolConfig = normalizedPool.browser_pool_config as Record<string, any>;
  assert.equal("start_url" in normalizedPoolConfig, false);
  assert.equal(normalizedPoolConfig.refresh_on_profile_update, false);
  assert.deepEqual(normalizedPoolConfig.telemetry, originalPoolTelemetry);
  progress("pool-created", { pool_id: poolId });
  const acquireStarted = performance.now();
  const pooled = await kernel.browserPools.acquire(poolId, {
    acquire_timeout_seconds: 240,
    name: `control-lease-${suffix}`,
    telemetry: { browser: { console: { enabled: true } } },
  });
  poolSessionId = pooled.session_id;
  ownedVmIds.add(poolSessionId);
  assert.equal(pooled.pool?.id, poolId);
  assert.equal(pooled.profile?.id, profileId);
  assert.equal(pooled.proxy_id, customProxyId);
  assert.equal(pooled.telemetry?.browser?.network?.enabled, true);
  assert.equal(pooled.telemetry?.browser?.console?.enabled, true);
  progress("pool-acquired", { browser_id: poolSessionId, acquire_ms: Math.round(performance.now() - acquireStarted) });
  const pooledState = await kernel.browsers.playwright.execute(poolSessionId, {
    code: `return (await context.cookies("https://example.com")).find(cookie=>cookie.name==="arker_profile")?.value;`,
  });
  assert.equal(pooledState.result, marker);
  const poolConfig = await kernel.browsers.process.exec(poolSessionId, {
    command: "python3",
    args: ["-c", "import json,os,sys; q=json.load(open('/opt/arker-kernel/config.json')); assert os.path.isfile(sys.argv[1]); assert q['proxy']['host']=='127.0.0.1'; assert q['proxy']['port']==int(sys.argv[2])", `/opt/arker-kernel/extensions/stored-${extensionId}/manifest.json`, String(upstreamProxyPort)],
  });
  assert.equal(poolConfig.exit_code, 0, output(poolConfig.stderr_b64));
  progress("pool-state-verified");

  await kernel.browserPools.release(poolId, { session_id: poolSessionId });
  progress("pool-released");
  const reacquireStarted = performance.now();
  const reacquired = await kernel.browserPools.acquire(poolId, { acquire_timeout_seconds: 10 });
  assert.equal(reacquired.session_id, poolSessionId);
  assert.equal(reacquired.telemetry?.browser?.network?.enabled, true);
  assert.equal(reacquired.telemetry?.browser?.console, undefined);
  progress("pool-reacquired", { reacquire_ms: Math.round(performance.now() - reacquireStarted) });
  await kernel.browserPools.release(poolId, { session_id: poolSessionId, reuse: false });
  ownedVmIds.delete(poolSessionId);
  poolSessionId = undefined;
  progress("pool-discarded");

  await kernel.browserPools.delete(poolId, { force: true });
  poolId = undefined;
  await kernel.proxies.delete(customProxyId!);
  customProxyId = undefined;
  await kernel.proxies.delete(unavailableProxyId!);
  unavailableProxyId = undefined;
  await kernel.extensions.delete(extensionId!);
  extensionId = undefined;
  await kernel.profiles.delete(profileId!);
  profileId = undefined;
  progress("resources-deleted");
  console.log("PASS Kernel control resources on Arker");
} finally {
  if (poolId) await kernel.browserPools.delete(poolId, { force: true }).catch(() => undefined);
  if (poolSessionId) ownedVmIds.add(poolSessionId);
  if (browserId) ownedVmIds.add(browserId);
  for (const id of ownedVmIds) {
    const vm = await arker.getVm(id).catch(() => undefined);
    await vm?.delete().catch(() => undefined);
  }
  if (customProxyId) await kernel.proxies.delete(customProxyId).catch(() => undefined);
  if (unavailableProxyId) await kernel.proxies.delete(unavailableProxyId).catch(() => undefined);
  if (extensionId) await kernel.extensions.delete(extensionId).catch(() => undefined);
  if (profileId) await kernel.profiles.delete(profileId).catch(() => undefined);
  const internals = proxy as unknown as { poolFillQueues: Map<string, Promise<void>>; serverSockets: Set<unknown> };
  progress("proxy-close-start", { pool_fills: internals.poolFillQueues.size, sockets: internals.serverSockets.size });
  const closeWatchdog = setInterval(() => {
    progress("proxy-close-wait", { pool_fills: internals.poolFillQueues.size, sockets: internals.serverSockets.size });
  }, 5_000);
  closeWatchdog.unref?.();
  await proxy.close().finally(() => clearInterval(closeWatchdog));
  progress("proxy-closed");
  await rm(stateDirectory, { recursive: true, force: true });
}
