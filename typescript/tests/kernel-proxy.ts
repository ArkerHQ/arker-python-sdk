import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import Kernel from "@onkernel/sdk";
import { WebSocket } from "ws";

import { ArkerError, type Arker } from "../src/index.js";
import { KernelProxy } from "../src/kernel-proxy.js";

const encoder = new TextEncoder();
const decoder = new TextDecoder();

type FakeRun = {
  state: "running" | "completed" | "failed";
  exit_code: number | null;
  stdoutBytes: Uint8Array;
  stderrBytes: Uint8Array;
};

class FakePtyConnection {
  readonly ready = Promise.resolve();
  private readonly dataListeners = new Set<(data: Uint8Array) => void>();
  private readonly closeListeners = new Set<() => void>();
  private readonly errorListeners = new Set<(error: unknown) => void>();

  constructor(readonly sessionId: string) {}

  onData(listener: (data: Uint8Array) => void): () => void {
    this.dataListeners.add(listener);
    return () => this.dataListeners.delete(listener);
  }

  onClose(listener: () => void): () => void {
    this.closeListeners.add(listener);
    return () => this.closeListeners.delete(listener);
  }

  onError(listener: (error: unknown) => void): () => void {
    this.errorListeners.add(listener);
    return () => this.errorListeners.delete(listener);
  }

  send(data?: string | Uint8Array): void {
    const text = typeof data === "string" ? data : data ? decoder.decode(data) : "";
    const marker = text.match(/(__ARKER_(?:WATCH|LOG)_READY_[A-Za-z0-9-]+__)/)?.[1];
    if (marker) setTimeout(() => this.emit(`\n${marker}\n`), 0);
  }
  resize(): void {}
  kill(): void {}

  close(): void {
    for (const listener of this.closeListeners) listener();
  }

  emit(text: string): void {
    const data = encoder.encode(text);
    for (const listener of this.dataListeners) listener(data);
  }
}

class FakeVM {
  readonly id = "vm_kernel_test";
  description = "";
  deleted = false;
  deleteCount = 0;
  discoveryFailures = 0;
  failSetup = false;
  readonly files = new Map<string, Uint8Array>();
  readonly commands: string[] = [];
  readonly runCalls: Array<{ command: string; options: Record<string, unknown> }> = [];
  readonly runs = new Map<string, FakeRun>();
  readonly deletedSessions: string[] = [];
  readonly ptyConnections: FakePtyConnection[] = [];
  resources = { disk_mib: 4096, memory_mib: 1024, vcpu: 2 };
  readonly updateCalls: Array<Record<string, unknown>> = [];
  private nextRun = 1;
  private nextSession = 1;

  get createdSessionCount(): number { return this.nextSession - 1; }

  async run(command: string, options: { background?: boolean; keep_alive?: boolean; session_idx?: number } = {}): Promise<any> {
    this.commands.push(command);
    this.runCalls.push({ command, options: { ...options } });
    if (this.failSetup && command.includes("arker-kernel-setup.sh")) throw new Error("injected setup failure");
    if (command.includes("/json/version") && this.discoveryFailures > 0) {
      this.discoveryFailures -= 1;
      throw new ArkerError("not_found", `VM ${this.id} not found (deleted during run)`, 404);
    }
    const runId = `run-${this.nextRun++}`;
    if (options.background) {
      this.runs.set(runId, { state: "running", exit_code: null, stdoutBytes: new Uint8Array(), stderrBytes: new Uint8Array() });
      return { type: "background", runId };
    }
    if (command.includes("/json/version")) await new Promise((resolve) => setTimeout(resolve, 5));
    const stdout = command.includes("__ARKER_KERNEL_ENDPOINTS__")
      ? '__ARKER_KERNEL_ENDPOINTS__\u001b[1;39m{\u001b[0m"cdp":"ws://127.0.0.1:9222/devtools/browser/fake","bidi":"ws://127.0.0.1:9515/session/fake"}'
      : command.includes("/json/version")
        ? JSON.stringify({ webSocketDebuggerUrl: "ws://127.0.0.1:9222/devtools/browser/fake" })
        : `ran:${command}`;
    return {
      type: "completed",
      runId,
      exitCode: 0,
      stdoutBytes: encoder.encode(stdout),
      stderrBytes: new Uint8Array(),
    };
  }

  async sync(path: string, data?: string | Uint8Array): Promise<any> {
    if (data === undefined) {
      const stored = this.files.get(path);
      if (!stored && path === "/etc/os-release") return encoder.encode("ID=ubuntu\n");
      if (!stored && /\/arker-kernel-playwright-[^/]+\.json$/.test(path) && !path.endsWith(".request.json")) {
        const latestRequest = [...this.files]
          .reverse()
          .find(([candidate]) => candidate.endsWith(".request.json"));
        const code = latestRequest ? (JSON.parse(decoder.decode(latestRequest[1])) as { code?: string }).code || "" : "";
        const result = code.includes("body_b64")
          ? { status: 200, headers: { "content-type": ["text/plain"] }, body_b64: Buffer.from("direct-browser-unit").toString("base64"), duration_ms: 1 }
          : true;
        return encoder.encode(JSON.stringify({ success: true, result }));
      }
      if (!stored) throw new Error(`missing fake file ${path}`);
      return stored;
    }
    const bytes = typeof data === "string" ? encoder.encode(data) : new Uint8Array(data);
    this.files.set(path, bytes);
    if (path.endsWith("/signal") && bytes.length > 0) {
      for (const run of this.runs.values()) {
        if (run.state === "running") {
          run.state = "failed";
          run.exit_code = decoder.decode(bytes) === "KILL" ? 137 : 143;
        }
      }
    }
    return { ok: true };
  }

  async createSession(): Promise<{ session_id: string }> {
    return { session_id: `session-${this.nextSession++}` };
  }

  async deleteSession(sessionId: string): Promise<void> {
    this.deletedSessions.push(sessionId);
  }

  async connectPty(options: { command?: string }): Promise<FakePtyConnection> {
    this.commands.push(String(options.command || ""));
    const connection = new FakePtyConnection(`session-${this.nextSession++}`);
    this.ptyConnections.push(connection);
    if (options.command?.includes("inotifywait")) setTimeout(() => connection.emit("Setting up watches.  Beware: since -r was given, this may take a while!\nWatches established.\n"), 0);
    return connection;
  }

  async signal(): Promise<void> {}

  async getRun(runId: string): Promise<any> {
    const run = this.runs.get(runId);
    if (!run) throw new Error(`missing fake run ${runId}`);
    return run;
  }

  async getPolicies(): Promise<{ hostname: string }> {
    return { hostname: "kernel-test.example.invalid" };
  }

  async refresh(): Promise<this> {
    return this;
  }

  async update(request: { resources?: { memory_mib?: number | null; vcpu?: number | null; disk_mib?: number | null } }): Promise<this> {
    this.updateCalls.push(request);
    if (request.resources?.memory_mib != null) this.resources.memory_mib = request.resources.memory_mib;
    if (request.resources?.vcpu != null) this.resources.vcpu = request.resources.vcpu;
    if (request.resources?.disk_mib != null) this.resources.disk_mib = request.resources.disk_mib;
    return this;
  }

  async delete(): Promise<void> {
    this.deleteCount += 1;
    this.deleted = true;
  }
}

class FakeArker {
  readonly vm = new FakeVM();
  readonly forks: Array<{ source: unknown; options: Record<string, unknown> }> = [];
  listCopies = 1;

  async fork(source: unknown, options: Record<string, unknown> = {}): Promise<FakeVM> {
    if (source && typeof source === "object" && "sourceVmId" in source) {
      options = source as Record<string, unknown>;
    }
    this.forks.push({ source, options });
    this.vm.description = String(options.description ?? "");
    this.vm.deleted = false;
    return this.vm;
  }

  async getVm(id: string): Promise<FakeVM> {
    if (id !== this.vm.id || this.vm.deleted) throw new Error("not found");
    return this.vm;
  }

  async listVms(): Promise<{ vms: FakeVM[]; nextCursor: null }> {
    return { vms: this.vm.deleted ? [] : new Array(this.listCopies).fill(this.vm), nextCursor: null };
  }
}

async function json(response: Response): Promise<any> {
  return response.json();
}

function lastGuestCommand(vm: FakeVM): string {
  return [...vm.commands].reverse().find((command) => command !== "true" && command !== "sync") ?? "";
}

async function expectWebSocketRejected(url: string): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const socket = new globalThis.WebSocket(url);
    const timeout = setTimeout(() => {
      socket.close();
      reject(new Error("rejected WebSocket upgrade timed out"));
    }, 2_000);
    socket.addEventListener("open", () => {
      clearTimeout(timeout);
      socket.close();
      reject(new Error("cross-capability WebSocket unexpectedly opened"));
    });
    socket.addEventListener("error", () => {
      clearTimeout(timeout);
      resolve();
    });
  });
}

async function main(): Promise<void> {
  const savedAutomaticStandby = process.env.KERNEL_PROXY_AUTOMATIC_STANDBY;
  const savedStandbyDelay = process.env.KERNEL_PROXY_STANDBY_DELAY_MS;
  delete process.env.KERNEL_PROXY_AUTOMATIC_STANDBY;
  delete process.env.KERNEL_PROXY_STANDBY_DELAY_MS;
  try {
    const defaultProxy = new KernelProxy({
      arker: new FakeArker() as unknown as Arker,
      host: "127.0.0.1",
      port: 0,
    }) as unknown as { options: { automaticStandby: boolean; standbyDelayMs: number } };
    assert.equal(defaultProxy.options.automaticStandby, true);
    assert.equal(defaultProxy.options.standbyDelayMs, 5_000);
  } finally {
    if (savedAutomaticStandby === undefined) delete process.env.KERNEL_PROXY_AUTOMATIC_STANDBY;
    else process.env.KERNEL_PROXY_AUTOMATIC_STANDBY = savedAutomaticStandby;
    if (savedStandbyDelay === undefined) delete process.env.KERNEL_PROXY_STANDBY_DELAY_MS;
    else process.env.KERNEL_PROXY_STANDBY_DELAY_MS = savedStandbyDelay;
  }
  assert.throws(
    () => new KernelProxy({ arker: new FakeArker() as unknown as Arker, host: "127.0.0.1", port: Number.NaN }),
    /port must be an integer/,
  );
  assert.throws(
    () => new KernelProxy({ arker: new FakeArker() as unknown as Arker, sourcePlatforms: [] }),
    /At least one Arker source platform/,
  );
  assert.throws(
    () => new KernelProxy({ arker: new FakeArker() as unknown as Arker, sourcePlatforms: [""] }),
    /every platform must be non-empty/,
  );
  assert.throws(
    () => new KernelProxy({ arker: new FakeArker() as unknown as Arker, sourceVmId: "" }),
    /source VM ID must be a non-empty string/,
  );
  assert.throws(
    () => new KernelProxy({ arker: new FakeArker() as unknown as Arker, sourceLayers: ["memory"] }),
    /source layers must contain disk/,
  );
  assert.throws(
    () => new KernelProxy({ arker: new FakeArker() as unknown as Arker, signingSecret: "" }),
    /signing secret must not be empty/,
  );
  assert.throws(
    () => new KernelProxy({ arker: new FakeArker() as unknown as Arker, createAttempts: 0 }),
    /create attempts must be an integer between 1 and 5/,
  );
  assert.throws(
    () => new KernelProxy({ arker: new FakeArker() as unknown as Arker, publicBaseUrl: "file:///tmp/proxy" }),
    /public URL must be a valid http or https URL/,
  );
  assert.throws(
    () => new KernelProxy({ arker: new FakeArker() as unknown as Arker, host: "0.0.0.0", port: 0 }),
    /KERNEL_PROXY_API_KEY is required/,
  );

  const preparedArker = new FakeArker();
  const preparedProxy = new KernelProxy({
    arker: preparedArker as unknown as Arker,
    host: "127.0.0.1",
    port: 0,
    automaticStandby: true,
    standbyDelayMs: 60_000,
    runtimeMemoryMib: 512,
    runtimeVcpu: 1,
  });
  const prepared = await preparedProxy.prepareSource("unit-prepared-source");
  assert.equal(prepared.id, preparedArker.vm.id);
  assert.equal(preparedArker.forks[0]?.source, "ubuntu-full");
  assert.equal(preparedArker.forks[0]?.options.name, "unit-prepared-source");
  assert.match(String(preparedArker.forks[0]?.options.description), /^arker-kernel-source-v1:/);
  assert.deepEqual(preparedArker.forks[0]?.options.policies, { policies: [{ type: "outbound", action: "allow" }] });
  assert(preparedArker.vm.commands.some((command) => command.includes("arker-kernel-setup.sh")));
  assert.deepEqual(preparedArker.vm.updateCalls, [{ resources: { memory_mib: 512, vcpu: 1, disk_mib: null } }]);
  assert.deepEqual(preparedArker.vm.runCalls.at(-1)?.options, {
    timeout: 20,
    session_idx: 1,
    keep_alive: true,
    idempotencyKey: preparedArker.vm.runCalls.at(-1)?.options.idempotencyKey,
  });
  assert.match(String(preparedArker.vm.runCalls.at(-1)?.options.idempotencyKey), /^[0-9a-f-]{36}$/);
  assert.equal((preparedProxy as unknown as { vmStandbyTimers: Map<string, unknown> }).vmStandbyTimers.size, 0);

  const inheritedArker = new FakeArker();
  const inheritedProxy = new KernelProxy({
    arker: inheritedArker as unknown as Arker,
    sourceVmId: "vm_prepared_source",
    sourceLayers: ["disk", "memory"],
    runtimeMemoryMib: 512,
    runtimeVcpu: 1,
    host: "127.0.0.1",
    port: 0,
  });
  const setupScript = await readFile(join(process.cwd(), "scripts/kernel-proxy/setup-cloakbrowser.sh"));
  const setupFingerprint = createHash("sha256").update(setupScript).update("\0").update("0.5.5").digest("hex");
  const inheritedConfig = JSON.stringify({
    headless: true,
    stealth: true,
    startUrl: "about:blank",
    viewport: { width: 1280, height: 720 },
    cloakbrowserBinaryVersion: "146.0.7680.177.5",
    browserArgs: [],
    chromePolicy: {},
    lowMemoryMode: true,
    profilePath: "/var/lib/arker-kernel/profile",
    profileReset: false,
  });
  inheritedArker.vm.files.set("/opt/arker-kernel/prepared-runtime.json", encoder.encode(JSON.stringify({
    version: 1,
    setup_fingerprint: setupFingerprint,
    config_sha256: createHash("sha256").update(inheritedConfig).digest("hex"),
    cdp: "ws://127.0.0.1:9222/devtools/browser/inherited",
    bidi: "ws://127.0.0.1:9515/session/inherited",
  })));
  const inheritedEndpoints = await (inheritedProxy as any).setupGuest(
    inheritedArker.vm,
    { headless: true, stealth: true },
    { width: 1280, height: 720 },
    { extensions: [] },
  );
  assert.deepEqual(inheritedEndpoints, {
    cdpPath: "/devtools/browser/inherited",
    bidiPath: "/session/inherited",
  });
  assert.equal(inheritedArker.vm.runCalls.length, 0, "exact prepared manifest must not execute a guest command");
  assert.equal(inheritedArker.vm.files.has("/tmp/arker-kernel-config.json"), false, "exact prepared manifest must not upload config");
  inheritedArker.vm.files.delete("/opt/arker-kernel/prepared-runtime.json");
  const cachedEndpoints = await (inheritedProxy as any).setupGuest(
    inheritedArker.vm,
    { headless: true, stealth: true },
    { width: 1280, height: 720 },
    { extensions: [] },
  );
  assert.deepEqual(cachedEndpoints, inheritedEndpoints);
  assert.equal(inheritedArker.vm.runCalls.length, 0, "cached prepared manifest must remain a zero-command fork path");

  const failedPreparedArker = new FakeArker();
  failedPreparedArker.vm.failSetup = true;
  const failedPreparedProxy = new KernelProxy({
    arker: failedPreparedArker as unknown as Arker,
    host: "127.0.0.1",
    port: 0,
    automaticStandby: true,
    standbyDelayMs: 60_000,
  });
  await assert.rejects(() => failedPreparedProxy.prepareSource("unit-failed-source"), /injected setup failure/);
  assert.equal(failedPreparedArker.vm.deleteCount, 1);
  assert.equal((failedPreparedProxy as unknown as { vmStandbyTimers: Map<string, unknown> }).vmStandbyTimers.size, 0);

  const arker = new FakeArker();
  arker.vm.discoveryFailures = 1;
  const stateDirectory = await mkdtemp(join(tmpdir(), "arker-kernel-proxy-test-"));
  const proxy = new KernelProxy({
    arker: arker as unknown as Arker,
    apiKey: "kernel-test-key",
    signingSecret: "deterministic-test-secret",
    host: "127.0.0.1",
    // Let the OS allocate a free port so concurrent/repeated test runs cannot
    // collide with another proxy process between choosing and binding a port.
    port: 0,
    skipSetup: true,
    automaticStandby: false,
    createAttempts: 2,
    sourceVmName: "ubuntu-full",
    sourcePlatforms: ["icelake"],
    stateDirectory,
  });
  const { url } = await proxy.listen();
  const request = (path: string, init: RequestInit = {}) => fetch(`${url}${path}`, {
    ...init,
    headers: { authorization: "Bearer kernel-test-key", ...(init.headers ?? {}) },
  });
  let deletedSessionsBeforeClose = 0;

  try {
    assert.equal((await fetch(`${url}/healthz`)).status, 200);
    assert.equal((await fetch(`${url}/browsers`)).status, 401);

    const kernel = new Kernel({ apiKey: "kernel-test-key", baseURL: url, maxRetries: 0 });
    const profile = await kernel.profiles.create({ name: "unit-profile" });
    assert.match(profile.id, /^prof_/);
    assert.equal((await kernel.profiles.retrieve("unit-profile")).id, profile.id);
    assert.deepEqual((await kernel.profiles.list({ name: "UNIT-PROFILE" })).items.map((item) => item.id), [profile.id]);
    assert.equal((await kernel.profiles.update(profile.id, { name: "unit-profile-renamed" })).name, "unit-profile-renamed");
    assert.equal((await kernel.profiles.retrieve("unit-profile-renamed")).id, profile.id);
    const emptyProfileTar = Buffer.from(await (await kernel.profiles.download(profile.id, { format: "tar" })).arrayBuffer());
    assert.equal(emptyProfileTar.length, 0);
    const emptyProfileZstd = Buffer.from(await (await kernel.profiles.download(profile.id)).arrayBuffer());
    assert.equal(emptyProfileZstd.length, 0);

    const extensionZip = Buffer.from("UEsDBBQAAAAIAHOqBV060pKOQQAAAEYAAAANAAAAbWFuaWZlc3QuanNvbqtWyk3My0xLLS6JL0stKs7Mz1OyMtZRykvMTVWyUnIsyk4tUvBOLcpLzVFwy6woKS1KVdJRgqtUMtQz0DNQqgUAUEsBAhQDFAAAAAgAc6oFXTrSko5BAAAARgAAAA0AAAAAAAAAAAAAAIABAAAAAG1hbmlmZXN0Lmpzb25QSwUGAAAAAAEAAQA7AAAAbAAAAAAA", "base64");
    const extension = await kernel.extensions.upload({
      name: "unit-extension",
      file: new File([extensionZip], "unit-extension.zip", { type: "application/zip" }),
    });
    assert.match(extension.id, /^ext_/);
    assert.equal((await kernel.extensions.get("unit-extension")).checksum, extension.checksum);
    assert.deepEqual(Buffer.from(await (await kernel.extensions.download(extension.id)).arrayBuffer()), extensionZip);
    assert.deepEqual((await kernel.extensions.list({ query: extension.id })).items.map((item) => item.id), [extension.id]);

    const customProxy = await kernel.proxies.create({
      type: "custom",
      name: "unit-proxy",
      protocol: "http",
      bypass_hosts: ["localhost"],
      config: { host: "proxy.example.invalid", port: 8080, username: "unit-user", password: "unit-secret" },
    });
    assert.match(customProxy.id!, /^proxy_/);
    assert.equal((customProxy.config as { has_password?: boolean }).has_password, true);
    assert.equal("password" in (customProxy.config as object), false);
    assert.equal((await kernel.proxies.retrieve(customProxy.id!)).id, customProxy.id);
    assert.deepEqual((await kernel.proxies.list({ name: "unit-proxy" })).items.map((item) => item.id), [customProxy.id]);
    await assert.rejects(
      () => kernel.proxies.check(customProxy.id!, { url: "http://127.0.0.1/" }),
      (error: { status?: number }) => error.status === 422,
    );
    assert.equal((await kernel.proxies.check(customProxy.id!, { url: "https://8.8.8.8/" })).status, "unavailable");
    assert.equal((await kernel.proxies.retrieve(customProxy.id!)).status, undefined);
    assert.equal((await kernel.proxies.check(customProxy.id!)).status, "unavailable");
    assert.equal((await kernel.proxies.retrieve(customProxy.id!)).status, "unavailable");
    const managedProxy = await request("/proxies", {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ type: "residential" }),
    });
    assert.equal(managedProxy.status, 422);
    assert.equal((await json(managedProxy)).error.code, "unsupported_operation");

    const unsupported = await request("/browsers", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ gpu: true }),
    });
    assert.equal(unsupported.status, 422);
    assert.equal((await json(unsupported)).error.code, "unsupported_operation");
    assert.equal(arker.forks.length, 0);

    for (const body of [
      { invocation_id: "kernel-invocation" },
      { chrome_policy: { RemoteDebuggingAllowed: false } },
      { chrome_policy: { ProxyMode: "fixed_servers" } },
      { chrome_policy: { ExtensionInstallBlocklist: ["*"] } },
    ]) {
      const response = await request("/browsers", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      assert.equal(response.status, 422);
      assert.equal((await json(response)).error.code, "unsupported_operation");
      assert.equal(arker.forks.length, 0);
    }

    const invalidViewport = await request("/browsers", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ headless: "yes", viewport: { width: 0, height: 720 } }),
    });
    assert.equal(invalidViewport.status, 422);
    assert.equal((await json(invalidViewport)).error.code, "validation_error");
    assert.equal(arker.forks.length, 0);

    const createdResponse = await request("/browsers", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        name: "unit-browser",
        headless: false,
        stealth: true,
        timeout_seconds: 120,
        start_url: "https://example.com",
        viewport: { width: 1280, height: 720 },
        tags: { suite: "unit" },
        telemetry: { enabled: true, browser: { network: { enabled: true } } },
        profile: { id: profile.id, save_changes: true },
        extensions: [{ name: "unit-extension" }],
        proxy_id: customProxy.id,
      }),
    });
    assert.equal(createdResponse.status, 200);
    const created = await json(createdResponse);
    assert.equal(created.session_id, arker.vm.id);
    assert.equal(created.name, "unit-browser");
    assert.equal(created.profile.id, profile.id);
    assert.equal(created.proxy_id, customProxy.id);
    assert.match(created.cdp_ws_url, /^ws:\/\/127\.0\.0\.1:\d+\/browser\/cdp\?/);
    assert.match(created.cdp_ws_url, /jwt=/);
    const cdpURL = new URL(created.cdp_ws_url);
    const webdriverURL = new URL(created.webdriver_ws_url);
    assert.equal(webdriverURL.pathname, "/browser/bidi");
    assert.notEqual(created.webdriver_ws_url, created.cdp_ws_url);
    const cdpToken = cdpURL.searchParams.get("token");
    const bidiToken = webdriverURL.searchParams.get("token");
    const directTokenFromCDP = cdpURL.searchParams.get("jwt");
    assert(cdpToken);
    assert(bidiToken);
    assert(directTokenFromCDP);
    assert.equal(typeof created.jwt, "string");
    assert.notEqual(created.jwt, cdpToken);
    assert.notEqual(bidiToken, cdpToken);
    assert.notEqual(bidiToken, created.jwt);
    assert.equal(created.jwt, directTokenFromCDP);
    assert.equal(typeof created.browser_live_view_url, "string");
    assert.deepEqual(created.telemetry, {
      browser: {
        captcha: { enabled: true }, connection: { enabled: true }, control: { enabled: true }, system: { enabled: true }, network: { enabled: true },
      },
      export: { otlp: { enabled: false } },
    });
    await new Promise<void>((resolve, reject) => {
      const socket = new WebSocket(created.cdp_ws_url);
      const timeout = setTimeout(() => { socket.terminate(); reject(new Error("unit CDP upgrade timed out")); }, 2_000);
      socket.once("open", () => socket.close());
      socket.once("close", () => { clearTimeout(timeout); resolve(); });
      socket.once("error", (error) => { clearTimeout(timeout); reject(error); });
    });
    const directCapabilityAsCDP = new URL(created.cdp_ws_url);
    directCapabilityAsCDP.searchParams.delete("token");
    await expectWebSocketRejected(directCapabilityAsCDP.toString());
    const cdpCapabilityAsBiDi = new URL(created.webdriver_ws_url);
    cdpCapabilityAsBiDi.searchParams.set("token", cdpToken);
    await expectWebSocketRejected(cdpCapabilityAsBiDi.toString());
    assert.equal(arker.forks[1]!.source, "ubuntu-full");
    assert.deepEqual(arker.forks[1]!.options.platforms, ["icelake"]);
    assert.equal(arker.vm.deleteCount, 1);
    assert.equal(arker.vm.files.has("/opt/arker-kernel/session.json"), true);
    const metadata = JSON.parse(decoder.decode(arker.vm.files.get("/opt/arker-kernel/session.json")!)) as { createdAt: string; lastActivityAt: string };
    assert(Date.parse(metadata.lastActivityAt) > Date.parse(metadata.createdAt));

    const duplicateName = await request("/browsers", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "unit-browser" }),
    });
    assert.equal(duplicateName.status, 409);
    assert.equal((await json(duplicateName)).error.code, "name_conflict");
    assert.equal(arker.forks.length, 2);

    const nativeFetch = globalThis.fetch;
    let liveUpstreamURL: URL | undefined;
    globalThis.fetch = async (input, init) => {
      const target = new URL(input instanceof Request ? input.url : String(input));
      if (target.hostname.includes("-6080.")) {
        liveUpstreamURL = target;
        return new Response("novnc-unit", {
          status: 200,
          headers: { "content-encoding": "gzip", "content-length": "1", "set-cookie": "attacker=upstream", "x-live-upstream": "yes" },
        });
      }
      return nativeFetch(input, init);
    };
    try {
      const live = new URL(created.browser_live_view_url);
      const liveResponse = await fetch(`${url}${live.pathname}${live.search}`, { headers: { "x-forwarded-proto": "https" } });
      assert.equal(await liveResponse.text(), "novnc-unit");
      assert.match(liveResponse.headers.get("set-cookie") || "", /; Secure;/);
      assert.doesNotMatch(liveResponse.headers.get("set-cookie") || "", /attacker/);
      assert.equal(liveResponse.headers.get("content-encoding"), null);
      assert.equal(liveResponse.headers.get("content-length"), String(Buffer.byteLength("novnc-unit")));
      assert.equal(liveResponse.headers.get("x-live-upstream"), "yes");
      assert.equal(liveUpstreamURL?.searchParams.has("token"), false);
    } finally {
      globalThis.fetch = nativeFetch;
    }

    const viewportReplay = await json(await request(`/browsers/${arker.vm.id}/replays`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ framerate: 2, max_duration_in_seconds: 30 }),
    }));
    const blockedViewport = await request(`/browsers/${arker.vm.id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ viewport: { width: 1024, height: 768 } }),
    });
    assert.equal(blockedViewport.status, 409);
    assert.equal((await json(blockedViewport)).error.code, "viewport_in_use");
    const forcedViewport = await request(`/browsers/${arker.vm.id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ viewport: { width: 1024, height: 768, force: true } }),
    });
    assert.equal(forcedViewport.status, 200);
    assert.deepEqual((await json(forcedViewport)).viewport, { width: 1024, height: 768 });
    const replaySegments = await json(await request(`/browsers/${arker.vm.id}/replays`));
    assert.equal(replaySegments.length, 2);
    assert.equal(replaySegments.find((item: any) => item.replay_id === viewportReplay.replay_id)?.finished_at !== null, true);
    const restartedReplay = replaySegments.find((item: any) => item.finished_at === null);
    assert(restartedReplay?.replay_id);
    assert.notEqual(restartedReplay.replay_id, viewportReplay.replay_id);
    assert.equal((await request(`/browsers/${arker.vm.id}/replays/${restartedReplay.replay_id}/stop`, { method: "POST" })).status, 204);

    const rejectedCrossCapability = await fetch(`${created.base_url}/curl/raw?url=${encodeURIComponent("https://example.com")}&jwt=${encodeURIComponent(cdpToken)}`);
    assert.equal(rejectedCrossCapability.status, 401);
    const direct = await fetch(`${created.base_url}/curl/raw?url=${encodeURIComponent("https://example.com")}&jwt=${encodeURIComponent(created.jwt)}`);
    assert.equal(direct.status, 200);
    assert.equal(await direct.text(), "direct-browser-unit");
    const officialKernel = new Kernel({ apiKey: "kernel-test-key", baseURL: url, maxRetries: 0 });
    await officialKernel.browsers.retrieve(arker.vm.id);
    const officialDirect = await officialKernel.browsers.fetch(arker.vm.id, "https://example.com");
    assert.equal(await officialDirect.text(), "direct-browser-unit");
    const binaryDirect = await officialKernel.browsers.fetch(arker.vm.id, "https://example.com/upload", {
      method: "POST",
      body: new Uint8Array([0, 255, 1]),
      headers: { authorization: "Bearer target-unit-token" },
    });
    assert.equal(await binaryDirect.text(), "direct-browser-unit");
    const latestBinaryRequest = [...arker.vm.files]
      .reverse()
      .find(([path]) => path.endsWith(".request.json"));
    assert(latestBinaryRequest);
    const binaryCode = (JSON.parse(decoder.decode(latestBinaryRequest[1])) as { code: string }).code;
    assert.match(binaryCode, /"body_b64":"AP8B"/);
    assert.match(binaryCode, /"authorization":"Bearer target-unit-token"/);

    const listed = await json(await request("/browsers?limit=10&status=active"));
    assert.equal(listed.length, 1);
    assert.equal((await officialKernel.browsers.list({ query: profile.id })).items.length, 1);
    assert.equal((await officialKernel.browsers.list({ query: customProxy.id! })).items.length, 1);
    arker.listCopies = 3;
    const firstOfficialPage = await officialKernel.browsers.list({ limit: 1 });
    assert.equal(firstOfficialPage.items.length, 1);
    assert.equal(firstOfficialPage.has_more, true);
    assert.equal(firstOfficialPage.next_offset, 1);
    const automaticallyPaginated: string[] = [];
    for await (const item of officialKernel.browsers.list({ limit: 1 })) automaticallyPaginated.push(item.session_id);
    assert.deepEqual(automaticallyPaginated, new Array(3).fill(arker.vm.id));
    const finalRawPage = await request("/browsers?limit=1&offset=2");
    assert.equal(finalRawPage.headers.get("x-has-more"), "false");
    assert.equal(finalRawPage.headers.get("x-next-offset"), "0");
    arker.listCopies = 1;
    const deletedPage = await officialKernel.browsers.list({ status: "deleted" });
    assert.deepEqual(deletedPage.items, []);
    assert.equal(deletedPage.has_more, false);
    assert.equal(deletedPage.next_offset, 0);
    const telemetryNow = Date.now() * 1_000;
    arker.vm.files.set("/var/lib/arker-kernel/telemetry.jsonl", encoder.encode([
      JSON.stringify({ seq: 1, event: { ts: telemetryNow, type: "console_log", category: "console", source: { kind: "cdp" } } }),
      JSON.stringify({ seq: 2, event: { ts: telemetryNow + 1, type: "network_idle", category: "network", source: { kind: "cdp" } } }),
      "",
    ].join("\n")));
    const telemetryPage = await officialKernel.browsers.telemetry.events(arker.vm.id, { limit: 1 });
    assert.equal(telemetryPage.items.length, 1);
    assert.equal(telemetryPage.items[0]!.seq, 1);
    assert.equal(telemetryPage.has_more, true);
    assert.equal(telemetryPage.next_offset, 1);
    const telemetryItems: number[] = [];
    for await (const item of officialKernel.browsers.telemetry.events(arker.vm.id, { limit: 1 })) telemetryItems.push(item.seq);
    assert.deepEqual(telemetryItems, [1, 2]);
    const consoleTelemetry = await officialKernel.browsers.telemetry.events(arker.vm.id, { category: ["console"] });
    assert.deepEqual(consoleTelemetry.items.map((item) => item.event.category), ["console"]);
    const filteredRawPage = await request(`/browsers/${arker.vm.id}/telemetry/events?limit=1&category=network`);
    assert.deepEqual(await json(filteredRawPage), []);
    assert.equal(filteredRawPage.headers.get("x-has-more"), "true");
    assert.equal(filteredRawPage.headers.get("x-next-offset"), "1");
    const filteredSecondPage = await request(`/browsers/${arker.vm.id}/telemetry/events?limit=1&offset=1&category=network`);
    assert.deepEqual((await json(filteredSecondPage)).map((item: { seq: number }) => item.seq), [2]);
    assert.equal((await request(`/browsers/${arker.vm.id}/telemetry/events?order=desc&since=5m`)).status, 400);
    assert.equal((await request("/browsers?limit=NaN")).status, 422);
    assert.equal((await request("/browsers?status=unknown")).status, 422);
    assert.equal((await json(await request("/browsers/unit-browser"))).session_id, arker.vm.id);
    const renamed = await json(await request(`/browsers/${arker.vm.id}`, {
      method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ name: "unit-browser-renamed" }),
    }));
    assert.equal(renamed.name, "unit-browser-renamed");
    assert.equal((await json(await request("/browsers/unit-browser-renamed"))).session_id, arker.vm.id);
    assert.notEqual((await request("/browsers/unit-browser")).status, 200);
    const telemetryUpdated = await json(await request(`/browsers/${arker.vm.id}`, {
      method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ telemetry: { browser: { control: { enabled: false } } } }),
    }));
    assert.equal(telemetryUpdated.telemetry.browser.control.enabled, false);
    assert.equal(telemetryUpdated.telemetry.browser.network.enabled, true);
    const telemetryUnchanged = await json(await request(`/browsers/${arker.vm.id}`, {
      method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ telemetry: {} }),
    }));
    assert.deepEqual(telemetryUnchanged.telemetry, telemetryUpdated.telemetry);
    const telemetryDisabled = await json(await request(`/browsers/${arker.vm.id}`, {
      method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ telemetry: { enabled: false } }),
    }));
    assert.deepEqual(telemetryDisabled.telemetry, { export: { otlp: { enabled: false } } });

    const execResponse = await json(await request(`/browsers/${arker.vm.id}/process/exec`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ command: "node", args: ["-e", "process.stdout.write('ok')"], cwd: "/tmp", env: { PARITY: "yes" } }),
    }));
    assert.equal(execResponse.exit_code, 0);
    assert.match(lastGuestCommand(arker.vm), /cd '\/tmp' && env PARITY='yes' 'node'/);
    await request(`/browsers/${arker.vm.id}/process/exec`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ command: "printf shell-operator; true" }),
    });
    assert.match(lastGuestCommand(arker.vm), /'printf shell-operator; true'/);
    assert.doesNotMatch(lastGuestCommand(arker.vm), /\/bin\/bash -lc 'printf shell-operator; true'/);

    const spawned = await json(await request(`/browsers/${arker.vm.id}/process/spawn`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ command: "sleep", args: ["60"], timeout_sec: 90 }),
    }));
    assert.match(arker.vm.commands.at(-1)!, /setsid --wait timeout --signal=KILL 90/);
    assert.equal((await json(await request(`/browsers/${arker.vm.id}/process/${spawned.process_id}/status`))).state, "running");
    assert.equal((await request(`/browsers/${arker.vm.id}/process/${spawned.process_id}/kill`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ signal: "TERM" }),
    })).status, 200);
    assert.equal(decoder.decode(arker.vm.files.get(`/tmp/arker-kernel-process-${spawned.process_id}/signal`)!), "TERM");
    assert.equal((await json(await request(`/browsers/${arker.vm.id}/process/${spawned.process_id}/status`))).state, "exited");

    const streamingProcess = await json(await request(`/browsers/${arker.vm.id}/process/spawn`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ command: "bash", args: ["-lc", "printf first; sleep 1; printf second"] }),
    }));
    const streamingRun = [...arker.vm.runs.values()].at(-1)!;
    const streamingResponse = await request(`/browsers/${arker.vm.id}/process/${streamingProcess.process_id}/stdout/stream`);
    const streamingReader = streamingResponse.body!.getReader();
    streamingRun.stdoutBytes = encoder.encode("first");
    const firstChunk = await Promise.race([
      streamingReader.read(),
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error("detached output did not stream while running")), 2_000)),
    ]);
    assert.match(decoder.decode(firstChunk.value), new RegExp(Buffer.from("first").toString("base64")));
    streamingRun.stdoutBytes = encoder.encode("firstsecond");
    streamingRun.state = "completed";
    streamingRun.exit_code = 0;
    let finalStream = "";
    for (;;) {
      const chunk = await streamingReader.read();
      if (chunk.done) break;
      finalStream += decoder.decode(chunk.value);
    }
    assert.match(finalStream, new RegExp(Buffer.from("second").toString("base64")));
    assert.match(finalStream, /"event":"exit"/);
    // Browser discovery, direct-browser execution/cleanup, process.exec, and
    // detached processes all use dedicated sessions and release them.
    assert.deepEqual(
      arker.vm.deletedSessions,
      Array.from({ length: arker.vm.createdSessionCount }, (_, index) => `session-${index + 1}`),
    );

    const write = await request(`/browsers/${arker.vm.id}/fs/write_file?path=${encodeURIComponent("/tmp/proxy-unit.txt")}&mode=0600`, {
      method: "PUT",
      headers: { "content-type": "application/octet-stream" },
      body: "filesystem-unit",
    });
    assert.equal(write.status, 204);
    const read = await request(`/browsers/${arker.vm.id}/fs/read_file?path=${encodeURIComponent("/tmp/proxy-unit.txt")}`);
    assert.equal(await read.text(), "filesystem-unit");
    const defaultModePinStart = arker.vm.runCalls.length;
    const defaultModeWrite = await request(`/browsers/${arker.vm.id}/fs/write_file?path=${encodeURIComponent("/tmp/default-mode.txt")}`, {
      method: "PUT", headers: { "content-type": "application/octet-stream" }, body: "default-mode",
    });
    assert.equal(defaultModeWrite.status, 204);
    assert.match(lastGuestCommand(arker.vm), /chmod -- '0644' '\/tmp\/default-mode\.txt'/);
    assert.equal(
      arker.vm.runCalls.slice(defaultModePinStart).some((call) => call.command === "true" || call.command === "sync"),
      false,
      "keep-running mode must not add a wake or checkpoint run to every request",
    );
    const defaultModeDirectory = await request(`/browsers/${arker.vm.id}/fs/create_directory`, {
      method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ path: "/tmp/default-mode-directory" }),
    });
    assert.equal(defaultModeDirectory.status, 204);
    assert.match(lastGuestCommand(arker.vm), /chmod -- '0755' '\/tmp\/default-mode-directory'/);
    assert.equal((await request(`/browsers/${arker.vm.id}/fs/write_file?path=${encodeURIComponent("/tmp/bad-mode")}&mode=--help`, {
      method: "PUT", headers: { "content-type": "application/octet-stream" }, body: "bad",
    })).status, 422);
    assert.equal((await request(`/browsers/${arker.vm.id}/fs/create_directory`, {
      method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ path: "/tmp/bad-directory", mode: "888" }),
    })).status, 422);
    assert.equal((await request(`/browsers/${arker.vm.id}/fs/set_file_permissions`, {
      method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ path: "/tmp/proxy-unit.txt" }),
    })).status, 422);
    assert.equal((await request(`/browsers/${arker.vm.id}/fs/set_file_permissions`, {
      method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ path: "/tmp/proxy-unit.txt", mode: "0600", owner: "--reference=/etc/passwd" }),
    })).status, 422);
    assert.equal((await request(`/browsers/${arker.vm.id}/fs/set_file_permissions`, {
      method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ path: "/tmp/proxy-unit.txt", mode: "0600", owner: "root", group: "root" }),
    })).status, 204);
    assert.match(lastGuestCommand(arker.vm), /chmod -- '0600'.*chown -- 'root:root'/);

    let firstLog: { event?: string; message?: string; timestamp?: string } | undefined;
    for await (const event of await officialKernel.browsers.logs.stream(arker.vm.id, {
      source: "path", path: "/var/log/arker-kernel/browser.log", follow: false,
    })) {
      firstLog = event;
      break;
    }
    assert.equal(firstLog?.event, "log");
    assert.match(firstLog?.message || "", /^ran:tail/);
    assert.equal(Number.isNaN(Date.parse(firstLog?.timestamp || "")), false);
    let supervisorLog: { message?: string } | undefined;
    for await (const event of await officialKernel.browsers.logs.stream(arker.vm.id, {
      source: "supervisor", supervisor_process: "browser", follow: false,
    })) {
      supervisorLog = event;
      break;
    }
    assert.match(supervisorLog?.message || "", /^ran:tail/);
    arker.vm.files.set("/tmp/proxy-unit.txt", encoder.encode(""));
    const followedLogs = await request(`/browsers/${arker.vm.id}/logs/stream?source=path&path=${encodeURIComponent("/tmp/proxy-unit.txt")}&follow=true`);
    assert.equal(followedLogs.status, 200);
    const followedReader = followedLogs.body!.getReader();
    arker.vm.files.set("/tmp/proxy-unit.txt", encoder.encode("guest-followed-log\n"));
    const followedEvent = decoder.decode((await followedReader.read()).value);
    assert.match(followedEvent, /guest-followed-log/);
    await followedReader.cancel();
    assert.equal((await request(`/browsers/${arker.vm.id}/logs/stream?source=unknown`)).status, 422);

    const moved = await request(`/browsers/${arker.vm.id}/computer/move_mouse`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ x: 150, y: 75, smooth: true, duration_ms: 64, hold_keys: ["Shift"] }),
    });
    assert.equal(moved.status, 204);
    let playwrightRequests = [...arker.vm.files]
      .filter(([path]) => path.endsWith(".request.json"))
      .map(([, value]) => JSON.parse(decoder.decode(value)) as { code: string });
    assert.match(playwrightRequests.at(-1)!.code, /keyboard\.down\("Shift"\)/);
    assert.match(playwrightRequests.at(-1)!.code, /steps=4/);

    const pressed = await request(`/browsers/${arker.vm.id}/computer/press_key`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ keys: ["Ctrl+Right"], duration: 25 }),
    });
    assert.equal(pressed.status, 204);
    playwrightRequests = [...arker.vm.files]
      .filter(([path]) => path.endsWith(".request.json"))
      .map(([, value]) => JSON.parse(decoder.decode(value)) as { code: string });
    assert.match(playwrightRequests.at(-1)!.code, /Control\+ArrowRight/);
    assert.match(playwrightRequests.at(-1)!.code, /delay:25/);

    const dragged = await request(`/browsers/${arker.vm.id}/computer/drag_mouse`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ path: [[10, 10], [50, 60]], smooth: true, duration_ms: 64, hold_keys: ["Alt"] }),
    });
    assert.equal(dragged.status, 204);
    assert.deepEqual(await json(await request(`/browsers/${arker.vm.id}/computer/get_mouse_position`, { method: "POST" })), { x: 50, y: 60 });

    const invalidHeldKeys = await request(`/browsers/${arker.vm.id}/computer/scroll`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ x: 1, y: 2, hold_keys: "Shift" }),
    });
    assert.equal(invalidHeldKeys.status, 422);
    assert.equal((await json(invalidHeldKeys)).error.code, "validation_error");

    const invalidDrag = await request(`/browsers/${arker.vm.id}/computer/drag_mouse`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ path: [[0, 0], [null, 1]] }),
    });
    assert.equal(invalidDrag.status, 422);

    const malformedTimeouts = await Promise.all([
      request(`/browsers/${arker.vm.id}/playwright/execute`, {
        method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ code: "return true", timeout_sec: "never" }),
      }),
      request(`/browsers/${arker.vm.id}/curl`, {
        method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ url: "https://example.com", timeout_ms: -1 }),
      }),
      request(`/browsers/${arker.vm.id}/replays`, {
        method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ framerate: "fast" }),
      }),
      request(`/browsers/${arker.vm.id}/computer/batch`, {
        method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ actions: [{ type: "sleep", sleep: { duration_ms: -1 } }] }),
      }),
      request(`/browsers/${arker.vm.id}/process/exec`, {
        method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ command: "true", timeout_sec: "never" }),
      }),
      request(`/browsers/${arker.vm.id}/computer/type`, {
        method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ text: "bad-delay", delay: "never" }),
      }),
      request(`/browsers/${arker.vm.id}/curl`, {
        method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ url: "https://example.com", response_encoding: "hex" }),
      }),
      request(`/browsers/${arker.vm.id}/playwright/execute`, {
        method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ code: "return true", timeout_sec: "5" }),
      }),
      request(`/browsers/${arker.vm.id}/curl`, {
        method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ url: "https://example.com", timeout_ms: "1000" }),
      }),
      request(`/browsers/${arker.vm.id}/replays`, {
        method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ framerate: "2" }),
      }),
      request(`/browsers/${arker.vm.id}/replays`, {
        method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ record_audio: "false" }),
      }),
      request(`/browsers/${arker.vm.id}/replays`, {
        method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ max_duration_in_seconds: 3601 }),
      }),
      request(`/browsers/${arker.vm.id}/computer/batch`, {
        method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ actions: [{ type: "sleep", sleep: { duration_ms: "1" } }] }),
      }),
      request(`/browsers/${arker.vm.id}/computer/type`, {
        method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ text: "bad-delay", delay: "1" }),
      }),
      request(`/browsers/${arker.vm.id}/computer/move_mouse`, {
        method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ x: "1", y: 2, hold_keys: ["Shift"] }),
      }),
      request(`/browsers/${arker.vm.id}/curl`, {
        method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ url: "http://" }),
      }),
      request(`/browsers/${arker.vm.id}/curl`, {
        method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ url: "https://example.com", body_b64: "%%%" }),
      }),
      request(`/browsers/${arker.vm.id}`, {
        method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ viewport: { width: "1280" } }),
      }),
      request(`/browsers/${arker.vm.id}/process/exec`, {
        method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ command: "true", as_user: "--help" }),
      }),
      request(`/browsers/${arker.vm.id}/process/exec`, {
        method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ command: "true", as_root: true, as_user: "ubuntu" }),
      }),
      request(`/browsers/${arker.vm.id}/computer/batch`, {
        method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ actions: [{ type: 1 }] }),
      }),
      request(`/browsers/${arker.vm.id}/curl`, {
        method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ url: "https://example.com", body: "text", body_b64: "dGV4dA==" }),
      }),
      request(`/browsers/${arker.vm.id}`, {
        method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ viewport: { refresh_rate: 59.5 } }),
      }),
      request(`/browsers/${arker.vm.id}`, {
        method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ viewport: { force: "yes" } }),
      }),
      request(`/browsers/${arker.vm.id}`, {
        method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ telemetry: { enabled: "true" } }),
      }),
      request(`/browsers/${arker.vm.id}`, {
        method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ telemetry: { browser: { unknown: { enabled: true } } } }),
      }),
      request(`/browsers/${arker.vm.id}`, {
        method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ telemetry: { browser: { network: null } } }),
      }),
      request(`/browsers/${arker.vm.id}`, {
        method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ telemetry: { enabled: false, browser: { network: { enabled: true } } } }),
      }),
    ]);
    assert.deepEqual(malformedTimeouts.map((response) => response.status), new Array(28).fill(422));

    const rootWatchResponse = await request(`/browsers/${arker.vm.id}/fs/watch`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ path: "/", recursive: true }),
    });
    assert.equal(rootWatchResponse.status, 201);
    const rootWatch = await json(rootWatchResponse);
    const watchedEvents = await request(`/browsers/${arker.vm.id}/fs/watch/${rootWatch.watch_id}/events`);
    const eventReader = watchedEvents.body!.getReader();
    assert.equal((await request(`/browsers/${arker.vm.id}/fs/write_file?path=${encodeURIComponent("/root-watch-unit.txt")}`, {
      method: "PUT",
      body: "watch-unit",
    })).status, 204);
    let eventTimeout: ReturnType<typeof setTimeout> | undefined;
    const firstEvent = await Promise.race([
      eventReader.read(),
      new Promise<never>((_, reject) => { eventTimeout = setTimeout(() => reject(new Error("root watch event timed out")), 2_000); }),
    ]).finally(() => { if (eventTimeout) clearTimeout(eventTimeout); });
    assert.match(decoder.decode(firstEvent.value), /root-watch-unit\.txt/);
    assert.equal((await request(`/browsers/${arker.vm.id}/fs/watch/${rootWatch.watch_id}`, { method: "DELETE" })).status, 204);
    await eventReader.cancel();

    const missing = await request("/not-a-kernel-route");
    assert.equal(missing.status, 404);
    assert.equal((await json(missing)).error.code, "not_found");
    const applicationControlPlane = await request("/apps");
    assert.equal(applicationControlPlane.status, 422);
    assert.equal((await json(applicationControlPlane)).error.code, "unsupported_operation");

    assert.equal((await request(`/browsers/${arker.vm.id}`, { method: "DELETE" })).status, 204);
    assert.equal(arker.vm.deleted, true);

    const pool = await kernel.browserPools.create({
      size: 1,
      name: "unit-pool",
      headless: true,
      timeout_seconds: 120,
      profile: { id: profile.id },
      extensions: [{ id: extension.id }],
      proxy_id: customProxy.id,
      refresh_on_profile_update: false,
      start_url: "https://example.com/pool-start",
      telemetry: { enabled: true, browser: { network: { enabled: true } } },
    });
    assert.match(pool.id, /^pool_/);
    assert.equal(pool.available_count, 0);
    const acquired = await kernel.browserPools.acquire(pool.id, {
      acquire_timeout_seconds: 5,
      name: "unit-pool-lease",
      tags: { lease: "unit" },
      telemetry: { browser: { console: { enabled: true } } },
    });
    assert.equal(acquired.pool?.id, pool.id);
    assert.equal(acquired.name, "unit-pool-lease");
    assert.deepEqual(acquired.tags, { lease: "unit" });
    assert.equal(acquired.telemetry?.browser?.network?.enabled, true);
    assert.equal(acquired.telemetry?.browser?.console?.enabled, true);
    assert.equal((await kernel.browsers.list({ query: pool.id })).items[0]?.session_id, acquired.session_id);
    assert.equal((await kernel.browsers.list({ query: "unit-pool" })).items[0]?.session_id, acquired.session_id);
    assert.equal((await kernel.browserPools.retrieve("unit-pool")).acquired_count, 1);
    await assert.rejects(() => kernel.browserPools.delete(pool.id), (error: { status?: number }) => error.status === 409);
    await kernel.browserPools.release(pool.id, { session_id: acquired.session_id });
    assert.equal((await kernel.browserPools.retrieve(pool.id)).available_count, 1);
    const baselineLease = await kernel.browserPools.acquire(pool.id, { acquire_timeout_seconds: 5 });
    assert.equal(baselineLease.telemetry?.browser?.network?.enabled, true);
    assert.equal(baselineLease.telemetry?.browser?.console, undefined);
    await kernel.browserPools.release(pool.id, { session_id: baselineLease.session_id });
    const originalPoolConfig = pool.browser_pool_config as Record<string, any>;
    assert.equal(originalPoolConfig.refresh_on_profile_update, false);
    assert.equal(originalPoolConfig.start_url, "https://example.com/pool-start");
    assert.equal(originalPoolConfig.telemetry.browser.network.enabled, true);
    const updatedPool = await kernel.browserPools.update(pool.id, {
      name: "unit-pool-renamed",
      size: 1,
      start_url: "",
      telemetry: {},
    });
    assert.equal(updatedPool.name, "unit-pool-renamed");
    const unchangedPoolConfig = updatedPool.browser_pool_config as Record<string, any>;
    assert.equal("start_url" in unchangedPoolConfig, false);
    assert.equal(unchangedPoolConfig.refresh_on_profile_update, false);
    assert.deepEqual(unchangedPoolConfig.telemetry, originalPoolConfig.telemetry);
    const mergedTelemetryPool = await kernel.browserPools.update(pool.id, {
      telemetry: { browser: { console: { enabled: true } } },
    });
    const mergedTelemetry = (mergedTelemetryPool.browser_pool_config as Record<string, any>).telemetry;
    assert.equal(mergedTelemetry.browser.network.enabled, true);
    assert.equal(mergedTelemetry.browser.console.enabled, true);
    const disabledTelemetryPool = await kernel.browserPools.update(pool.id, { telemetry: { enabled: false } });
    assert.equal("telemetry" in (disabledTelemetryPool.browser_pool_config as object), false);
    const nullTelemetryPool = await kernel.browserPools.update(pool.id, { telemetry: null });
    assert.equal("telemetry" in (nullTelemetryPool.browser_pool_config as object), false);
    const refreshingPool = await kernel.browserPools.update(pool.id, { refresh_on_profile_update: true });
    assert.equal((refreshingPool.browser_pool_config as Record<string, any>).refresh_on_profile_update, true);
    const profileClearedPool = await kernel.browserPools.update(pool.id, { profile: { id: "" } });
    assert.equal(profileClearedPool.profile_id, undefined);
    assert.equal("profile" in (profileClearedPool.browser_pool_config as object), false);
    assert.equal("refresh_on_profile_update" in (profileClearedPool.browser_pool_config as object), false);
    const reattachedProfilePool = await kernel.browserPools.update(pool.id, { profile: { id: profile.id } });
    assert.equal(reattachedProfilePool.profile_id, profile.id);
    assert.equal((reattachedProfilePool.browser_pool_config as Record<string, any>).refresh_on_profile_update, true);
    await kernel.browserPools.update(pool.id, { profile: { id: "" } });
    await assert.rejects(
      () => kernel.browserPools.update(pool.id, { profile: null, refresh_on_profile_update: true } as any),
      (error: { status?: number }) => error.status === 422,
    );
    assert.deepEqual((await kernel.browserPools.list({ query: "renamed" })).items.map((item) => item.id), [pool.id]);
    await kernel.browserPools.flush(pool.id);
    await kernel.browserPools.delete(pool.id, { force: true });

    assert.equal((await kernel.proxies.update(customProxy.id!, { name: "unit-proxy-renamed" })).name, "unit-proxy-renamed");
    await kernel.extensions.delete(extension.id);
    await kernel.profiles.delete(profile.id);
    await kernel.proxies.delete(customProxy.id!);

    const shutdownBrowser = await json(await request("/browsers", {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name: "shutdown-browser", headless: true }),
    }));
    const headlessReplay = await request(`/browsers/${shutdownBrowser.session_id}/replays`, {
      method: "POST", headers: { "content-type": "application/json" }, body: "{}",
    });
    assert.equal(headlessReplay.status, 400);
    assert.equal((await json(headlessReplay)).error.code, "unsupported_operation");
    const shutdownWatch = await json(await request(`/browsers/${shutdownBrowser.session_id}/fs/watch`, {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ path: "/tmp" }),
    }));
    await request(`/browsers/${shutdownBrowser.session_id}/process/spawn`, {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ command: "sleep 60" }),
    });
    deletedSessionsBeforeClose = arker.vm.deletedSessions.length;
    // Leave one SSE stream open deliberately; KernelProxy.close() must destroy
    // it so server shutdown cannot hang on a watch client.
    const shutdownStream = await request(`/browsers/${shutdownBrowser.session_id}/fs/watch/${shutdownWatch.watch_id}/events`);
    assert.equal(shutdownStream.status, 200);
  } finally {
    await proxy.close();
    await rm(stateDirectory, { recursive: true, force: true });
  }
  assert(arker.vm.deletedSessions.length > deletedSessionsBeforeClose, "proxy close must release detached Arker sessions");

  console.log("kernel proxy unit tests passed");
}

await main();
