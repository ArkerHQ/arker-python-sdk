import assert from "node:assert/strict";

import { Arker, ArkerError, type CompletedRunResult } from "../src/index.js";
import { FakeFetch, client, regionClient, decode } from "./_fake-fetch.js";

async function testForkPostsDirectlyToSourceVm(): Promise<void> {
  const fetch = new FakeFetch();
  fetch.addJson(
    (method, url) => method === "POST" && url === "https://test.invalid/api/v1/vms/ubuntu/fork",
    200,
    { vm_id: "vm_child", owner_id: "owner", created_at: "now", sessions: [] },
  );

  const vm = await client(fetch).vm("ubuntu").fork({ name: "demo" });

  assert.equal(vm.id, "vm_child");
  assert.deepEqual(JSON.parse(fetch.calls[0]!.body!), { name: "demo" });
}

async function testForkAcceptsLegacyIdResponse(): Promise<void> {
  const fetch = new FakeFetch();
  fetch.addJson(
    (method, url) => method === "POST" && url === "https://test.invalid/api/v1/vms/ubuntu/fork",
    200,
    { id: "vm_child" },
  );

  const vm = await client(fetch).vm("ubuntu").fork();

  assert.equal(vm.id, "vm_child");
}

async function testNestedErrorWithoutOkStillParses(): Promise<void> {
  const fetch = new FakeFetch();
  fetch.addJson(
    (method, url) => method === "DELETE" && url === "https://test.invalid/api/v1/vms/missing",
    503,
    { error: { code: "routing_unavailable", message: "try later" } },
  );

  await assert.rejects(
    client(fetch).vm("missing").delete(),
    (error) => error instanceof ArkerError && error.code === "routing_unavailable" && error.status === 503,
  );
}

async function testCompletedRunDecodesOutput(): Promise<void> {
  const fetch = new FakeFetch();
  fetch.addJson(
    (method, url) => method === "POST" && url === "https://test.invalid/api/v1/vms/vm_1/run",
    200,
    {
      stdout: "hello\n",
      stdout_encoding: "utf-8",
      stderr: "",
      stderr_encoding: "utf-8",
      exit_code: 0,
      completed: true,
    },
  );

  const result = await client(fetch).vm("vm_1").run("printf hello");

  assert.equal(result.type, "completed");
  const completed = result as CompletedRunResult;
  assert.equal(completed.exitCode, 0);
  assert.equal(decode(completed.stdout), "hello\n");
  assert.deepEqual(JSON.parse(fetch.calls[0]!.body!), { command: "printf hello" });
}

async function testRegionRoutesGoldensToMainEndpoint(): Promise<void> {
  const fetch = new FakeFetch();
  fetch.addJson(
    (method, url) => method === "POST" && url === "https://aws-us-west-2.arker.ai/api/v1/vms/ubuntu/fork",
    200,
    { vm_id: "vmh-child", owner_id: "owner", created_at: "now", sessions: [] },
  );

  const arker = regionClient(fetch);
  const vm = await arker.vm("ubuntu").fork();

  assert.equal(arker.baseUrl, "https://aws-us-west-2.arker.ai/api");
  assert.equal(arker.burstBaseUrl, "https://aws-burst-us-west-2.arker.ai/api");
  assert.equal(vm.baseUrl, "https://aws-us-west-2.arker.ai/api");
}

async function testRegionRoutesArkuntuAliasToBurstEndpoint(): Promise<void> {
  const fetch = new FakeFetch();
  fetch.addJson(
    (method, url) => method === "POST" && url === "https://aws-burst-us-west-2.arker.ai/api/v1/vms/arkuntu/fork",
    200,
    { id: "legacy_child_without_suffix" },
  );

  const vm = await regionClient(fetch).vm("arkuntu").fork();

  assert.equal(vm.id, "legacy_child_without_suffix");
  assert.equal(vm.baseUrl, "https://aws-burst-us-west-2.arker.ai/api");
}

async function testRegionRoutesBurstVmIdsToBurstEndpoint(): Promise<void> {
  const fetch = new FakeFetch();
  fetch.addJson(
    (method, url) => method === "POST" && url === "https://aws-burst-us-west-2.arker.ai/api/v1/vms/01KR4AN62T47VXQ0A3AVSSWFTZ_uswe/run",
    200,
    {
      stdout: "hello\n",
      stdout_encoding: "utf-8",
      stderr: "",
      stderr_encoding: "utf-8",
      exit_code: 0,
      completed: true,
    },
  );

  await regionClient(fetch).vm("01KR4AN62T47VXQ0A3AVSSWFTZ_uswe").run("printf hello");

  assert.equal(fetch.calls[0]!.url, "https://aws-burst-us-west-2.arker.ai/api/v1/vms/01KR4AN62T47VXQ0A3AVSSWFTZ_uswe/run");
}

async function testForkSendsDurableFlag(): Promise<void> {
  const fetch = new FakeFetch();
  fetch.addJson(
    (method, url) => method === "POST" && url === "https://test.invalid/api/v1/vms/ubuntu/fork",
    200,
    { vm_id: "vm_durable", owner_id: "owner", created_at: "now", sessions: [] },
  );

  await client(fetch).vm("ubuntu").fork({ durable: true });

  assert.deepEqual(JSON.parse(fetch.calls[0]!.body!), { durable: true });
}

async function testRunSendsIdempotencyKeyHeader(): Promise<void> {
  const fetch = new FakeFetch();
  fetch.addJson(
    (method, url) => method === "POST" && url === "https://test.invalid/api/v1/vms/vm_1/run",
    200,
    {
      stdout: "hi\n",
      stdout_encoding: "utf-8",
      stderr: "",
      stderr_encoding: "utf-8",
      exit_code: 0,
      completed: true,
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
      stdout: "",
      stdout_encoding: "utf-8",
      stderr: "",
      stderr_encoding: "utf-8",
      exit_code: 0,
      completed: true,
      tunnels: [],
      retry_count: 2,
    },
  );

  const status = await client(fetch).vm("vm_1").runStatus("run_1");
  assert.equal(status.retry_count, 2);
}

await testForkPostsDirectlyToSourceVm();
await testForkAcceptsLegacyIdResponse();
await testNestedErrorWithoutOkStillParses();
await testCompletedRunDecodesOutput();
await testRegionRoutesGoldensToMainEndpoint();
await testRegionRoutesArkuntuAliasToBurstEndpoint();
await testRegionRoutesBurstVmIdsToBurstEndpoint();
await testForkSendsDurableFlag();
await testRunSendsIdempotencyKeyHeader();
await testRunStatusReturnsRetryCount();

console.log("PASS unit");
