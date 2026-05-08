/**
 * Arker TypeScript SDK.
 *
 * A small wrapper around the VM API. Configure a region for the standard
 * Arker endpoints, or pass baseUrl directly for internal/dev targets.
 */

import type { components } from "./generated/api-types.js";

type ApiSchema<Name extends keyof components["schemas"]> = components["schemas"][Name];

export const CHUNK_SIZE = 4 * 1024 * 1024;

const DEFAULT_RETRY_ATTEMPTS = 4;
const DEFAULT_RETRY_BASE_DELAY_MS = 200;
const DEFAULT_RETRY_MAX_DELAY_MS = 2_000;
const DEFAULT_RETRY_JITTER_MS = 50;
const PRESIGNED_PUT_TIMEOUT_MS = 600_000;
const RETRYABLE_HTTP = new Set([429, 502, 503, 504]);
const RETRYABLE_CODES = new Set(["routing_unavailable", "unavailable", "temporarily_unavailable"]);
const TRANSIENT_HINTS = ["503", "Service Unavailable", "throttle", "SlowDown", "ThrottlingException"];
const ULID_ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
const DEFAULT_REGION_ENV = "ARKER_REGION";
const BURST_SOURCE_REFS = new Set(["arkuntu"]);
const BURST_VM_ID = /^[0-9A-HJKMNP-TV-Z]{26}_[A-Za-z0-9]+$/;

type FetchLike = typeof fetch;
type HttpMethod = "GET" | "POST" | "DELETE";
type JsonObject = Record<string, unknown>;

interface BufferValue extends Uint8Array {
  toString(encoding?: string): string;
}

interface BufferConstructorLike {
  from(input: Uint8Array | ArrayBuffer | string, encoding?: string): BufferValue;
}

export interface RetryOptions {
  attempts?: number;
  baseDelayMs?: number;
  maxDelayMs?: number;
  jitterMs?: number;
}

export interface ArkerOptions {
  apiKey?: string;
  baseUrl?: string;
  burstBaseUrl?: string;
  fetch?: FetchLike;
  region?: string;
  retry?: RetryOptions | false;
}

export type NetworkPolicy = ApiSchema<"NetworkPolicy">;
export type NetworkPolicyInput = ApiSchema<"NetworkPolicyInput">;
export type ForkRequest = ApiSchema<"ForkRequest">;
export type ForkOptions = ForkRequest;
export type SessionInfo = ApiSchema<"SessionInfo">;
export type GoldenInfo = ApiSchema<"GoldenInfo">;
export type ListGoldensResponse = ApiSchema<"ListGoldensResponse">;
export type VmInfo = ApiSchema<"VmInfo">;
export type ListVmsResponse = ApiSchema<"ListVmsResponse">;
export type ListSessionsResponse = ApiSchema<"ListSessionsResponse">;
export type VmSummary = VmInfo;
export type VmList = ListVmsResponse;
export type ForkVmResponse = ApiSchema<"ForkVmResponse">;
export type DeleteVmResponse = ApiSchema<"DeleteVmResponse">;
export type DeleteSessionResponse = ApiSchema<"DeleteSessionResponse">;
export type MountRequest = ApiSchema<"MountRequest">;
export type RunRequest = ApiSchema<"RunRequest">;
export type RunOptions = Omit<RunRequest, "command">;
export type RunInboundPortRequest = ApiSchema<"RunInboundPortRequest">;
export type RunNetworkRequest = ApiSchema<"RunNetworkRequest">;
export type RunTunnelStatus = ApiSchema<"RunTunnelStatus">;
export type RunNetworkStatus = ApiSchema<"RunNetworkStatus">;
export type RunResponse = ApiSchema<"RunResponse">;
export type CompletedRunResponse = ApiSchema<"CompletedRunResponse">;
export type BackgroundRunResponse = ApiSchema<"BackgroundRunResponse">;
export type PtyRunResponse = ApiSchema<"PtyRunResponse">;
export type RawRunResponse = RunResponse;

export interface CompletedRunResult {
  type: "completed";
  completed: true;
  stdout: Uint8Array;
  stdoutEncoding: string;
  stderr: Uint8Array;
  stderrEncoding: string;
  exitCode: number;
}

export interface BackgroundRunResult {
  type: "background";
  completed: boolean;
  runId: string;
  tunnels: RunTunnelStatus[];
  network?: RunNetworkStatus | null;
}

export interface PtyRunResult {
  type: "pty";
  pty: true;
  sessionId: string;
  wsUrl: string;
}

export type RunResult = CompletedRunResult | BackgroundRunResult | PtyRunResult;

export type RunStatusResponse = ApiSchema<"RunStatusResponse">;
export type CancelRunResponse = ApiSchema<"CancelRunResponse">;
export type CreateSessionRequest = ApiSchema<"CreateSessionRequest">;
export type ResizePtyRequest = ApiSchema<"ResizePtyRequest">;
export type ResizePtyResponse = ApiSchema<"ResizePtyResponse">;
export type ResizeRequest = ApiSchema<"ResizeRequest">;
export type ResizeResponse = ApiSchema<"ResizeResponse">;
export type SyncRequest = ApiSchema<"SyncRequest">;
export type SyncResponse = ApiSchema<"SyncResponse">;
export type SyncReadResponse = ApiSchema<"SyncReadResponse">;
export type SyncReadInlineResponse = ApiSchema<"SyncReadInlineResponse">;
export type SyncReadPresignedResponse = ApiSchema<"SyncReadPresignedResponse">;
export type SyncByteRange = ApiSchema<"SyncByteRange">;
export type ErrorResponse = ApiSchema<"ErrorResponse">;
export type SyncChunkWriteResult = ApiSchema<"SyncChunkWriteResult">;
export type SyncPresignedWriteRequestResult = ApiSchema<"SyncPresignedWriteRequestResult">;
export type SyncCommitWriteResult = ApiSchema<"SyncCommitWriteResult">;
export type SyncWriteResult = ApiSchema<"SyncWriteResult">;
export type SyncWriteResponse = ApiSchema<"SyncWriteResponse">;

interface RetryConfig {
  attempts: number;
  baseDelayMs: number;
  maxDelayMs: number;
  jitterMs: number;
}

interface ParsedError {
  code: string;
  message: string;
}

export class ArkerError extends Error {
  readonly code: string;
  readonly status: number;

  constructor(code: string, message: string, status: number) {
    super(`${code}: ${message}`);
    this.name = "ArkerError";
    this.code = code;
    this.status = status;
  }
}

export class Arker {
  readonly baseUrl: string;
  readonly burstBaseUrl?: string;
  readonly region?: string;
  private readonly apiKey: string;
  private readonly fetchImpl: FetchLike;
  private readonly retry: RetryConfig;

  constructor(opts: ArkerOptions = {}) {
    const apiKey = opts.apiKey ?? env("ARKER_API_KEY") ?? env("AUTH_KEY");
    const explicitBaseUrl = opts.baseUrl ?? env("ARKER_BASE_URL");
    const region = opts.region ?? (explicitBaseUrl ? undefined : env(DEFAULT_REGION_ENV));
    const baseUrl = explicitBaseUrl ?? (region ? regionBaseUrl(region, false) : undefined);
    const burstBaseUrl = opts.burstBaseUrl ?? env("ARKER_BURST_BASE_URL") ?? (region ? regionBaseUrl(region, true) : undefined);

    if (!apiKey) throw new Error("apiKey is required; pass apiKey or set ARKER_API_KEY");
    if (!baseUrl) throw new Error("region or baseUrl is required; pass region, baseUrl, ARKER_REGION, or ARKER_BASE_URL");

    this.apiKey = apiKey;
    this.baseUrl = normalizeBaseUrl(baseUrl);
    this.burstBaseUrl = burstBaseUrl ? normalizeBaseUrl(burstBaseUrl) : undefined;
    this.region = region ? normalizeRegion(region) : undefined;
    this.fetchImpl = opts.fetch ?? globalThis.fetch;
    this.retry = normalizeRetry(opts.retry);

    if (!this.fetchImpl) throw new Error("fetch is required in this runtime");
  }

  vm(vmId: string): Computer {
    return new Computer(this, vmId, this._baseUrlFor(vmId));
  }

  async goldens(): Promise<ListGoldensResponse> {
    return this._request("GET", "/v1/goldens");
  }

  async list(): Promise<ListVmsResponse> {
    return this._request("GET", "/v1/vms");
  }

  async get(vmId: string): Promise<VmInfo> {
    return this._request("GET", vmPath(vmId), undefined, this._baseUrlFor(vmId));
  }

  /** @internal */
  async _request<T>(method: HttpMethod, path: string, body?: unknown, baseUrl = this.baseUrl): Promise<T> {
    const url = `${baseUrl}${path}`;
    const headers: Record<string, string> = {
      authorization: `Bearer ${this.apiKey}`,
    };
    const init: RequestInit = { method, headers };

    if (body !== undefined) {
      headers["content-type"] = "application/json";
      init.body = JSON.stringify(withoutUndefined(body));
    }

    let lastStatus = 0;
    let lastText = "";
    let lastError: ParsedError | undefined;

    for (let attempt = 0; attempt < this.retry.attempts; attempt++) {
      try {
        const response = await this.fetchImpl(url, init);
        const text = await response.text();
        const payload = parseJson(text);
        const parsedError = extractError(payload);

        lastStatus = response.status;
        lastText = text;
        lastError = parsedError;

        if (isRetryable(response.status, parsedError) && attempt < this.retry.attempts - 1) {
          await sleep(retryDelay(this.retry, attempt));
          continue;
        }

        if (parsedError) throw new ArkerError(parsedError.code, parsedError.message, response.status);
        if (!response.ok) {
          throw new ArkerError("internal", lastText.slice(0, 300) || `HTTP ${response.status}`, response.status);
        }

        return payload as T;
      } catch (error) {
        if (error instanceof ArkerError) throw error;
        if (attempt < this.retry.attempts - 1) {
          await sleep(retryDelay(this.retry, attempt));
          continue;
        }
        const message = error instanceof Error ? error.message : String(error);
        throw new ArkerError("network_error", message, 0);
      }
    }

    if (lastError) throw new ArkerError(lastError.code, lastError.message, lastStatus);
    throw new ArkerError("internal", lastText.slice(0, 300) || `HTTP ${lastStatus}`, lastStatus);
  }

  /** @internal */
  async _fetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
    return this.fetchImpl(input, init);
  }

  /** @internal */
  _retryAttempts(): number {
    return this.retry.attempts;
  }

  /** @internal */
  _retryDelay(attempt: number): number {
    return retryDelay(this.retry, attempt);
  }

  /** @internal */
  _baseUrlFor(ref: string): string {
    if (isBurstRef(ref) && this.burstBaseUrl) return this.burstBaseUrl;
    return this.baseUrl;
  }
}

export class Computer {
  readonly id: string;
  readonly baseUrl: string;
  readonly sync: Sync;
  /** @internal */
  readonly _client: Arker;

  constructor(client: Arker, vmId: string, baseUrl = client._baseUrlFor(vmId)) {
    this._client = client;
    this.id = vmId;
    this.baseUrl = baseUrl;
    this.sync = new Sync(this);
  }

  async fork(request: ForkOptions = {}): Promise<Computer> {
    const response = await this._client._request<ForkVmResponse & { id?: string }>(
      "POST",
      `${vmPath(this.id)}/fork`,
      request,
      this.baseUrl,
    );
    return new Computer(this._client, stringField(response.vm_id ?? response.id, "fork response.vm_id"), this.baseUrl);
  }

  async run(command: string, options: RunOptions = {}): Promise<RunResult> {
    const response = await this._client._request<unknown>("POST", `${vmPath(this.id)}/run`, {
      ...options,
      command,
    }, this.baseUrl);
    return parseRunResponse(response);
  }

  async runStatus(runId: string): Promise<RunStatusResponse> {
    return this._client._request("GET", `${vmPath(this.id)}/runs/${pathSegment(runId)}`, undefined, this.baseUrl);
  }

  async cancelRun(runId: string): Promise<CancelRunResponse> {
    return this._client._request("DELETE", `${vmPath(this.id)}/runs/${pathSegment(runId)}`, undefined, this.baseUrl);
  }

  async delete(): Promise<DeleteVmResponse> {
    return this._client._request("DELETE", vmPath(this.id), undefined, this.baseUrl);
  }
}

export class Sync {
  /** @internal */
  readonly _vm: Computer;

  constructor(vm: Computer) {
    this._vm = vm;
  }

  async readFile(path: string): Promise<Uint8Array> {
    const response = await this._vm._client._request<SyncReadInlineResponse | SyncReadPresignedResponse>(
      "POST",
      this.path(),
      { op: "read", path },
      this._vm.baseUrl,
    );

    if ("content" in response) return decodeBytes(response.content, response.encoding);

    const signed = await this._vm._client._fetch(response.presigned_url);
    if (!signed.ok) throw new ArkerError("internal", `signed GET failed: ${signed.status}`, signed.status);
    return new Uint8Array(await signed.arrayBuffer());
  }

  async writeFile(path: string, data: Uint8Array | string): Promise<void> {
    const bytes = typeof data === "string" ? new TextEncoder().encode(data) : data;
    if (bytes.length <= CHUNK_SIZE) {
      await this.writeInline(path, bytes);
    } else {
      await this.writePresigned(path, bytes);
    }
  }

  private path(): string {
    return `${vmPath(this._vm.id)}/sync`;
  }

  private async writeInline(path: string, data: Uint8Array): Promise<void> {
    const result = await this.sendOneWrite({
      path,
      size: data.length,
      upload_id: ulid(),
      content: bytesToBase64(data),
      start: 0,
      end: data.length,
    });
    assertWriteComplete(result, "inline write");
  }

  private async writePresigned(path: string, data: Uint8Array): Promise<void> {
    const request = await this.sendOneWrite({
      path,
      size: data.length,
      presigned: true,
    });

    if (!("presigned_url" in request) || !request.presigned_url || !request.upload_id) {
      throw new ArkerError("internal", "write response missing presigned upload fields", 200);
    }

    await this.putPresigned(request.presigned_url, data);

    const commit = await this.sendOneWrite({
      path,
      size: data.length,
      upload_id: request.upload_id,
    });
    assertWriteComplete(commit, "presigned write commit");
  }

  private async putPresigned(url: string, data: Uint8Array): Promise<void> {
    const attempts = this._vm._client._retryAttempts();

    for (let attempt = 0; attempt < attempts; attempt++) {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), PRESIGNED_PUT_TIMEOUT_MS);

      try {
        const response = await this._vm._client._fetch(url, {
          method: "PUT",
          body: data as BodyInit,
          signal: controller.signal,
        });
        clearTimeout(timeout);

        if (response.ok) return;
        if (!RETRYABLE_HTTP.has(response.status) || attempt === attempts - 1) {
          throw new ArkerError("internal", `upload PUT failed: ${response.status}`, response.status);
        }
      } catch (error) {
        clearTimeout(timeout);
        if (error instanceof ArkerError) throw error;
        if (attempt === attempts - 1) {
          const message = error instanceof Error ? error.message : String(error);
          throw new ArkerError("network_error", `upload PUT failed: ${message}`, 0);
        }
      }

      await sleep(this._vm._client._retryDelay(attempt));
    }
  }

  private async sendOneWrite(entry: JsonObject): Promise<SyncWriteResult> {
    let lastError: ErrorResponse | undefined;
    const attempts = this._vm._client._retryAttempts();

    for (let attempt = 0; attempt < attempts; attempt++) {
      const response = await this._vm._client._request<SyncWriteResponse>("POST", this.path(), {
        op: "write",
        writes: [entry],
      }, this._vm.baseUrl);
      const result = response.results[0];
      if (!result) throw new ArkerError("internal", "write response missing results[0]", 200);

      const error = result.error ?? undefined;
      if (!error) return result;

      lastError = error;
      if (!isRetryable(200, error) || attempt === attempts - 1) break;
      await sleep(this._vm._client._retryDelay(attempt));
    }

    throw new ArkerError(lastError?.code ?? "internal", lastError?.message ?? "write failed", 200);
  }
}

function normalizeBaseUrl(baseUrl: string): string {
  const trimmed = baseUrl.trim().replace(/\/+$/, "");
  if (!trimmed) throw new Error("baseUrl must not be empty");
  return trimmed;
}

function normalizeRegion(region: string): string {
  const trimmed = region.trim().toLowerCase();
  if (!trimmed) throw new Error("region must not be empty");
  return trimmed;
}

function regionBaseUrl(region: string, burst: boolean): string {
  const normalized = normalizeRegion(region);
  if (!burst) return `https://${normalized}.arker.ai`;
  return `https://${burstRegionHost(normalized)}.arker.ai/api`;
}

function burstRegionHost(region: string): string {
  if (region.startsWith("aws-")) return `aws-burst-${region.slice("aws-".length)}`;
  return `${region}-burst`;
}

function isBurstRef(ref: string): boolean {
  const trimmed = ref.trim();
  return BURST_SOURCE_REFS.has(trimmed.toLowerCase()) || BURST_VM_ID.test(trimmed);
}

function normalizeRetry(retry: RetryOptions | false | undefined): RetryConfig {
  if (retry === false) {
    return { attempts: 1, baseDelayMs: 0, maxDelayMs: 0, jitterMs: 0 };
  }

  return {
    attempts: Math.max(1, Math.floor(retry?.attempts ?? DEFAULT_RETRY_ATTEMPTS)),
    baseDelayMs: Math.max(0, retry?.baseDelayMs ?? DEFAULT_RETRY_BASE_DELAY_MS),
    maxDelayMs: Math.max(0, retry?.maxDelayMs ?? DEFAULT_RETRY_MAX_DELAY_MS),
    jitterMs: Math.max(0, retry?.jitterMs ?? DEFAULT_RETRY_JITTER_MS),
  };
}

function env(name: string): string | undefined {
  const value = (globalThis as unknown as { process?: { env?: Record<string, string | undefined> } }).process?.env?.[name];
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

function vmPath(vmId: string): string {
  return `/v1/vms/${pathSegment(vmId)}`;
}

function pathSegment(value: string): string {
  return encodeURIComponent(value);
}

function withoutUndefined(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(withoutUndefined);
  if (!value || typeof value !== "object") return value;

  const output: JsonObject = {};
  for (const [key, entry] of Object.entries(value as JsonObject)) {
    if (entry !== undefined) output[key] = withoutUndefined(entry);
  }
  return output;
}

function parseRunResponse(payload: unknown): RunResult {
  const body = objectPayload(payload, "run response");

  if (typeof body.stdout === "string") {
    const stdout = stringValue(body.stdout, "run response.stdout");
    const stdoutEncoding = stringField(body.stdout_encoding, "run response.stdout_encoding");
    const stderr = stringValue(body.stderr, "run response.stderr");
    const stderrEncoding = stringField(body.stderr_encoding, "run response.stderr_encoding");
    if (body.completed !== true) {
      throw new ArkerError("internal", "completed run response must have completed=true", 200);
    }
    return {
      type: "completed",
      completed: true,
      stdout: decodeBytes(stdout, stdoutEncoding),
      stdoutEncoding,
      stderr: decodeBytes(stderr, stderrEncoding),
      stderrEncoding,
      exitCode: numberField(body.exit_code, "run response.exit_code"),
    };
  }

  if (typeof body.run_id === "string") {
    return {
      type: "background",
      completed: Boolean(body.completed),
      runId: body.run_id,
      tunnels: Array.isArray(body.tunnels) ? body.tunnels as RunTunnelStatus[] : [],
      network: isObject(body.network) ? body.network as unknown as RunNetworkStatus : null,
    };
  }

  if (body.pty === true) {
    return {
      type: "pty",
      pty: true,
      sessionId: stringField(body.session_id, "run response.session_id"),
      wsUrl: stringField(body.ws_url, "run response.ws_url"),
    };
  }

  throw new ArkerError("internal", "unrecognized run response shape", 200);
}

function parseJson(text: string): unknown {
  if (!text) return {};
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
}

function extractError(payload: unknown): ParsedError | undefined {
  if (!isObject(payload)) return undefined;

  if (typeof payload.code === "string" && typeof payload.message === "string") {
    return { code: payload.code, message: payload.message };
  }

  if (isObject(payload.error)) {
    return {
      code: typeof payload.error.code === "string" ? payload.error.code : "internal",
      message: typeof payload.error.message === "string" ? payload.error.message : "",
    };
  }

  return undefined;
}

function isRetryable(status: number, error?: ParsedError): boolean {
  if (RETRYABLE_HTTP.has(status)) return true;
  if (!error) return false;
  if (RETRYABLE_CODES.has(error.code)) return true;
  if (error.code !== "internal") return false;
  return TRANSIENT_HINTS.some((hint) => error.message.includes(hint));
}

function retryDelay(retry: RetryConfig, attempt: number): number {
  const base = Math.min(retry.maxDelayMs, retry.baseDelayMs * 2 ** attempt);
  return base + jitter(retry.jitterMs);
}

function jitter(maxMs: number): number {
  return Math.floor(Math.random() * (maxMs + 1));
}

async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

function objectPayload(value: unknown, context: string): JsonObject {
  if (!isObject(value)) throw new ArkerError("internal", `${context} must be an object`, 200);
  return value;
}

function isObject(value: unknown): value is JsonObject {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function stringField(value: unknown, context: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new ArkerError("internal", `${context} must be a non-empty string`, 200);
  }
  return value;
}

function stringValue(value: unknown, context: string): string {
  if (typeof value !== "string") throw new ArkerError("internal", `${context} must be a string`, 200);
  return value;
}

function numberField(value: unknown, context: string): number {
  if (typeof value !== "number") throw new ArkerError("internal", `${context} must be a number`, 200);
  return value;
}

function assertWriteComplete(result: SyncWriteResult, context: string): void {
  if (result.complete && result.written) return;
  throw new ArkerError("internal", `${context} did not complete`, 200);
}

function ulid(): string {
  const crypto = globalThis.crypto;
  if (!crypto?.getRandomValues) throw new Error("crypto.getRandomValues is required in this runtime");

  const time = BigInt(Date.now()) & ((1n << 48n) - 1n);
  const rand = new Uint8Array(10);
  crypto.getRandomValues(rand);
  let raw = (time << 80n) | rand.reduce((acc, byte) => (acc << 8n) | BigInt(byte), 0n);
  const out: string[] = [];

  for (let i = 0; i < 26; i++) {
    out.push(ULID_ALPHABET[Number(raw & 31n)]!);
    raw >>= 5n;
  }

  return out.reverse().join("");
}

function decodeBytes(text: string, encoding: string): Uint8Array {
  if (encoding === "base64") return base64ToBytes(text);
  return new TextEncoder().encode(text);
}

function bytesToBase64(data: Uint8Array): string {
  const buffer = bufferConstructor();
  if (buffer) return buffer.from(data).toString("base64");

  let binary = "";
  for (let offset = 0; offset < data.length; offset += 0x8000) {
    const chunk = data.subarray(offset, offset + 0x8000);
    binary += String.fromCharCode(...chunk);
  }
  return btoa(binary);
}

function base64ToBytes(text: string): Uint8Array {
  const buffer = bufferConstructor();
  if (buffer) {
    const decoded = buffer.from(text, "base64");
    return new Uint8Array(decoded.buffer, decoded.byteOffset, decoded.byteLength);
  }

  const binary = atob(text);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
  return out;
}

function bufferConstructor(): BufferConstructorLike | undefined {
  return (globalThis as unknown as { Buffer?: BufferConstructorLike }).Buffer;
}
