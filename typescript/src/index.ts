/**
 * Arker TypeScript SDK.
 *
 * A small wrapper around the VM API. Configure a region for the standard
 * Arker endpoints, or pass baseUrl directly for internal/dev targets.
 */

import type { components } from "./generated/api-types.js";

type ApiSchema<Name extends keyof components["schemas"]> = components["schemas"][Name];

export const CHUNK_SIZE = 4 * 1024 * 1024;

/**
 * Placeholder org id for the "Arker" org — the org that owns the public
 * golden VMs (`arkuntu`, `ubuntu`, …). When the SDK sees `source_image`
 * on a fork request it auto-fills `source_org_id` with this constant.
 */
export const ARKER_ORG_ID = "org_arker";

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

// ── State enums ────────────────────────────────────────────────────
export type VmState = ApiSchema<"VmState">;
export type SessionState = ApiSchema<"SessionState">;
export type RunState = ApiSchema<"RunState">;
export type TunnelState = ApiSchema<"TunnelState">;
export type ResourceKind = ApiSchema<"ResourceKind">;
export type ErrorCode = ApiSchema<"ErrorCode">;

// ── Core resources ─────────────────────────────────────────────────
export type NetworkPolicy = ApiSchema<"NetworkPolicy">;
export type NetworkPolicyInput = ApiSchema<"NetworkPolicyInput">;
export type ForkRequest = ApiSchema<"ForkRequest">;
export type ForkOptions = ForkRequest;
export type Session = ApiSchema<"Session">;
export type Vm = ApiSchema<"Vm">;
export type ListVmsResponse = ApiSchema<"ListVmsResponse">;
export type ListSessionsResponse = ApiSchema<"ListSessionsResponse">;
export type DeleteVmResponse = ApiSchema<"DeleteVmResponse">;
export type DeleteSessionResponse = ApiSchema<"DeleteSessionResponse">;

// ── Filesystems ────────────────────────────────────────────────────
export type Filesystem = ApiSchema<"Filesystem">;
export type ListFilesystemsResponse = ApiSchema<"ListFilesystemsResponse">;
export type DeleteFilesystemResponse = ApiSchema<"DeleteFilesystemResponse">;

// ── Syncs ──────────────────────────────────────────────────────────
export type SyncObject = ApiSchema<"Sync">;
export type ListSyncsResponse = ApiSchema<"ListSyncsResponse">;
export type DeleteSyncResponse = ApiSchema<"DeleteSyncResponse">;
export type SyncCreateRequest = ApiSchema<"SyncCreateRequest">;
export type SyncReadRequest = ApiSchema<"SyncReadRequest">;
export type SyncWriteRequest = ApiSchema<"SyncWriteRequest">;
export type SyncReadResponse = ApiSchema<"SyncReadResponse">;
export type SyncReadInlineResponse = ApiSchema<"SyncReadInlineResponse">;
export type SyncReadPresignedResponse = ApiSchema<"SyncReadPresignedResponse">;
export type SyncWriteResponse = ApiSchema<"SyncWriteResponse">;
export type SyncWriteResult = ApiSchema<"SyncWriteResult">;
export type SyncChunkWriteResult = ApiSchema<"SyncChunkWriteResult">;
export type SyncPresignedWriteRequestResult = ApiSchema<"SyncPresignedWriteRequestResult">;
export type SyncCommitWriteResult = ApiSchema<"SyncCommitWriteResult">;
export type SyncByteRange = ApiSchema<"SyncByteRange">;

// ── Runs ───────────────────────────────────────────────────────────
export type RunRequest = ApiSchema<"RunRequest">;
export type RunOptions = Partial<Omit<RunRequest, "command">> & {
  /**
   * Optional idempotency key for retrying the run. Sent as the
   * `Idempotency-Key` HTTP header.
   */
  idempotencyKey?: string;
};
export type InboundPortRequest = ApiSchema<"InboundPortRequest">;
export type NetworkRequest = ApiSchema<"NetworkRequest">;
export type Tunnel = ApiSchema<"Tunnel">;
export type ListTunnelsResponse = ApiSchema<"ListTunnelsResponse">;
export type DeleteTunnelResponse = ApiSchema<"DeleteTunnelResponse">;
export type NetworkStatus = ApiSchema<"NetworkStatus">;
export type RunResponse = ApiSchema<"RunResponse">;
export type CompletedRunResponse = ApiSchema<"CompletedRunResponse">;
export type BackgroundRunResponse = ApiSchema<"BackgroundRunResponse">;
export type Run = ApiSchema<"Run">;
export type RunSummary = ApiSchema<"RunSummary">;
export type ListRunsResponse = ApiSchema<"ListRunsResponse">;
export type CancelRunResponse = ApiSchema<"CancelRunResponse">;

// ── Sessions / resize ──────────────────────────────────────────────
export type CreateSessionRequest = ApiSchema<"CreateSessionRequest">;
export type ResizeRequest = ApiSchema<"ResizeRequest">;
export type ResizeResponse = ApiSchema<"ResizeResponse">;

// ── Errors ─────────────────────────────────────────────────────────
export type ErrorResponse = ApiSchema<"ErrorResponse">;

// ── Back-compat aliases (deprecated) ───────────────────────────────
/** @deprecated Use `Vm`. */
export type VmInfo = Vm;
/** @deprecated Use `Session`. */
export type SessionInfo = Session;
/** @deprecated Use `Run`. */
export type RunStatusResponse = Run;
/** @deprecated Use `NetworkRequest`. */
export type RunNetworkRequest = NetworkRequest;
/** @deprecated Use `NetworkStatus`. */
export type RunNetworkStatus = NetworkStatus;
/** @deprecated Use `InboundPortRequest`. */
export type RunInboundPortRequest = InboundPortRequest;
/** @deprecated Use `Tunnel`. */
export type RunTunnelStatus = Tunnel;

// ── Result shapes for the high-level run() helper ──────────────────
export interface CompletedRunResult {
  type: "completed";
  stdout: Uint8Array;
  stdoutEncoding: string;
  stderr: Uint8Array;
  stderrEncoding: string;
  exitCode: number;
}

export interface BackgroundRunResult {
  type: "background";
  runId: string;
  tunnels: Tunnel[];
  network?: NetworkStatus | null;
}

export type RunResult = CompletedRunResult | BackgroundRunResult;

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

/** Optional source for the high-level `fork()` helper. */
export interface ForkSource {
  image?: string;
  vmId?: string;
  vmName?: string;
  orgId?: string;
}

export class Arker {
  readonly baseUrl: string;
  readonly burstBaseUrl?: string;
  readonly region?: string;
  readonly filesystems: Filesystems;
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
    this.filesystems = new Filesystems(this);

    if (!this.fetchImpl) throw new Error("fetch is required in this runtime");
  }

  /**
   * Address an existing VM. Doesn't make any network calls; returns a
   * lightweight handle.
   */
  vm(vmId: string): Computer {
    return new Computer(this, vmId, this._baseUrlFor(vmId));
  }

  /**
   * Create a new VM by forking. Source can be addressed by image name
   * (defaults to Arker org), global VM id, or VM name within an org.
   *
   * - `fork({ image: "arkuntu" })` — fork the public arkuntu golden.
   * - `fork({ vmId: "vm_abc..." })` — fork by global id.
   * - `fork({ vmName: "base", orgId: "..." })` — fork by name within an org.
   */
  async fork(source: ForkSource & Partial<Omit<ForkRequest, "source_image" | "source_vm_id" | "source_vm_name" | "source_org_id">>): Promise<Computer> {
    const body: ForkRequest = {
      source_image: source.image ?? null,
      source_vm_id: source.vmId ?? null,
      source_vm_name: source.vmName ?? null,
      // Auto-fill: an image-based fork without an explicit org_id targets
      // the Arker org (where the public goldens live).
      source_org_id: source.orgId ?? (source.image ? ARKER_ORG_ID : null),
      name: source.name ?? null,
      public: source.public ?? null,
      network: source.network ?? null,
      tunnels: source.tunnels ?? null,
      disk: source.disk ?? true,
      vcpu_count: source.vcpu_count ?? null,
      memory_mib: source.memory_mib ?? null,
      max_memory_mib: source.max_memory_mib ?? null,
      disk_mib: source.disk_mib ?? null,
      durable: source.durable ?? null,
    };
    const baseUrl = source.image && isBurstRef(source.image) && this.burstBaseUrl ? this.burstBaseUrl : this.baseUrl;
    const vm = await this._request<Vm>("POST", "/v1/fork", body, baseUrl);
    return new Computer(this, vm.vm_id, this._baseUrlFor(vm.vm_id));
  }

  /**
   * List VMs visible to the authenticated caller. Aggregates across
   * providers unless `?provider=` is set.
   */
  async list(opts: ListOpts & { region?: string; provider?: "aws" | "aws-burst"; state?: VmState; startedAfter?: string; startedBefore?: string } = {}): Promise<ListVmsResponse> {
    return this._request("GET", buildQuery("/v1/vms", {
      cursor: opts.cursor,
      limit: opts.limit,
      region: opts.region,
      provider: opts.provider,
      state: opts.state,
      started_after: opts.startedAfter,
      started_before: opts.startedBefore,
    }));
  }

  async get(vmId: string): Promise<Vm> {
    return this._request("GET", vmPath(vmId), undefined, this._baseUrlFor(vmId));
  }

  /** @internal */
  async _request<T>(
    method: HttpMethod,
    path: string,
    body?: unknown,
    baseUrl = this.baseUrl,
    extraHeaders?: Record<string, string | undefined>,
  ): Promise<T> {
    const url = `${baseUrl}${path}`;
    const headers: Record<string, string> = {
      authorization: `Bearer ${this.apiKey}`,
    };
    if (extraHeaders) {
      for (const [key, value] of Object.entries(extraHeaders)) {
        if (value !== undefined) headers[key] = value;
      }
    }
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

export interface ListOpts {
  cursor?: string;
  limit?: number;
}

export class Filesystems {
  /** @internal */
  readonly _client: Arker;

  constructor(client: Arker) {
    this._client = client;
  }

  async list(opts: ListOpts & { namePrefix?: string } = {}): Promise<ListFilesystemsResponse> {
    return this._client._request("GET", buildQuery("/v1/filesystems", {
      cursor: opts.cursor,
      limit: opts.limit,
      name_prefix: opts.namePrefix,
    }));
  }

  async get(filesystemId: string): Promise<Filesystem> {
    return this._client._request("GET", `/v1/filesystems/${pathSegment(filesystemId)}`);
  }

  async delete(filesystemId: string): Promise<DeleteFilesystemResponse> {
    return this._client._request("DELETE", `/v1/filesystems/${pathSegment(filesystemId)}`);
  }
}

export class Computer {
  readonly id: string;
  readonly baseUrl: string;
  readonly syncs: Syncs;
  readonly tunnels: Tunnels;
  readonly runs: Runs;
  readonly sessions: Sessions;
  /** @internal */
  readonly _client: Arker;

  constructor(client: Arker, vmId: string, baseUrl = client._baseUrlFor(vmId)) {
    this._client = client;
    this.id = vmId;
    this.baseUrl = baseUrl;
    this.syncs = new Syncs(this);
    this.tunnels = new Tunnels(this);
    this.runs = new Runs(this);
    this.sessions = new Sessions(this);
  }

  /** Refresh and return this VM's current state. */
  async get(): Promise<Vm> {
    return this._client._request("GET", vmPath(this.id), undefined, this.baseUrl);
  }

  /**
   * @deprecated Use `Arker.fork({ vmId: this.id, ... })`. Returned for
   * back-compat with older user code that called `.fork()` on a Computer.
   */
  async fork(request: ForkOptions = {} as ForkOptions): Promise<Computer> {
    const merged: ForkRequest = {
      ...request,
      source_vm_id: request.source_vm_id ?? this.id,
    } as ForkRequest;
    const vm = await this._client._request<Vm>("POST", "/v1/fork", merged, this.baseUrl);
    return new Computer(this._client, vm.vm_id, this._client._baseUrlFor(vm.vm_id));
  }

  async run(command: string, options: RunOptions = {}): Promise<RunResult> {
    const { idempotencyKey, ...body } = options;
    const headers = idempotencyKey ? { "Idempotency-Key": idempotencyKey } : undefined;
    const response = await this._client._request<unknown>(
      "POST",
      `${vmPath(this.id)}/runs`,
      { ...body, command },
      this.baseUrl,
      headers,
    );
    return parseRunResponse(response);
  }

  async resize(request: ResizeRequest): Promise<ResizeResponse> {
    return this._client._request("POST", `${vmPath(this.id)}/resize`, request, this.baseUrl);
  }

  async delete(): Promise<DeleteVmResponse> {
    return this._client._request("DELETE", vmPath(this.id), undefined, this.baseUrl);
  }
}

export class Runs {
  /** @internal */
  readonly _vm: Computer;

  constructor(vm: Computer) {
    this._vm = vm;
  }

  async list(opts: ListOpts & { state?: RunState; startedAfter?: string; startedBefore?: string; completedAfter?: string } = {}): Promise<ListRunsResponse> {
    return this._vm._client._request("GET", buildQuery(`${vmPath(this._vm.id)}/runs`, {
      cursor: opts.cursor,
      limit: opts.limit,
      state: opts.state,
      started_after: opts.startedAfter,
      started_before: opts.startedBefore,
      completed_after: opts.completedAfter,
    }), undefined, this._vm.baseUrl);
  }

  async get(runId: string): Promise<Run> {
    return this._vm._client._request("GET", `${vmPath(this._vm.id)}/runs/${pathSegment(runId)}`, undefined, this._vm.baseUrl);
  }

  async cancel(runId: string): Promise<CancelRunResponse> {
    return this._vm._client._request("DELETE", `${vmPath(this._vm.id)}/runs/${pathSegment(runId)}`, undefined, this._vm.baseUrl);
  }
}

export class Sessions {
  /** @internal */
  readonly _vm: Computer;

  constructor(vm: Computer) {
    this._vm = vm;
  }

  async list(opts: ListOpts & { state?: SessionState } = {}): Promise<ListSessionsResponse> {
    return this._vm._client._request("GET", buildQuery(`${vmPath(this._vm.id)}/sessions`, {
      cursor: opts.cursor,
      limit: opts.limit,
      state: opts.state,
    }), undefined, this._vm.baseUrl);
  }

  async get(sessionId: string): Promise<Session> {
    return this._vm._client._request("GET", `${vmPath(this._vm.id)}/sessions/${pathSegment(sessionId)}`, undefined, this._vm.baseUrl);
  }

  async create(request: CreateSessionRequest = {}): Promise<Session> {
    return this._vm._client._request("POST", `${vmPath(this._vm.id)}/sessions`, request, this._vm.baseUrl);
  }

  async delete(sessionId: string): Promise<DeleteSessionResponse> {
    return this._vm._client._request("DELETE", `${vmPath(this._vm.id)}/sessions/${pathSegment(sessionId)}`, undefined, this._vm.baseUrl);
  }
}

export class Tunnels {
  /** @internal */
  readonly _vm: Computer;

  constructor(vm: Computer) {
    this._vm = vm;
  }

  async list(opts: ListOpts & { state?: TunnelState } = {}): Promise<ListTunnelsResponse> {
    return this._vm._client._request("GET", buildQuery(`${vmPath(this._vm.id)}/tunnels`, {
      cursor: opts.cursor,
      limit: opts.limit,
      state: opts.state,
    }), undefined, this._vm.baseUrl);
  }

  async get(port: number): Promise<Tunnel> {
    return this._vm._client._request("GET", `${vmPath(this._vm.id)}/tunnels/${port}`, undefined, this._vm.baseUrl);
  }

  async delete(port: number): Promise<DeleteTunnelResponse> {
    return this._vm._client._request("DELETE", `${vmPath(this._vm.id)}/tunnels/${port}`, undefined, this._vm.baseUrl);
  }
}

export class Syncs {
  /** @internal */
  readonly _vm: Computer;

  constructor(vm: Computer) {
    this._vm = vm;
  }

  async list(opts: ListOpts & { filesystemId?: string } = {}): Promise<ListSyncsResponse> {
    return this._vm._client._request("GET", buildQuery(`${vmPath(this._vm.id)}/syncs`, {
      cursor: opts.cursor,
      limit: opts.limit,
      filesystem_id: opts.filesystemId,
    }), undefined, this._vm.baseUrl);
  }

  async get(syncId: string): Promise<SyncObject> {
    return this._vm._client._request("GET", `${vmPath(this._vm.id)}/syncs/${pathSegment(syncId)}`, undefined, this._vm.baseUrl);
  }

  /**
   * Ensure a `Filesystem` exists (creating one if requested) and
   * bind-mount it into this VM at `path`. Bidirectional by virtue of
   * being a mount — there is no separate sync-direction parameter.
   */
  async create(request: {
    path: string;
    filesystemId?: string;
    filesystemName?: string;
    createIfMissing?: boolean;
  }): Promise<SyncObject> {
    return this._vm._client._request<SyncObject>(
      "POST",
      `${vmPath(this._vm.id)}/syncs`,
      {
        path: request.path,
        filesystem_id: request.filesystemId,
        filesystem_name: request.filesystemName,
        create_if_missing: request.createIfMissing ?? false,
      },
      this._vm.baseUrl,
    );
  }

  async delete(syncId: string): Promise<DeleteSyncResponse> {
    return this._vm._client._request("DELETE", `${vmPath(this._vm.id)}/syncs/${pathSegment(syncId)}`, undefined, this._vm.baseUrl);
  }

  async readFile(path: string): Promise<Uint8Array> {
    const response = await this._vm._client._request<SyncReadInlineResponse | SyncReadPresignedResponse>(
      "POST",
      `${vmPath(this._vm.id)}/syncs/read`,
      { path },
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
      const response = await this._vm._client._request<SyncWriteResponse>("POST", `${vmPath(this._vm.id)}/syncs/write`, {
        writes: [entry],
      }, this._vm.baseUrl);
      const result = response.results[0];
      if (!result) throw new ArkerError("internal", "write response missing results[0]", 200);
      const error = result.error ?? undefined;
      if (!error) return result;
      lastError = error as ErrorResponse;
      if (!isRetryable(200, { code: error.code as string, message: error.message }) || attempt === attempts - 1) break;
      await sleep(this._vm._client._retryDelay(attempt));
    }
    throw new ArkerError(lastError?.code ?? "internal", lastError?.message ?? "write failed", 200);
  }
}

// ── Helpers ────────────────────────────────────────────────────────

function buildQuery(path: string, params: Record<string, unknown>): string {
  const usp = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === null) continue;
    usp.append(key, String(value));
  }
  const qs = usp.toString();
  return qs ? `${path}?${qs}` : path;
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
  if (!burst) return `https://${normalized}.arker.ai/api`;
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
    return {
      type: "completed",
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
      runId: body.run_id,
      tunnels: Array.isArray(body.tunnels) ? body.tunnels as Tunnel[] : [],
      network: isObject(body.network) ? body.network as unknown as NetworkStatus : null,
    };
  }
  throw new ArkerError("internal", "unrecognized run response shape", 200);
}

function parseJson(text: string): unknown {
  if (!text) return {};
  try { return JSON.parse(text) as unknown; } catch { return undefined; }
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

function jitter(maxMs: number): number { return Math.floor(Math.random() * (maxMs + 1)); }

async function sleep(ms: number): Promise<void> { await new Promise((resolve) => setTimeout(resolve, ms)); }

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
