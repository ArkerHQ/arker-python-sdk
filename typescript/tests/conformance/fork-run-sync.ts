/**
 * Core API contract smoke test.
 *
 * One happy-path scenario per target:
 *   fork source -> run hello -> sync hello
 *
 * This uses raw HTTP instead of the SDK so it can catch backend contract drift.
 * If an endpoint mounts the API under `/api`, include that prefix in baseUrl.
 *
 * Run one target:
 *   ARKER_API_KEY=ark_live_... \
 *   ARKER_BASE_URL=https://aws-us-west-2.arker.ai \
 *   ARKER_SOURCE_VM=ubuntu \
 *   bun run smoke
 *
 * Run multiple targets:
 *   ARKER_API_KEY=ark_live_... \
 *   ARKER_SMOKE_TARGETS='[
 *     {"name":"burst","baseUrl":"https://aws-burst-us-west-2.arker.ai/api","sourceVmId":"01KQH2ADR3DCAJF06N4R453WPJ_uswe"},
 *     {"name":"ubuntu","baseUrl":"https://aws-us-west-2.arker.ai/api","sourceVmName":"ubuntu"}
 *   ]' \
 *   bun run smoke
 */

export {};

interface SmokeTarget {
  name?: string;
  apiKey?: string;
  baseUrl: string;
  sourceVmId?: string;
  sourceVmName?: string;
  runtime?: string;
}

type JsonObject = Record<string, unknown>;
type HttpMethod = "POST" | "DELETE";

interface Client {
  apiKey: string;
  baseUrl: string;
}

const RETRY_ATTEMPTS = 3;
const RETRYABLE_STATUS = new Set([429, 502, 503, 504]);
const RETRYABLE_CODES = new Set(["routing_unavailable", "unavailable", "temporarily_unavailable"]);

function targets(): SmokeTarget[] {
  const raw = process.env.ARKER_SMOKE_TARGETS;
  if (raw?.trim()) {
    const parsed = JSON.parse(raw) as SmokeTarget[];
    assert(Array.isArray(parsed) && parsed.length > 0, "ARKER_SMOKE_TARGETS must be a non-empty array");
    return parsed;
  }

  return [{
    name: "default",
    baseUrl: requiredEnv("ARKER_BASE_URL"),
    sourceVmName: process.env.ARKER_SOURCE_VM ?? "ubuntu",
    runtime: process.env.ARKER_RUNTIME,
  }];
}

function requiredEnv(name: string): string {
  const value = process.env[name];
  if (!value?.trim()) throw new Error(`${name} is required`);
  return value.trim();
}

function quote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function pathSegment(value: string): string {
  return encodeURIComponent(value);
}

function apiPath(vmId: string, operation: "run" | "sync"): string {
  const suffix = operation === "run" ? "runs" : "sync";
  return `/v1/vms/${pathSegment(vmId)}/${suffix}`;
}

function jsonObject(value: unknown, context: string): JsonObject {
  assert(value !== null && typeof value === "object" && !Array.isArray(value), `${context} must be an object`);
  return value as JsonObject;
}

function assertKeys(body: JsonObject, required: string[], allowed: string[], context: string): void {
  const actual = Object.keys(body).sort();
  const allowedSet = new Set(allowed);
  const missing = required.filter((key) => !(key in body));
  const unknown = actual.filter((key) => !allowedSet.has(key));

  assert(missing.length === 0, `${context} missing required keys: ${missing.join(", ")}`);
  assert(unknown.length === 0, `${context} has unknown keys: ${unknown.join(", ")}`);
}

function assertExactKeys(body: JsonObject, keys: string[], context: string): void {
  assertKeys(body, keys, keys, context);
  assert(Object.keys(body).length === keys.length, `${context} must contain exactly [${keys.join(", ")}]`);
}

function stringField(value: unknown, context: string): string {
  assert(typeof value === "string" && value.length > 0, `${context} must be a non-empty string`);
  return value;
}

function optionalObject(value: unknown, context: string): void {
  assert(
    value === undefined || value === null || (typeof value === "object" && !Array.isArray(value)),
    `${context} must be an object when present`,
  );
}

function numberField(value: unknown, context: string): number {
  assert(typeof value === "number", `${context} must be a number`);
  return value;
}

function arrayField(value: unknown, context: string): unknown[] {
  assert(Array.isArray(value), `${context} must be an array`);
  return value;
}

function parseJson(text: string): unknown {
  try {
    return text ? JSON.parse(text) : {};
  } catch {
    return undefined;
  }
}

function errorCode(payload: unknown): string | undefined {
  const body = payload && typeof payload === "object" ? payload as JsonObject : undefined;
  if (typeof body?.code === "string") return body.code;

  const nested = body?.error && typeof body.error === "object" ? body.error as JsonObject : undefined;
  return typeof nested?.code === "string" ? nested.code : undefined;
}

function formatPayload(payload: unknown, text: string): string {
  return payload === undefined ? text.slice(0, 300) : JSON.stringify(payload).slice(0, 300);
}

function isRetryable(status: number, payload: unknown): boolean {
  return RETRYABLE_STATUS.has(status) || RETRYABLE_CODES.has(errorCode(payload) ?? "");
}

async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

async function requestJson(client: Client, method: HttpMethod, path: string, body?: unknown): Promise<unknown> {
  const url = client.baseUrl.replace(/\/+$/, "") + path;

  for (let attempt = 0; attempt < RETRY_ATTEMPTS; attempt++) {
    const headers: Record<string, string> = { authorization: `Bearer ${client.apiKey}` };
    const init: RequestInit = { method, headers };
    if (body !== undefined) {
      headers["content-type"] = "application/json";
      init.body = JSON.stringify(body);
    }

    const response = await fetch(url, init);

    const text = await response.text();
    const payload = parseJson(text);

    if (response.ok) return payload;
    if (isRetryable(response.status, payload) && attempt < RETRY_ATTEMPTS - 1) {
      await sleep(500 * 2 ** attempt);
      continue;
    }

    throw new Error(`${method} ${path} HTTP ${response.status}: ${formatPayload(payload, text)}`);
  }

  throw new Error(`${method} ${path} failed`);
}

function encodeBase64(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("base64");
}

function decodeContent(content: string, encoding: string): string {
  if (encoding === "base64") return Buffer.from(content, "base64").toString("utf8");
  return content;
}

function canonicalForkRequest(target: SmokeTarget): JsonObject {
  const hasId = Boolean(target.sourceVmId);
  const hasName = Boolean(target.sourceVmName);
  assert(hasId !== hasName, "set exactly one of sourceVmId or sourceVmName");
  return hasId
    ? { source_vm_id: target.sourceVmId }
    : { source_vm_name: target.sourceVmName };
}

function canonicalRunRequest(command: string, runtime?: string): JsonObject {
  return runtime ? { command, runtime } : { command };
}

function canonicalWriteRequest(path: string, bytes: Uint8Array): JsonObject {
  return {
    op: "write",
    writes: [{
      path,
      size: bytes.length,
      upload_id: `smoke-${Date.now()}`,
      content: encodeBase64(bytes),
      start: 0,
      end: bytes.length,
    }],
  };
}

function canonicalReadRequest(path: string): JsonObject {
  return { op: "read", path };
}

function assertForkResponse(body: JsonObject): string {
  const required = [
    "vm_id",
    "owner_org_id",
    "created_at",
    "public",
    "state",
    "sessions",
  ];
  for (const key of required) {
    assert(body[key] !== undefined, `fork response.${key} missing`);
  }
  stringField(body.owner_org_id, "fork response.owner_org_id");
  const vmId = stringField(body.vm_id, "fork response.vm_id");
  stringField(body.created_at, "fork response.created_at");
  assert(typeof body.public === "boolean", "fork response.public must be a boolean");
  assert(body.state === "idle" || body.state === "running", "fork response.state must be idle or running");
  arrayField(body.sessions, "fork response.sessions");
  optionalObject(body.network, "fork response.network");
  for (const alias of [
    "owner_id",
    "ssh_private_key",
    "vcpu_count",
    "memory_mib",
    "disk_mib",
    "base_image",
    "source_golden",
    "egress",
  ]) {
    assert(body[alias] === undefined, `fork response must not contain ${alias}`);
  }
  return vmId;
}

function assertCompletedRunResponse(body: JsonObject, expectedStdout: string): void {
  const minimal = ["stdout", "stdout_encoding", "stderr", "stderr_encoding", "exit_code"];
  for (const key of minimal) {
    assert(body[key] !== undefined, `run response.${key} missing`);
  }
  assert(body.completed === undefined, "run response must not contain completed");
  assert(stringField(body.stdout, "run response.stdout") === expectedStdout, `unexpected stdout: ${JSON.stringify(body.stdout)}`);
  stringField(body.stdout_encoding, "run response.stdout_encoding");
  assert(typeof body.stderr === "string", "run response.stderr must be a string");
  stringField(body.stderr_encoding, "run response.stderr_encoding");
  assert(numberField(body.exit_code, "run response.exit_code") === 0, `run exited ${body.exit_code}`);
}

function assertSyncWriteResponse(body: JsonObject, path: string, size: number): void {
  assertExactKeys(body, ["ok", "op", "results"], "sync write response");
  assert(body.ok === true, "sync write response.ok must be true");
  assert(body.op === "write", "sync write response.op must be write");

  const results = arrayField(body.results, "sync write response.results");
  assert(results.length === 1, "sync write response.results must contain one result");
  const result = jsonObject(results[0], "sync write response.results[0]");
  assertKeys(
    result,
    ["path", "size", "received_bytes", "ranges", "complete", "written"],
    ["path", "size", "received_bytes", "ranges", "complete", "written", "error"],
    "sync write response.results[0]",
  );
  assert(result.path === path, "sync write result.path must match request path");
  assert(numberField(result.size, "sync write result.size") === size, "sync write result.size must match request size");
  numberField(result.received_bytes, "sync write result.received_bytes");
  arrayField(result.ranges, "sync write result.ranges");
  assert(result.complete === true, `sync write result.complete must be true: ${JSON.stringify(result)}`);
  assert(result.written === true, `sync write result.written must be true: ${JSON.stringify(result)}`);
  assert(result.error === undefined || result.error === null, "sync write result.error must be absent or null on success");
}

function assertSyncReadResponse(body: JsonObject, path: string, expectedContents: string): void {
  if ("content" in body) {
    assertExactKeys(body, ["ok", "op", "path", "size", "content", "encoding"], "sync inline read response");
    assert(body.ok === true, "sync read response.ok must be true");
    assert(body.op === "read", "sync read response.op must be read");
    assert(body.path === path, "sync read response.path must match request path");
    numberField(body.size, "sync read response.size");
    const content = stringField(body.content, "sync read response.content");
    const encoding = stringField(body.encoding, "sync read response.encoding");
    assert(["utf8", "base64"].includes(encoding), "sync read response.encoding must be utf8 or base64");
    const contents = decodeContent(content, encoding);
    assert(contents === expectedContents, `unexpected sync contents: ${JSON.stringify(contents)}`);
    return;
  }

  assertExactKeys(body, ["ok", "op", "path", "size", "presigned_url", "expires_in", "method"], "sync presigned read response");
  assert(body.ok === true, "sync read response.ok must be true");
  assert(body.op === "read", "sync read response.op must be read");
  assert(body.path === path, "sync read response.path must match request path");
  numberField(body.size, "sync read response.size");
  stringField(body.presigned_url, "sync read response.presigned_url");
  numberField(body.expires_in, "sync read response.expires_in");
  stringField(body.method, "sync read response.method");
}

async function smoke(target: SmokeTarget): Promise<void> {
  const label = target.name ?? target.baseUrl;
  const client = {
    apiKey: target.apiKey ?? requiredEnv("ARKER_API_KEY"),
    baseUrl: target.baseUrl,
  };
  const hello = `hello-from-arker-sdk-${Date.now()}`;
  let vmId: string | undefined;

  try {
    const fork = jsonObject(
      await requestJson(client, "POST", "/v1/fork", canonicalForkRequest(target)),
      "fork response",
    );
    vmId = assertForkResponse(fork);

    const run = jsonObject(
      await requestJson(client, "POST", apiPath(vmId, "run"), canonicalRunRequest(`printf ${quote(`${hello}\n`)}`, target.runtime)),
      "run response",
    );
    assertCompletedRunResponse(run, `${hello}\n`);

    const path = `/home/user/${hello}.txt`;
    const bytes = new TextEncoder().encode(`${hello}\n`);

    const write = jsonObject(
      await requestJson(client, "POST", apiPath(vmId, "sync"), canonicalWriteRequest(path, bytes)),
      "sync write response",
    );
    assertSyncWriteResponse(write, path, bytes.length);

    const read = jsonObject(
      await requestJson(client, "POST", apiPath(vmId, "sync"), canonicalReadRequest(path)),
      "sync read response",
    );
    assertSyncReadResponse(read, path, `${hello}\n`);

    console.log(`PASS ${label}`);
  } finally {
    if (vmId) {
      try {
        await requestJson(client, "DELETE", `/v1/vms/${pathSegment(vmId)}`);
      } catch (error) {
        console.warn(`WARN ${label}: failed to delete ${vmId}: ${errorMessage(error)}`);
      }
    }
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

let failed = false;
for (const target of targets()) {
  try {
    await smoke(target);
  } catch (error) {
    failed = true;
    console.error(`FAIL ${target.name ?? target.baseUrl}: ${errorMessage(error)}`);
  }
}

if (failed) process.exit(1);
