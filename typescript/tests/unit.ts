import assert from "node:assert/strict";

import { Arker, ArkerError, type CompletedRunResult, type PtyWebSocketFactory } from "../src/index.js";
import { isExpectedSurfaceStub } from "./helpers/surface-errors.js";

type FetchCall = {
  url: string;
  method: string;
  body?: string;
  headers: Record<string, string>;
};

type FetchScript = {
  predicate: (method: string, url: string) => boolean;
  response: Response;
};

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
    const headers: Record<string, string> = {};
    for (const [key, value] of Object.entries((init?.headers ?? {}) as Record<string, string>)) {
      headers[key.toLowerCase()] = value;
    }
    this.calls.push({ url, method, body, headers });

    const index = this.script.findIndex((entry) => entry.predicate(method, url));
    assert.notEqual(index, -1, `no scripted response for ${method} ${url}`);
    return this.script.splice(index, 1)[0]!.response;
  };
}

class FakeWebSocket {
  binaryType = "";
  readyState = 1;
  readonly sent: Array<string | Uint8Array | ArrayBuffer> = [];
  private readonly listeners = new Map<string, Set<(event: unknown) => void>>();

  send(data: string | Uint8Array | ArrayBuffer): void {
    this.sent.push(data);
  }

  close(code?: number, reason?: string): void {
    this.emit("close", { code, reason });
  }

  addEventListener(type: string, listener: (event: unknown) => void): void {
    let set = this.listeners.get(type);
    if (!set) {
      set = new Set();
      this.listeners.set(type, set);
    }
    set.add(listener);
  }

  removeEventListener(type: string, listener: (event: unknown) => void): void {
    this.listeners.get(type)?.delete(listener);
  }

  emit(type: string, event: unknown): void {
    for (const listener of this.listeners.get(type) ?? []) listener(event);
  }
}

function client(fetch: FakeFetch): Arker {
  return new Arker({
    apiKey: "ark_live_test",
    baseUrl: "https://test.invalid/api/",
    fetch: fetch.fetch,
    retry: false,
  });
}

function regionClient(fetch: FakeFetch): Arker {
  return new Arker({
    apiKey: "ark_live_test",
    region: "aws-us-west-2",
    fetch: fetch.fetch,
    retry: false,
  });
}

function decode(bytes: Uint8Array): string {
  return new TextDecoder().decode(bytes);
}

async function testForkPostsDirectlyToSourceVm(): Promise<void> {
  const fetch = new FakeFetch();
  // Contract 0.3: forks go to the top-level `/v1/fork` endpoint and
  // pass the source vm id in the body. `Computer.fork()` (the legacy
  // ergonomic) auto-populates `source_vm_id` from the owning Computer.
  fetch.addJson(
    (method, url) => method === "POST" && url === "https://test.invalid/api/v1/fork",
    200,
    {
      vm_id: "vm_child",
      owner_org_id: "owner",
      created_at: "now",
      public: false,
      state: "idle",
      sessions: [],
      tunnels: [],
    },
  );

  const vm = await client(fetch).vm("ubuntu").fork({
    name: "demo",
    description: "CI runner",
    ssh_public_keys: ["ssh-ed25519 AAAA test@example.com"],
  });

  assert.equal(vm.id, "vm_child");
  assert.deepEqual(
    JSON.parse(fetch.calls[0]!.body!),
    {
      name: "demo",
      description: "CI runner",
      ssh_public_keys: ["ssh-ed25519 AAAA test@example.com"],
      source_vm_id: "ubuntu",
      disk: true,
    },
  );
}

async function testForkInfersArkerOrgForMacosFullGolden(): Promise<void> {
  const fetch = new FakeFetch();
  fetch.addJson(
    (method, url) => method === "POST" && url === "https://test.invalid/api/v1/fork",
    200,
    {
      vm_id: "vm_macos",
      owner_org_id: "owner",
      created_at: "now",
      public: false,
      state: "idle",
      sessions: [],
      network: { ssh_public_keys: [] },
      resources: { vcpu: 4, memory_mib: 8192, disk_mib: 10240 },
    },
  );

  const vm = await client(fetch).fork("macos-full", {
    ssh_public_keys: ["ssh-ed25519 AAAA test@example"],
    policies: { policies: [] },
  });

  assert.equal(vm.id, "vm_macos");
  const body = JSON.parse(fetch.calls[0]!.body!);
  assert.equal(body.source_vm_name, "macos-full");
  assert.equal(body.source_org_id, "ArkerHQ");
  assert.equal(body.disk, true);
  assert.equal(body.platforms, undefined);
  assert.deepEqual(body.ssh_public_keys, ["ssh-ed25519 AAAA test@example"]);
  assert.deepEqual(body.policies, { policies: [] });
  assert.equal(body.network, undefined);
  assert.equal(body.egress, undefined);
}

async function testRemovedNetworkInputsFailBeforeRequests(): Promise<void> {
  const fetch = new FakeFetch();
  const isBadRequest = (error: unknown) =>
    error instanceof ArkerError &&
    error.code === "bad_request" &&
    error.status === 400 &&
    error.message.includes("use policies");

  await assert.rejects(
    () =>
      client(fetch).fork(
        "ubuntu",
        { network: { reachable: false } } as never,
      ),
    isBadRequest,
  );
  await assert.rejects(
    () => client(fetch).vm("vm_1").fork({ egress: "blocked" } as never),
    isBadRequest,
  );
  await assert.rejects(
    () =>
      client(fetch).vm("vm_1").run(
        "curl https://example.com",
        { network: { inbound: null } } as never,
      ),
    isBadRequest,
  );
  assert.equal(fetch.calls.length, 0);
}

async function testNestedErrorWithoutOkStillParses(): Promise<void> {
  const fetch = new FakeFetch();
  fetch.addJson(
    (method, url) => method === "DELETE" && url === "https://test.invalid/api/v1/vms/missing",
    503,
    {
      error: {
        code: "unavailable",
        message: "try later",
        timestamp: "2026-07-21T00:00:00Z",
      },
    },
  );

  await assert.rejects(
    client(fetch).vm("missing").delete(),
    (error) => error instanceof ArkerError && error.code === "unavailable" && error.status === 503,
  );
}

async function testCompletedRunDecodesOutput(): Promise<void> {
  const fetch = new FakeFetch();
  // Contract 0.3: per-VM runs go to `/runs` (plural). The legacy
  // `/run` (singular) endpoint is still wired on the backend as an
  // alias, but the SDK targets the new path.
  fetch.addJson(
    (method, url) => method === "POST" && url === "https://test.invalid/api/v1/vms/vm_1/runs",
    200,
    {
      stdout: "hello\n",
      stdout_encoding: "utf-8",
      stderr: "",
      stderr_encoding: "utf-8",
      exit_code: 0,
      memory_requested_mib: 1024,
      memory_achieved_mib: 1536,
      memory_partial: true,
    },
  );

  const result = await client(fetch).vm("vm_1").run("printf hello");

  assert.equal(result.type, "completed");
  const completed = result as CompletedRunResult;
  assert.equal(completed.exitCode, 0);
  assert.equal(completed.memoryRequestedMib, 1024);
  assert.equal(completed.memoryAchievedMib, 1536);
  assert.equal(completed.memoryPartial, true);
  assert.equal(decode(completed.stdout), "hello\n");
  assert.deepEqual(JSON.parse(fetch.calls[0]!.body!), { command: "printf hello" });
}

async function testSyncRunPollsBackgroundedRunToCompletion(): Promise<void> {
  // A synchronous run() that outlives the server sync window gets a background
  // ack; run() must poll getRun() under the hood and resolve to the terminal
  // run — the caller never sees the intermediate background shape.
  const fetch = new FakeFetch();
  fetch.addJson(
    (method, url) => method === "POST" && url === "https://test.invalid/api/v1/vms/vm_1/runs",
    200,
    { run_id: "run_bg", state: "running" },
  );
  // First poll: still running. Second poll: terminal.
  fetch.addJson(
    (method, url) => method === "GET" && url === "https://test.invalid/api/v1/vms/vm_1/runs/run_bg",
    200,
    { run_id: "run_bg", state: "running", started_at: "now", exit_code: null, stdout: "", stdout_encoding: "utf-8", stderr: "", stderr_encoding: "utf-8" },
  );
  fetch.addJson(
    (method, url) => method === "GET" && url === "https://test.invalid/api/v1/vms/vm_1/runs/run_bg",
    200,
    { run_id: "run_bg", state: "completed", started_at: "now", exit_code: 0, stdout: "done\n", stdout_encoding: "utf-8", stderr: "", stderr_encoding: "utf-8" },
  );

  const result = await client(fetch).vm("vm_1").run("sleep 999");

  assert.equal(result.type, "completed");
  const completed = result as CompletedRunResult;
  assert.equal(completed.runId, "run_bg");
  assert.equal(completed.state, "completed");
  assert.equal(completed.exitCode, 0);
  assert.equal(decode(completed.stdout), "done\n");
  // POST + 2 polls.
  assert.equal(fetch.calls.length, 3);
  assert.equal(fetch.calls[0]!.method, "POST");
  assert.equal(fetch.calls[1]!.method, "GET");
  assert.equal(fetch.calls[2]!.method, "GET");
}

async function testBackgroundTrueReturnsAckWithoutPolling(): Promise<void> {
  // background:true is a pure pass-through — run() returns the running ack
  // immediately and never polls getRun().
  const fetch = new FakeFetch();
  fetch.addJson(
    (method, url) => method === "POST" && url === "https://test.invalid/api/v1/vms/vm_1/runs",
    200,
    { run_id: "run_bg", state: "running" },
  );

  const result = await client(fetch).vm("vm_1").run("sleep 999", { background: true });

  assert.equal(result.type, "background");
  assert.equal((result as { runId: string }).runId, "run_bg");
  // Only the POST — no polling.
  assert.equal(fetch.calls.length, 1);
  assert.deepEqual(JSON.parse(fetch.calls[0]!.body!), { command: "sleep 999", background: true });
}

async function testRegionRoutesGoldensToMainEndpoint(): Promise<void> {
  const fetch = new FakeFetch();
  // Computer.fork() always posts to `/v1/fork` on the owning VM's
  // backend (default-provider compute URL for "ubuntu", a non-burst
  // name).
  fetch.addJson(
    (method, url) => method === "POST" && url === "https://aws-us-west-2.arker.ai/api/v1/fork",
    200,
    {
      vm_id: "vmh-child",
      owner_org_id: "owner",
      created_at: "now",
      public: false,
      state: "idle",
      sessions: [],
      tunnels: [],
    },
  );

  const arker = regionClient(fetch);
  const vm = await arker.vm("ubuntu").fork();

  assert.equal(arker.baseUrl, "https://aws-us-west-2.arker.ai/api");
  assert.equal(arker.burstBaseUrl, "https://aws-burst-us-west-2.arker.ai/api");
  assert.equal(vm.baseUrl, "https://aws-us-west-2.arker.ai/api");
}

async function testRegionRoutesArkuntuAliasToBurstEndpoint(): Promise<void> {
  const fetch = new FakeFetch();
  // The "arkuntu" alias is burst-pool; Computer("arkuntu") gets the
  // burst base URL and posts the fork there.
  fetch.addJson(
    (method, url) => method === "POST" && url === "https://aws-burst-us-west-2.arker.ai/api/v1/fork",
    200,
    {
      vm_id: "01KR4AN62T47VXQ0A3AVSSWFTZ_uswe",
      owner_org_id: "owner",
      created_at: "now",
      public: false,
      state: "idle",
      sessions: [],
      tunnels: [],
    },
  );

  const vm = await regionClient(fetch).vm("arkuntu").fork();

  assert.equal(vm.id, "01KR4AN62T47VXQ0A3AVSSWFTZ_uswe");
  assert.equal(vm.baseUrl, "https://aws-burst-us-west-2.arker.ai/api");
}

async function testRegionRoutesBurstVmIdsToBurstEndpoint(): Promise<void> {
  const fetch = new FakeFetch();
  fetch.addJson(
    (method, url) => method === "POST" && url === "https://aws-burst-us-west-2.arker.ai/api/v1/vms/01KR4AN62T47VXQ0A3AVSSWFTZ_uswe/runs",
    200,
    {
      stdout: "hello\n",
      stdout_encoding: "utf-8",
      stderr: "",
      stderr_encoding: "utf-8",
      exit_code: 0,
    },
  );

  await regionClient(fetch).vm("01KR4AN62T47VXQ0A3AVSSWFTZ_uswe").run("printf hello");

  assert.equal(fetch.calls[0]!.url, "https://aws-burst-us-west-2.arker.ai/api/v1/vms/01KR4AN62T47VXQ0A3AVSSWFTZ_uswe/runs");
}

async function testListRunsUsesControlPlaneAndFilters(): Promise<void> {
  const fetch = new FakeFetch();
  fetch.addJson(
    (method, url) => method === "GET" && url === "https://control.invalid/api/v1/runs?since=10&until=20&vm=vm_1&vms=vm_2%2Cvm_3&region=us-west-2&provider=aws&search=pytest&limit=25&offset=5&lite=true&runtime=fc&endpoint=run&actions=run%2Cfork&status=success%2Cinternal&status_min=200&status_max=599&sort=when&dir=asc",
    200,
    {
      since: 10,
      until: 20,
      limit: 25,
      offset: 5,
      lite: true,
      rows: [{
        source: "arkerd",
        t_ms: 10,
        request_id: "req_1",
        run_id: "run_1",
        vm_id: "vm_1",
        session_id: "session_1",
        region: "us-west-2",
        status: 200,
        total_ms: 12.5,
        queue_ms: 1.5,
        lambda_call_ms: 0,
        lambda_duration_ms: 0,
        executor_duration_ms: 10,
        executor_kind: "firecracker",
        executor_cpu_ms: 8,
        executor_mem_mb: 64,
        lambda_cpu_ms: 0,
        lambda_mem_mb: 0,
        vm_vcpus: 2,
        vm_memory_mib: 4096,
        path: "/v1/vms/vm_1/runs",
        method: "POST",
        command: "pytest",
        source_vm_id: "",
        exit_code: 0,
        endpoint: "run",
        api_key_prefix: "ark_live",
        body_bytes_in: 10,
        body_bytes_out: 20,
        body_in: "",
        body_out: "",
      }],
    },
  );

  const arker = new Arker({
    apiKey: "ark_live_test",
    baseUrl: "https://test.invalid/api/",
    controlBaseUrl: "https://control.invalid/api/",
    fetch: fetch.fetch,
    retry: false,
  });
  const result = await arker.listRuns({
    since: 10,
    until: 20,
    vm: "vm_1",
    vmIds: ["vm_2", "vm_3"],
    region: "us-west-2",
    provider: "aws",
    search: "pytest",
    limit: 25,
    offset: 5,
    lite: true,
    runtime: "fc",
    endpoint: "run",
    actions: ["run", "fork"],
    status: ["success", "internal"],
    statusMin: 200,
    statusMax: 599,
    sort: "when",
    dir: "asc",
  });

  assert.equal(result.rows.length, 1);
  assert.equal(result.rows[0]!.region, "us-west-2");
  assert.equal(result.rows[0]!.vm_vcpus, 2);
  assert.equal(result.lite, true);
  assert.equal(fetch.calls[0]!.method, "GET");
  assert.equal(fetch.calls[0]!.body, undefined);
}

async function testListVmsPreservesForkLimitFields(): Promise<void> {
  const fetch = new FakeFetch();
  fetch.addJson(
    (method, url) => method === "GET" && url === "https://arker.ai/api/v1/vms?region=us-west-2&provider=aws&org_id=ArkerHQ&public=true&state=idle",
    200,
    {
      vms: [{
        vm_id: "vm_1",
        owner_org_id: "ArkerHQ",
        created_at: "now",
        public: true,
        state: "idle",
        sessions: [],
        tunnels: [],
        network: { ssh_public_keys: [] },
        max_vcpus: 8,
        max_memory_mib: 32768,
        min_memory_mib: 512,
      }],
    },
  );

  const result = await client(fetch).listVms({
    region: "us-west-2",
    provider: "aws",
    org_id: "ArkerHQ",
    public: true,
    state: "idle",
  });

  assert.equal(result.vms[0]!.max_vcpus, 8);
  assert.equal(result.vms[0]!.max_memory_mib, 32768);
  assert.equal(result.vms[0]!.min_memory_mib, 512);
  assert.deepEqual(result.vms[0]!.network, { ssh_public_keys: [] });
}

async function testForkSendsDurableFlag(): Promise<void> {
  const fetch = new FakeFetch();
  fetch.addJson(
    (method, url) => method === "POST" && url === "https://test.invalid/api/v1/fork",
    200,
    {
      vm_id: "vm_durable",
      owner_org_id: "owner",
      created_at: "now",
      public: false,
      state: "idle",
      sessions: [],
      tunnels: [],
    },
  );

  await client(fetch).vm("ubuntu").fork({ durable: true });

  assert.deepEqual(
    JSON.parse(fetch.calls[0]!.body!),
    { durable: true, source_vm_id: "ubuntu", disk: true },
  );
}

async function testRunSendsIdempotencyKeyHeader(): Promise<void> {
  const fetch = new FakeFetch();
  fetch.addJson(
    (method, url) => method === "POST" && url === "https://test.invalid/api/v1/vms/vm_1/runs",
    200,
    {
      stdout: "hi\n",
      stdout_encoding: "utf-8",
      stderr: "",
      stderr_encoding: "utf-8",
      exit_code: 0,
    },
  );

  await client(fetch).vm("vm_1").run("printf hi", { idempotencyKey: "key-abc" });

  const call = fetch.calls[0]!;
  assert.equal(call.headers["idempotency-key"], "key-abc");
  assert.deepEqual(JSON.parse(call.body!), { command: "printf hi" });
}

async function testRunStatusReturnsRetryCount(): Promise<void> {
  const fetch = new FakeFetch();
  fetch.addJson(
    (method, url) => method === "GET" && url === "https://test.invalid/api/v1/vms/vm_1/runs/run_1",
    200,
    {
      run_id: "run_1",
      state: "completed",
      started_at: "now",
      stdout: "",
      stdout_encoding: "utf-8",
      stderr: "",
      stderr_encoding: "utf-8",
      exit_code: 0,
      tunnels: [],
      retry_count: 2,
    },
  );

  const status = await client(fetch).vm("vm_1").getRun("run_1");
  assert.equal(status.retry_count, 2);
}

async function testConnectPtyCreatesSessionAndUsesBearerHeader(): Promise<void> {
  const fetch = new FakeFetch();
  fetch.addJson(
    (method, url) => method === "POST" && url === "https://test.invalid/api/v1/vms/vm_1/sessions",
    200,
    {
      session_id: "sess_1",
      vm_id: "vm_1",
      state: "idle",
      cwd: "/home/user",
      env: {},
    },
  );
  const socket = new FakeWebSocket();
  let openedUrl = "";
  let openedHeaders: Record<string, string> | undefined;
  const factory: PtyWebSocketFactory = (url, init) => {
    openedUrl = url;
    openedHeaders = init.headers;
    return socket;
  };

  const pty = await client(fetch).vm("vm_1").connectPty({
    cols: 100,
    rows: 40,
    command: "/bin/sh",
    persist: false,
    useTicket: false,
    webSocketFactory: factory,
  });

  assert.equal(pty.sessionId, "sess_1");
  assert.equal(
    openedUrl,
    "wss://test.invalid/api/v1/vms/vm_1/sessions/sess_1/pty?cols=100&rows=40&command=%2Fbin%2Fsh&persist=false",
  );
  assert.equal(openedHeaders?.authorization, "Bearer ark_live_test");
  assert.deepEqual(JSON.parse(fetch.calls[0]!.body!), {});

  pty.resize(120, 33);
  pty.kill();
  pty.send("x");
  assert.equal(socket.sent[0], JSON.stringify({ type: "resize", cols: 120, rows: 33 }));
  assert.equal(socket.sent[1], JSON.stringify({ type: "kill" }));
  assert.deepEqual(socket.sent[2], new TextEncoder().encode("x"));
}

async function testConnectPtyUsesTicketForBrowserWebSocket(): Promise<void> {
  const fetch = new FakeFetch();
  fetch.addJson(
    (method, url) => method === "POST" && url === "https://test.invalid/api/v1/vms/vm_1/sessions/sess_1/pty-ticket",
    200,
    { ticket: "ptyt_ticket", expires_in: 300 },
  );
  let openedUrl = "";
  let openedHeaders: Record<string, string> | undefined = { unexpected: "set" };
  const factory: PtyWebSocketFactory = (url, init) => {
    openedUrl = url;
    openedHeaders = init.headers;
    return new FakeWebSocket();
  };

  await client(fetch).vm("vm_1").connectPty({
    sessionId: "sess_1",
    cols: 80,
    rows: 24,
    useTicket: true,
    webSocketFactory: factory,
  });

  assert.equal(
    openedUrl,
    "wss://test.invalid/api/v1/vms/vm_1/sessions/sess_1/pty?cols=80&rows=24&ticket=ptyt_ticket",
  );
  assert.equal(openedHeaders, undefined);
  assert.equal(fetch.calls[0]!.headers.authorization, "Bearer ark_live_test");
  assert.deepEqual(JSON.parse(fetch.calls[0]!.body!), {});
}

await testForkPostsDirectlyToSourceVm();
await testForkInfersArkerOrgForMacosFullGolden();
await testRemovedNetworkInputsFailBeforeRequests();
await testNestedErrorWithoutOkStillParses();
await testCompletedRunDecodesOutput();
await testSyncRunPollsBackgroundedRunToCompletion();
await testBackgroundTrueReturnsAckWithoutPolling();
await testRegionRoutesGoldensToMainEndpoint();
await testRegionRoutesArkuntuAliasToBurstEndpoint();
await testRegionRoutesBurstVmIdsToBurstEndpoint();
await testListRunsUsesControlPlaneAndFilters();
await testListVmsPreservesForkLimitFields();
await testForkSendsDurableFlag();
await testRunSendsIdempotencyKeyHeader();
await testRunStatusReturnsRetryCount();
async function testConnectPtyPassesCancelTtlSecs(): Promise<void> {
  // ARK-120: cancelTtlSecs must surface as the `cancel_ttl_secs` query param so
  // the server auto-cancels (destroys) the PTY run after that idle window.
  const fetch = new FakeFetch();
  fetch.addJson(
    (method, url) => method === "POST" && url === "https://test.invalid/api/v1/vms/vm_1/sessions",
    200,
    { session_id: "sess_1", vm_id: "vm_1", state: "idle", cwd: "/home/user", env: {} },
  );
  let openedUrl = "";
  const factory: PtyWebSocketFactory = (url) => {
    openedUrl = url;
    return new FakeWebSocket();
  };
  await client(fetch).vm("vm_1").connectPty({
    cols: 80,
    rows: 24,
    cancelTtlSecs: 600,
    useTicket: false,
    webSocketFactory: factory,
  });
  assert.ok(
    openedUrl.includes("cancel_ttl_secs=600"),
    `expected cancel_ttl_secs=600 in PTY url, got: ${openedUrl}`,
  );
  // A zero/negative ttl must be omitted (no auto-cancel), not sent as 0.
  let openedUrl2 = "";
  const factory2: PtyWebSocketFactory = (url) => {
    openedUrl2 = url;
    return new FakeWebSocket();
  };
  await client(fetch).vm("vm_1").connectPty({
    sessionId: "sess_1",
    cancelTtlSecs: 0,
    useTicket: false,
    webSocketFactory: factory2,
  });
  assert.ok(
    !openedUrl2.includes("cancel_ttl_secs"),
    `cancel_ttl_secs must be omitted when <= 0, got: ${openedUrl2}`,
  );
}

async function testConnectPtyDeliversDataAndCloseEvents(): Promise<void> {
  // The PtyConnection must surface server→client bytes via onData and the
  // socket close (code/reason) via onClose.
  const fetch = new FakeFetch();
  fetch.addJson(
    (method, url) => method === "POST" && url === "https://test.invalid/api/v1/vms/vm_1/sessions",
    200,
    { session_id: "sess_1", vm_id: "vm_1", state: "idle", cwd: "/home/user", env: {} },
  );
  const socket = new FakeWebSocket();
  const pty = await client(fetch).vm("vm_1").connectPty({
    useTicket: false,
    webSocketFactory: () => socket,
  });
  const received: string[] = [];
  let closed: { code?: number; reason?: string } | undefined;
  pty.onData((bytes) => received.push(new TextDecoder().decode(bytes)));
  pty.onClose((event) => { closed = event; });
  // server emits two output chunks (string + ArrayBuffer), then closes
  socket.emit("message", { data: "hello " });
  socket.emit("message", { data: new TextEncoder().encode("world").buffer });
  assert.equal(received.join(""), "hello world");
  socket.emit("close", { code: 1000, reason: "bye" });
  assert.deepEqual(closed, { code: 1000, reason: "bye" });
}

function testSurfaceStubClassificationUsesStructuredErrorCodes(): void {
  assert.equal(isExpectedSurfaceStub("not_found", "no live sync sync_does_not_exist"), true);
  assert.equal(isExpectedSurfaceStub("not_implemented", "operation unavailable"), true);
  assert.equal(isExpectedSurfaceStub("unsupported_operation", "optional feature disabled"), true);
  assert.equal(isExpectedSurfaceStub("", "request failed with HTTP 404"), true);
  assert.equal(isExpectedSurfaceStub("internal", "request failed"), false);
}

await testConnectPtyCreatesSessionAndUsesBearerHeader();
await testConnectPtyUsesTicketForBrowserWebSocket();
await testConnectPtyPassesCancelTtlSecs();
await testConnectPtyDeliversDataAndCloseEvents();
testSurfaceStubClassificationUsesStructuredErrorCodes();

console.log("PASS unit");
