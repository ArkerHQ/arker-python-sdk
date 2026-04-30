/**
 * Arker SDK — TypeScript client.
 *
 * Quickstart:
 *
 *   import { Arker } from "@arker/sdk";
 *   const arker = new Arker({ apiKey: "ark_live_..." });
 *   const vm    = await arker.vm("arkuntu").fork({ name: "hello" });
 *
 *   const result = await vm.run("echo hi");
 *   console.log(new TextDecoder().decode(result.stdout)); // → "hi\n"
 *
 *   await vm.sync.writeFile("/home/user/data.bin", new Uint8Array([1, 2, 3]));
 *   const blob = await vm.sync.readFile("/home/user/data.bin");
 *
 *   const child = await vm.fork({ name: "branch" });
 *   await child.delete();
 *   await vm.delete();
 *
 *   // List your VMs (paginated):
 *   const page = await arker.list({ limit: 10 });
 *   for (const summary of page.items) {
 *     console.log(summary.vm_id, summary.name, summary.created_at);
 *   }
 *
 * Errors are thrown as `ArkerError(code, message, status)`.
 */

export const DEFAULT_BASE_URL = "https://aws-us-west-2.burst.arker.ai";
/** `list` is served from a different host than the rest; used regardless of the client's baseUrl. */
export const LIST_BASE_URL = "https://arker.ai";
/** Public base-image aliases resolved client-side so `vm("arkuntu").fork()` works on the default endpoint. */
export const SOURCE_ALIASES: Record<string, string> = {
  arkuntu: "01KQBYKEV5WJ7YB010603T1DCT_d8c0",
};
/** Files above this size go through a direct upload path. */
export const CHUNK_SIZE = 4 * 1024 * 1024;
const PRESIGN_PUT_TIMEOUT_MS = 600_000;
const RETRYABLE_HTTP = new Set([429, 502, 503, 504]);
/** Substring matches in `error.message` that mark a transient failure. */
const TRANSIENT_HINTS = ["503", "Service Unavailable", "throttle", "SlowDown", "ThrottlingException"];
const MAX_ATTEMPTS = 4;
const BACKOFF_MS = 200;
const ULID_ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

// ─── Types ───────────────────────────────────────────────────────────

export interface ArkerOptions {
  apiKey: string;
  baseUrl?: string;
}

export interface ForkOptions {
  name?: string;
  isPublic?: boolean;
  region?: string;
}

export interface RunOptions {
  sessionId?: string | number;
  timeout?: number;
}

export interface RunResult {
  stdout: Uint8Array;
  stderr: Uint8Array;
  exitCode: number;
  durationMs: number;
  sessionId: string;
  cwd: string;
}

export interface VmSummary {
  vm_id: string;
  name: string | null;
  base_image: string;
  region: string;
  /** ISO 8601 UTC. */
  created_at: string;
}

export interface VmList {
  items: VmSummary[];
  /** Total matching the query, ignoring limit/offset. */
  total: number;
}

export interface ListOptions {
  limit?: number;
  offset?: number;
  q?: string;
  /** `created_at` | `-created_at` | `region` | `-region`. Default `-created_at`. */
  sort?: string;
}

interface ErrorEnvelope {
  code?: string;
  message?: string;
}

// ─── Error type ──────────────────────────────────────────────────────

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

// ─── Helpers ─────────────────────────────────────────────────────────

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const jitterMs = () => Math.floor(Math.random() * 50);

/** 26-char Crockford-base32 ULID. */
function ulid(): string {
  const time = BigInt(Date.now()) & ((1n << 48n) - 1n);
  const rand = new Uint8Array(10);
  crypto.getRandomValues(rand);
  let raw = (time << 80n) | rand.reduce((acc, b) => (acc << 8n) | BigInt(b), 0n);
  const out: string[] = [];
  for (let i = 0; i < 26; i++) {
    out.push(ULID_ALPHABET[Number(raw & 31n)]!);
    raw >>= 5n;
  }
  return out.reverse().join("");
}

function looksLikeVmId(s: string): boolean {
  let head = s;
  if (s.includes("_")) {
    const [h, ...rest] = s.split("_");
    const tail = rest.join("_");
    if (!tail || !/^[A-Za-z0-9]+$/.test(tail)) return false;
    head = h!;
  }
  if (head.length !== 26) return false;
  return [...head.toUpperCase()].every((c) => ULID_ALPHABET.includes(c));
}

function decodeStream(text: unknown, encoding: unknown): Uint8Array {
  const s = typeof text === "string" ? text : "";
  if (encoding === "base64") {
    try {
      const bin = atob(s);
      const out = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
      return out;
    } catch {
      /* fall through */
    }
  }
  return new TextEncoder().encode(s);
}

function bytesToBase64(data: Uint8Array): string {
  let bin = "";
  for (let i = 0; i < data.length; i++) bin += String.fromCharCode(data[i]!);
  return btoa(bin);
}

function isTransient(err: ErrorEnvelope | null | undefined): boolean {
  if (!err || err.code !== "internal") return false;
  const msg = err.message ?? "";
  return TRANSIENT_HINTS.some((h) => msg.includes(h));
}

// ─── Client ──────────────────────────────────────────────────────────

export class Arker {
  private readonly apiKey: string;
  private readonly baseUrl: string;

  constructor(opts: ArkerOptions) {
    if (!opts.apiKey) throw new Error("apiKey is required");
    this.apiKey = opts.apiKey;
    const base = opts.baseUrl ?? process.env.ARKER_BASE_URL ?? DEFAULT_BASE_URL;
    this.baseUrl = base.replace(/\/+$/, "");
  }

  /** @internal */
  async _request<T = any>(
    method: string,
    path: string,
    body?: unknown,
    overrideBaseUrl?: string,
  ): Promise<T> {
    const url = (overrideBaseUrl ? overrideBaseUrl.replace(/\/+$/, "") : this.baseUrl) + path;
    const headers: Record<string, string> = {
      authorization: `Bearer ${this.apiKey}`,
      "content-type": "application/json",
    };

    let lastStatus = 0;
    let lastErr: ErrorEnvelope | null = null;
    let lastText = "";

    for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
      const resp = await fetch(url, {
        method,
        headers,
        body: body !== undefined ? JSON.stringify(body) : undefined,
      });
      const text = await resp.text();
      let payload: any = null;
      try {
        payload = text ? JSON.parse(text) : {};
      } catch {
        payload = null;
      }
      lastStatus = resp.status;
      lastText = text;

      const envelopeErr =
        payload && typeof payload === "object" && payload.ok === false
          ? (payload.error as ErrorEnvelope)
          : null;
      lastErr = envelopeErr;

      if (RETRYABLE_HTTP.has(resp.status) || isTransient(envelopeErr)) {
        if (attempt === MAX_ATTEMPTS - 1) break;
        await sleep(BACKOFF_MS * 2 ** attempt + jitterMs());
        continue;
      }
      if (envelopeErr) {
        throw new ArkerError(envelopeErr.code ?? "internal", envelopeErr.message ?? "", resp.status);
      }
      if (resp.status >= 400) {
        throw new ArkerError("internal", text.slice(0, 200) || "request failed", resp.status);
      }
      return payload as T;
    }

    if (lastErr) {
      throw new ArkerError(lastErr.code ?? "internal", lastErr.message ?? "", lastStatus);
    }
    throw new ArkerError("internal", lastText.slice(0, 200) || "no response", lastStatus);
  }

  /** Open a handle to a VM by ULID *or* template name. No network call. */
  vm(vmId: string): Computer {
    return new Computer(this, vmId);
  }

  /** List VMs in the caller's organization. Always hits `https://arker.ai`. */
  async list(opts: ListOptions = {}): Promise<VmList> {
    const params = new URLSearchParams();
    if (opts.limit !== undefined && opts.limit !== 25) params.set("limit", String(opts.limit));
    if (opts.offset !== undefined && opts.offset !== 0) params.set("offset", String(opts.offset));
    if (opts.q !== undefined) params.set("q", opts.q);
    if (opts.sort !== undefined) params.set("sort", opts.sort);
    const qs = params.toString();
    const path = "/api/v1/vms/list" + (qs ? `?${qs}` : "");
    const r = await this._request<{ items: VmSummary[]; total: number }>("GET", path, undefined, LIST_BASE_URL);
    return { items: r.items ?? [], total: r.total ?? 0 };
  }
}

// ─── VM handle ──────────────────────────────────────────────────────

export class Computer {
  readonly id: string;
  readonly sync: Sync;
  /** @internal */
  readonly _client: Arker;

  constructor(client: Arker, vmId: string) {
    this._client = client;
    this.id = vmId;
    this.sync = new Sync(this);
  }

  async delete(): Promise<void> {
    await this._client._request("DELETE", `/api/v1/vms/${this.id}`);
  }

  /** Fork this VM. Aliases like `"arkuntu"` resolve client-side. */
  async fork(opts: ForkOptions = {}): Promise<Computer> {
    const body: Record<string, unknown> = { is_public: opts.isPublic ?? false };
    if (opts.name !== undefined) body.name = opts.name;
    if (opts.region !== undefined) body.region = opts.region;

    const resolved = SOURCE_ALIASES[this.id] ?? this.id;
    let r: { vm_id?: string };
    if (looksLikeVmId(resolved)) {
      r = await this._client._request("POST", `/api/v1/vms/${resolved}/fork`, body);
    } else {
      // Unknown name; let the global host resolve it.
      body.from = this.id;
      r = await this._client._request("POST", "/api/v1/vms/fork", body, LIST_BASE_URL);
    }
    if (!r.vm_id) throw new ArkerError("internal", "fork response missing vm_id", 200);
    return new Computer(this._client, r.vm_id);
  }

  async run(command: string, opts: RunOptions = {}): Promise<RunResult> {
    const body: Record<string, unknown> = {
      command,
      session_id: opts.sessionId ?? 0,
    };
    if (opts.timeout !== undefined) body.timeout = opts.timeout;
    const r = await this._client._request<any>("POST", `/api/v1/vms/${this.id}/run`, body);
    return {
      stdout: decodeStream(r.stdout, r.stdout_encoding),
      stderr: decodeStream(r.stderr, r.stderr_encoding),
      exitCode: Number(r.exit_code ?? 0),
      durationMs: Number(r.duration_ms ?? 0),
      sessionId: String(r.session_id ?? ""),
      cwd: String(r.cwd ?? ""),
    };
  }
}

// ─── File I/O ───────────────────────────────────────────────────────

export class Sync {
  /** @internal */
  readonly _vm: Computer;

  constructor(vm: Computer) {
    this._vm = vm;
  }

  private path(): string {
    return `/api/v1/vms/${this._vm.id}/sync`;
  }

  async readFile(path: string): Promise<Uint8Array> {
    const r = await this._vm._client._request<any>("POST", this.path(), { op: "read", path });
    if (r.content !== undefined && r.content !== null) {
      return decodeStream(r.content, r.encoding);
    }
    if (r.presigned_url) {
      const resp = await fetch(r.presigned_url);
      if (!resp.ok) {
        throw new ArkerError("internal", `signed GET failed: ${resp.status}`, resp.status);
      }
      return new Uint8Array(await resp.arrayBuffer());
    }
    throw new ArkerError("internal", "read response missing content/presigned_url", 200);
  }

  async writeFile(path: string, data: Uint8Array | string): Promise<void> {
    const bytes = typeof data === "string" ? new TextEncoder().encode(data) : data;
    if (!bytes.length) throw new ArkerError("bad_request", "writeFile: empty data", 400);
    if (bytes.length <= CHUNK_SIZE) {
      await this.fastPath(path, bytes);
    } else {
      await this.presignedPath(path, bytes);
    }
  }

  private async fastPath(path: string, data: Uint8Array): Promise<void> {
    const size = data.length;
    const result = await this.sendOneWrite({
      path,
      size,
      upload_id: ulid(),
      start: 0,
      end: size,
      content: bytesToBase64(data),
    });
    if (!(result.complete && result.written)) {
      throw new ArkerError("internal", "fast-path write returned without complete+written", 200);
    }
  }

  private async presignedPath(path: string, data: Uint8Array): Promise<void> {
    const size = data.length;
    // Step 1 — request signed upload URL.
    const e1 = await this.sendOneWrite({ path, size, presigned: true });
    const url: string = e1.presigned_url;
    const uploadId: string = e1.upload_id;
    // Step 2 — direct PUT, retry transient HTTP statuses.
    for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
      const ctrl = new AbortController();
      const t = setTimeout(() => ctrl.abort(), PRESIGN_PUT_TIMEOUT_MS);
      try {
        const resp = await fetch(url, { method: "PUT", body: data as BodyInit, signal: ctrl.signal });
        clearTimeout(t);
        if (resp.ok) break;
        if (!RETRYABLE_HTTP.has(resp.status) || attempt === MAX_ATTEMPTS - 1) {
          throw new ArkerError("internal", `upload PUT failed: ${resp.status}`, resp.status);
        }
        await sleep(BACKOFF_MS * 2 ** attempt);
      } catch (err) {
        clearTimeout(t);
        if (err instanceof ArkerError) throw err;
        if (attempt === MAX_ATTEMPTS - 1) {
          throw new ArkerError("internal", `upload PUT failed: ${(err as Error).message}`, 0);
        }
        await sleep(BACKOFF_MS * 2 ** attempt);
      }
    }
    // Step 3 — commit.
    await this.sendOneWrite({ path, size, upload_id: uploadId });
  }

  private async sendOneWrite(entry: Record<string, unknown>): Promise<any> {
    let lastErr: ErrorEnvelope | null = null;
    for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
      const r = await this._vm._client._request<any>("POST", this.path(), {
        op: "write",
        writes: [entry],
      });
      const result = (r.results ?? [null])[0];
      if (!result) throw new ArkerError("internal", "write response missing results[0]", 200);
      const err: ErrorEnvelope | null = result.error ?? null;
      if (!err) return result;
      lastErr = err;
      if (!isTransient(err) || attempt === MAX_ATTEMPTS - 1) break;
      await sleep(BACKOFF_MS * 2 ** attempt + jitterMs());
    }
    throw new ArkerError(lastErr?.code ?? "internal", lastErr?.message ?? "write failed", 200);
  }
}
