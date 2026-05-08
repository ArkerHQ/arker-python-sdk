import assert from "node:assert/strict";

import { Arker, ArkerError, type CompletedRunResult } from "../src/index.js";

type FetchCall = {
  url: string;
  method: string;
  body?: string;
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
    this.calls.push({ url, method, body });

    const index = this.script.findIndex((entry) => entry.predicate(method, url));
    assert.notEqual(index, -1, `no scripted response for ${method} ${url}`);
    return this.script.splice(index, 1)[0]!.response;
  };
}

function client(fetch: FakeFetch): Arker {
  return new Arker({
    apiKey: "ark_live_test",
    baseUrl: "https://test.invalid/api/",
    fetch: fetch.fetch,
    retry: false,
  });
}

function decode(bytes: Uint8Array): string {
  return new TextDecoder().decode(bytes);
}

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

await testForkPostsDirectlyToSourceVm();
await testForkAcceptsLegacyIdResponse();
await testNestedErrorWithoutOkStillParses();
await testCompletedRunDecodesOutput();

console.log("PASS unit");
