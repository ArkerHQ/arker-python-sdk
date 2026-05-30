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
 * Org id for the "Arker" org — the org that owns the public golden VMs
 * (`arkuntu`, `ubuntu`, `ubuntu-full`, `ubuntu-py-repl`, …). Pass it as
 * `sourceOrgId` to fork a public golden:
 *
 *     arker.fork({ sourceVmName: "ubuntu-full", sourceOrgId: ARKER_ORG_ID })
 */
export const ARKER_ORG_ID = "ArkerHQ";

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
const DEFAULT_PROVIDER_ENV = "ARKER_PROVIDER";
const DEFAULT_PROVIDER: "aws" | "aws-burst" = "aws";
const DEFAULT_CONTROL_BASE_URL = "https://arker.ai/api";
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
  /** Region (e.g. `"us-west-2"`). Combined with `provider` to build the
   * compute endpoint. Back-compat: accepts the legacy combined form
   * `"aws-us-west-2"`. */
  region?: string;
  /** Provider for compute calls. Defaults to `"aws"` (arkerd-managed
   * VMs). Use `"aws-burst"` to target the Lambda burst backend
   * directly. Has no effect on the burst-classified routing — a fork
   * of `arkuntu` in the Arker org still goes to burst regardless. */
  provider?: "aws" | "aws-burst";
  /** Override the compute base URL (e.g. for internal / dev targets).
   * If set, `provider` + `region` are ignored for compute. */
  baseUrl?: string;
  /** Override the burst compute base URL. */
  burstBaseUrl?: string;
  /** Override the control-plane URL — the CF Worker that owns
   * administrative endpoints like `GET /v1/vms` (cross-provider list)
   * and `/v1/filesystems`. Default `https://arker.ai/api`. */
  controlBaseUrl?: string;
  fetch?: FetchLike;
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

/** Source for `Arker.fork()`. Exactly one of `sourceVmId` or
 * `sourceVmName` must be set. When `sourceVmName` is set,
 * `sourceOrgId` selects which org to look the name up in (defaults
 * server-side to the caller's org; pass `ARKER_ORG_ID` to fork the
 * public goldens like `"arkuntu"` / `"ubuntu"`).
 *
 * Distinct from the new VM's `name`, which is the *destination* name. */
export interface ForkSource {
  sourceVmId?: string;
  sourceVmName?: string;
  sourceOrgId?: string;
}

export class Arker {
  /** Compute base URL for `provider` + `region` — used for fork/run/
   * per-VM ops. SDK calls go straight to this host, skipping the CF
   * Worker control plane. */
  readonly baseUrl: string;
  /** Compute base URL for the burst provider in this region. */
  readonly burstBaseUrl?: string;
  /** CF Worker control-plane URL — used for cross-cutting admin calls
   * like list-VMs and filesystems. */
  readonly controlBaseUrl: string;
  readonly region?: string;
  readonly provider: "aws" | "aws-burst";
  private readonly apiKey: string;
  private readonly fetchImpl: FetchLike;
  private readonly retry: RetryConfig;

  constructor(opts: ArkerOptions = {}) {
    const apiKey = opts.apiKey ?? env("ARKER_API_KEY") ?? env("AUTH_KEY");
    const explicitBaseUrl = opts.baseUrl ?? env("ARKER_BASE_URL");
    const rawRegion = opts.region ?? (explicitBaseUrl ? undefined : env(DEFAULT_REGION_ENV));
    const rawProvider = (opts.provider as string | undefined) ?? env(DEFAULT_PROVIDER_ENV) ?? DEFAULT_PROVIDER;
    const provider = parseProvider(rawProvider);
    const { region, providerFromRegion } = splitRegion(rawRegion);
    const effectiveProvider = providerFromRegion ?? provider;

    const baseUrl = explicitBaseUrl ?? (region ? computeBaseUrl(effectiveProvider, region) : undefined);
    const burstBaseUrl = opts.burstBaseUrl ?? env("ARKER_BURST_BASE_URL") ?? (region ? computeBaseUrl("aws-burst", region) : undefined);
    const controlBaseUrl = opts.controlBaseUrl ?? env("ARKER_CONTROL_BASE_URL") ?? DEFAULT_CONTROL_BASE_URL;

    if (!apiKey) throw new Error("apiKey is required; pass apiKey or set ARKER_API_KEY");
    if (!baseUrl) throw new Error("region or baseUrl is required; pass region, baseUrl, ARKER_REGION, or ARKER_BASE_URL");

    this.apiKey = apiKey;
    this.baseUrl = normalizeBaseUrl(baseUrl);
    this.burstBaseUrl = burstBaseUrl ? normalizeBaseUrl(burstBaseUrl) : undefined;
    this.controlBaseUrl = normalizeBaseUrl(controlBaseUrl);
    this.region = region ? normalizeRegion(region) : undefined;
    this.provider = effectiveProvider;
    this.fetchImpl = opts.fetch ?? globalThis.fetch;
    this.retry = normalizeRetry(opts.retry);

    if (!this.fetchImpl) throw new Error("fetch is required in this runtime");
  }

  /**
   * Address an existing VM. Doesn't make any network calls; returns a
   * lightweight handle.
   */
  vm(vmId: string): VM {
    return new VM(this, vmId, this._baseUrlFor(vmId));
  }

  /**
   * Create a new VM by forking.
   *
   *     fork({ sourceVmId: "vm_abc..." })
   *     fork({ sourceVmName: "base" })                            // caller's org
   *     fork({ sourceVmName: "arkuntu", sourceOrgId: ARKER_ORG_ID })
   *
   * Exactly one of `sourceVmId` or `sourceVmName` must be set. When
   * `sourceVmName` is used, `sourceOrgId` selects which org to look it
   * up in; without it the server defaults to the caller's org. Forking
   * a VM in another org requires that VM to be `public: true`. The new
   * VM's name (in the caller's org) is passed as `name`.
   */
  async fork(source: ForkSource & Partial<Omit<ForkRequest, "source_vm_id" | "source_vm_name" | "source_org_id">>): Promise<VM> {
    if (!source.sourceVmId && !source.sourceVmName) {
      throw new ArkerError(
        "bad_request",
        "fork requires sourceVmId or sourceVmName",
        400,
      );
    }
    if (source.sourceVmId && source.sourceVmName) {
      throw new ArkerError(
        "bad_request",
        "fork: pass only one of sourceVmId or sourceVmName",
        400,
      );
    }
    const body: ForkRequest = {
      source_vm_id: source.sourceVmId ?? null,
      source_vm_name: source.sourceVmName ?? null,
      source_org_id: source.sourceOrgId ?? null,
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
    // Forks that target a burst-pool name in the Arker org go to the
    // burst backend (ps-lambda); everything else to arkerd.
    const useBurst =
      source.sourceOrgId === ARKER_ORG_ID &&
      source.sourceVmName !== undefined &&
      isBurstRef(source.sourceVmName);
    const baseUrl = useBurst && this.burstBaseUrl ? this.burstBaseUrl : this.baseUrl;
    const vm = await this._request<Vm>("POST", "/v1/fork", body, baseUrl);
    const vmId = vm.vm_id ?? (vm as { id?: string }).id ?? "";
    // Child lives on the same host the fork was posted to.
    return new VM(this, vmId, baseUrl, vm);
  }

  /**
   * List VMs visible to the authenticated caller. **Admin call** —
   * goes through the control plane (`controlBaseUrl`) so it can
   * aggregate across providers and regions. Pass `?provider=` /
   * `?region=` to narrow.
   */
  async listVms(opts: ListOpts & { region?: string; provider?: "aws" | "aws-burst"; state?: VmState; sourceOrgId?: string; startedAfter?: string; startedBefore?: string } = {}): Promise<{ vms: VM[]; nextCursor: string | null }> {
    const resp = await this._request<ListVmsResponse>("GET", buildQuery("/v1/vms", {
      cursor: opts.cursor,
      limit: opts.limit,
      region: opts.region,
      provider: opts.provider,
      state: opts.state,
      source_org_id: opts.sourceOrgId,
      started_after: opts.startedAfter,
      started_before: opts.startedBefore,
    }), undefined, this.controlBaseUrl);
    const vms = (resp.vms ?? []).map((v) => {
      const id = v.vm_id ?? (v as { id?: string }).id ?? "";
      return new VM(this, id, this._baseUrlFor(id), v);
    });
    return { vms, nextCursor: resp.next_cursor ?? null };
  }

  /** Compute call — goes direct to the backend hosting this VM (no
   * control-plane hop). Returns a fully-populated VM handle. */
  async getVm(vmId: string): Promise<VM> {
    const data = await this._request<Vm>("GET", vmPath(vmId), undefined, this._baseUrlFor(vmId));
    return new VM(this, vmId, this._baseUrlFor(vmId), data);
  }

  // ── Filesystems (org-scoped, control-plane) ─────────────────────────
  async listFilesystems(opts: ListOpts & { namePrefix?: string } = {}): Promise<ListFilesystemsResponse> {
    return this._request("GET", buildQuery("/v1/filesystems", {
      cursor: opts.cursor, limit: opts.limit, name_prefix: opts.namePrefix,
    }), undefined, this.controlBaseUrl);
  }

  async getFilesystem(filesystemId: string): Promise<Filesystem> {
    return this._request("GET", `/v1/filesystems/${pathSegment(filesystemId)}`, undefined, this.controlBaseUrl);
  }

  async deleteFilesystem(filesystemId: string): Promise<DeleteFilesystemResponse> {
    return this._request("DELETE", `/v1/filesystems/${pathSegment(filesystemId)}`, undefined, this.controlBaseUrl);
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

export class VM {
  readonly id: string;
  readonly baseUrl: string;
  /** @internal */
  readonly _client: Arker;
  // ── Data fields ──────────────────────────────────────────────────
  // Populated from fork/get/list/refresh; `undefined` on a bare handle
  // from `arker.vm(id)` until you call `refresh()`. Names mirror the
  // contract (`Vm`).
  readonly vm_id?: string;
  readonly name?: string | null;
  readonly state?: VmState;
  readonly owner_org_id?: string;
  readonly created_at?: string;
  readonly public?: boolean;
  readonly region?: string | null;
  readonly provider?: string | null;
  readonly vcpu_count?: number | null;
  readonly memory_mib?: number | null;
  readonly disk_mib?: number | null;
  readonly started_at?: string | null;
  readonly root_source_vm_id?: string | null;
  readonly root_source_vm_name?: string | null;
  readonly worker_id?: string | null;
  readonly sessions?: Session[];
  readonly tunnels?: Tunnel[];
  readonly network?: NetworkStatus | null;

  constructor(client: Arker, vmId: string, baseUrl = client._baseUrlFor(vmId), data?: Vm) {
    this._client = client;
    this.id = vmId;
    this.baseUrl = baseUrl;
    if (data) Object.assign(this, data);
    // Keep the client reference off enumeration so `JSON.stringify(vm)` /
    // `console.log(vm)` show just the VM's data, not the whole SDK.
    Object.defineProperty(this, "_client", { enumerable: false });
  }

  /** Re-fetch this VM and return a fresh, fully-populated handle. */
  async refresh(): Promise<VM> {
    const data = await this._client._request<Vm>("GET", vmPath(this.id), undefined, this.baseUrl);
    return new VM(this._client, this.id, this.baseUrl, data);
  }

  /**
   * @deprecated Use `Arker.fork({ sourceVmId: this.id, ... })`.
   * Kept for back-compat with older user code that called `.fork()` on
   * a VM instance.
   */
  async fork(request: Partial<ForkRequest> = {}): Promise<VM> {
    const merged: ForkRequest = {
      disk: true,
      ...request,
      source_vm_id: request.source_vm_id ?? this.id,
    } as ForkRequest;
    const vm = await this._client._request<Vm>("POST", "/v1/fork", merged, this.baseUrl);
    const vmId = vm.vm_id ?? (vm as { id?: string }).id ?? "";
    // The child is forked on the same compute host as the source, so it lives
    // on the same base URL (this.baseUrl) — not whatever the id alone implies.
    return new VM(this._client, vmId, this.baseUrl, vm);
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

  /**
   * Read or write a file in this VM over `POST /v1/vms/{id}/sync`.
   * Omit `data` to read; pass `data` (string or bytes) to write. The
   * client picks inline transfer for small files and presigned uploads
   * for large ones automatically.
   *
   *     const bytes = await vm.sync("/home/user/out.txt");   // read
   *     await vm.sync("/home/user/in.txt", "hello\n");       // write
   *
   * To mount a standalone filesystem into the VM, use `vm.syncs.create`.
   */
  async sync(path: string): Promise<Uint8Array>;
  async sync(path: string, data: Uint8Array | string): Promise<void>;
  async sync(path: string, data?: Uint8Array | string): Promise<Uint8Array | void> {
    if (data === undefined) return this.syncRead(path);
    const bytes = typeof data === "string" ? new TextEncoder().encode(data) : data;
    if (bytes.length <= CHUNK_SIZE) await this.syncWriteInline(path, bytes);
    else await this.syncWritePresigned(path, bytes);
  }

  private async syncRead(path: string): Promise<Uint8Array> {
    const response = await this._client._request<SyncReadInlineResponse | SyncReadPresignedResponse>(
      "POST",
      `${vmPath(this.id)}/sync`,
      { op: "read", path },
      this.baseUrl,
    );
    if ("content" in response) return decodeBytes(response.content, response.encoding);
    const signed = await this._client._fetch(response.presigned_url);
    if (!signed.ok) throw new ArkerError("internal", `signed GET failed: ${signed.status}`, signed.status);
    return new Uint8Array(await signed.arrayBuffer());
  }

  private async syncWriteInline(path: string, data: Uint8Array): Promise<void> {
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

  private async syncWritePresigned(path: string, data: Uint8Array): Promise<void> {
    const request = await this.sendOneWrite({ path, size: data.length, presigned: true });
    if (!("presigned_url" in request) || !request.presigned_url || !request.upload_id) {
      throw new ArkerError("internal", "write response missing presigned upload fields", 200);
    }
    await this.putPresigned(request.presigned_url, data);
    const commit = await this.sendOneWrite({ path, size: data.length, upload_id: request.upload_id });
    assertWriteComplete(commit, "presigned write commit");
  }

  private async putPresigned(url: string, data: Uint8Array): Promise<void> {
    const attempts = this._client._retryAttempts();
    for (let attempt = 0; attempt < attempts; attempt++) {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), PRESIGNED_PUT_TIMEOUT_MS);
      try {
        const response = await this._client._fetch(url, {
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
      await sleep(this._client._retryDelay(attempt));
    }
  }

  private async sendOneWrite(entry: JsonObject): Promise<SyncWriteResult> {
    let lastError: ErrorResponse | undefined;
    const attempts = this._client._retryAttempts();
    for (let attempt = 0; attempt < attempts; attempt++) {
      const response = await this._client._request<SyncWriteResponse>("POST", `${vmPath(this.id)}/sync`, {
        op: "write",
        writes: [entry],
      }, this.baseUrl);
      const result = response.results[0];
      if (!result) throw new ArkerError("internal", "write response missing results[0]", 200);
      const error = result.error ?? undefined;
      if (!error) return result;
      lastError = error as ErrorResponse;
      if (!isRetryable(200, { code: error.code as string, message: error.message }) || attempt === attempts - 1) break;
      await sleep(this._client._retryDelay(attempt));
    }
    throw new ArkerError(lastError?.code ?? "internal", lastError?.message ?? "write failed", 200);
  }

  async resize(request: ResizeRequest): Promise<ResizeResponse> {
    return this._client._request("POST", `${vmPath(this.id)}/resize`, request, this.baseUrl);
  }

  async delete(): Promise<DeleteVmResponse> {
    return this._client._request("DELETE", vmPath(this.id), undefined, this.baseUrl);
  }

  // ── Syncs: bindings of a filesystem into this VM at a path ────────
  async listSyncs(opts: ListOpts & { filesystemId?: string } = {}): Promise<ListSyncsResponse> {
    return this._client._request("GET", buildQuery(`${vmPath(this.id)}/syncs`, {
      cursor: opts.cursor, limit: opts.limit, filesystem_id: opts.filesystemId,
    }), undefined, this.baseUrl);
  }

  async createSync(request: { path: string; filesystemId?: string; filesystemName?: string; createIfMissing?: boolean }): Promise<SyncObject> {
    return this._client._request<SyncObject>("POST", `${vmPath(this.id)}/syncs`, {
      path: request.path,
      filesystem_id: request.filesystemId,
      filesystem_name: request.filesystemName,
      create_if_missing: request.createIfMissing ?? false,
    }, this.baseUrl);
  }

  async getSync(syncId: string): Promise<SyncObject> {
    return this._client._request("GET", `${vmPath(this.id)}/syncs/${pathSegment(syncId)}`, undefined, this.baseUrl);
  }

  async deleteSync(syncId: string): Promise<DeleteSyncResponse> {
    return this._client._request("DELETE", `${vmPath(this.id)}/syncs/${pathSegment(syncId)}`, undefined, this.baseUrl);
  }

  // ── Runs ──────────────────────────────────────────────────────────
  async listRuns(opts: ListOpts & { state?: RunState; startedAfter?: string; startedBefore?: string; completedAfter?: string } = {}): Promise<ListRunsResponse> {
    return this._client._request("GET", buildQuery(`${vmPath(this.id)}/runs`, {
      cursor: opts.cursor, limit: opts.limit, state: opts.state,
      started_after: opts.startedAfter, started_before: opts.startedBefore, completed_after: opts.completedAfter,
    }), undefined, this.baseUrl);
  }

  async getRun(runId: string): Promise<Run> {
    return this._client._request("GET", `${vmPath(this.id)}/runs/${pathSegment(runId)}`, undefined, this.baseUrl);
  }

  async cancelRun(runId: string): Promise<CancelRunResponse> {
    return this._client._request("DELETE", `${vmPath(this.id)}/runs/${pathSegment(runId)}`, undefined, this.baseUrl);
  }

  // ── Sessions ──────────────────────────────────────────────────────
  async listSessions(opts: ListOpts & { state?: SessionState } = {}): Promise<ListSessionsResponse> {
    return this._client._request("GET", buildQuery(`${vmPath(this.id)}/sessions`, {
      cursor: opts.cursor, limit: opts.limit, state: opts.state,
    }), undefined, this.baseUrl);
  }

  async createSession(request: CreateSessionRequest = {}): Promise<Session> {
    return this._client._request("POST", `${vmPath(this.id)}/sessions`, request, this.baseUrl);
  }

  async getSession(sessionId: string): Promise<Session> {
    return this._client._request("GET", `${vmPath(this.id)}/sessions/${pathSegment(sessionId)}`, undefined, this.baseUrl);
  }

  async deleteSession(sessionId: string): Promise<DeleteSessionResponse> {
    return this._client._request("DELETE", `${vmPath(this.id)}/sessions/${pathSegment(sessionId)}`, undefined, this.baseUrl);
  }

  // ── Tunnels: opened as a side effect of fork/run, addressed by port ─
  async listTunnels(opts: ListOpts & { state?: TunnelState } = {}): Promise<ListTunnelsResponse> {
    return this._client._request("GET", buildQuery(`${vmPath(this.id)}/tunnels`, {
      cursor: opts.cursor, limit: opts.limit, state: opts.state,
    }), undefined, this.baseUrl);
  }

  async getTunnel(port: number): Promise<Tunnel> {
    return this._client._request("GET", `${vmPath(this.id)}/tunnels/${port}`, undefined, this.baseUrl);
  }

  async deleteTunnel(port: number): Promise<DeleteTunnelResponse> {
    return this._client._request("DELETE", `${vmPath(this.id)}/tunnels/${port}`, undefined, this.baseUrl);
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

function computeBaseUrl(provider: "aws" | "aws-burst", region: string): string {
  // The subdomain encodes provider+region — `https://aws-us-west-2.arker.ai`
  // routes to arkerd in us-west-2; `https://aws-burst-us-west-2.arker.ai`
  // routes to ps-lambda. Today both subdomains still resolve through the
  // CF Worker (which dispatches based on hostname), so the path includes
  // `/api`. When DNS is split to bypass the worker on the compute
  // subdomains, drop `/api` here.
  const normalized = normalizeRegion(region);
  return `https://${provider}-${normalized}.arker.ai/api`;
}

function parseProvider(value: string | undefined | null): "aws" | "aws-burst" {
  if (!value) return DEFAULT_PROVIDER;
  const trimmed = value.trim().toLowerCase();
  if (trimmed === "aws-burst" || trimmed === "burst") return "aws-burst";
  return "aws";
}

/** Accept both the new `region`-only form ("us-west-2") and the legacy
 * combined form ("aws-us-west-2" / "aws-burst-us-west-2"). When the
 * combined form is used we return the embedded provider so the caller
 * doesn't need to set both. */
function splitRegion(value: string | undefined): { region?: string; providerFromRegion?: "aws" | "aws-burst" } {
  if (!value) return {};
  const normalized = value.trim().toLowerCase();
  if (normalized.startsWith("aws-burst-")) {
    return { region: normalized.slice("aws-burst-".length), providerFromRegion: "aws-burst" };
  }
  if (normalized.startsWith("aws-")) {
    return { region: normalized.slice("aws-".length), providerFromRegion: "aws" };
  }
  return { region: normalized };
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
