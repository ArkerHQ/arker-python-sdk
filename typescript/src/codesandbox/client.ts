import { Arker, ArkerError, type ArkerOptions } from "../index.js";
import { Sandbox } from "./sandbox.js";
import {
  CodeSandboxError,
  type SandboxInfo,
  type SandboxListResponse,
  translateArkerError,
} from "./types.js";

const DEFAULT_TEMPLATE_ENV = "ARKER_CODESANDBOX_DEFAULT_TEMPLATE";
const DEFAULT_TEMPLATE = "base";

function resolveTemplate(id?: string): string {
  if (id) return id;
  if (typeof process !== "undefined") return process.env[DEFAULT_TEMPLATE_ENV] ?? DEFAULT_TEMPLATE;
  return DEFAULT_TEMPLATE;
}

export interface CreateSandboxOpts {
  id?: string;
  title?: string;
  description?: string;
  tags?: string[];
  privacy?: string;
  path?: string;
}

export interface ListOpts {
  tags?: string[];
  limit?: number;
  pagination?: { page?: number; pageSize?: number };
  orderBy?: string;
  direction?: "asc" | "desc";
  status?: string;
}

function parseDate(value: unknown): Date | null {
  if (typeof value !== "string" || !value) return null;
  const d = new Date(value);
  return isNaN(d.getTime()) ? null : d;
}

function _vmToInfo(vm: { vm_id?: string; name?: string; created_at?: string; last_activity?: string }): SandboxInfo {
  return {
    id: String(vm.vm_id ?? ""),
    title: vm.name ?? null,
    description: null,
    tags: [],
    privacy: "public-hosts",
    createdAt: parseDate(vm.created_at),
    updatedAt: parseDate(vm.last_activity),
  };
}

export interface CodeSandboxOpts {
  /** Inject a pre-built Arker for tests. */
  _arker?: Arker;
}

function buildArker(apiToken?: string): Arker {
  const opts: ArkerOptions = {};
  if (apiToken) opts.apiKey = apiToken;
  return new Arker(opts);
}

export class Sandboxes {
  readonly _arker: Arker;

  constructor(arker: Arker) {
    this._arker = arker;
  }

  get defaultTemplateId(): string {
    return resolveTemplate();
  }

  async create(opts: CreateSandboxOpts = {}): Promise<Sandbox> {
    const template = resolveTemplate(opts.id);
    if (opts.privacy && opts.privacy !== "public-hosts") {
      // eslint-disable-next-line no-console
      console.warn(
        `arker.codesandbox: sandboxes.create({privacy: ${JSON.stringify(opts.privacy)}}) is not enforced — ` +
          `Arker doesn't store per-VM privacy. The sandbox is accessible to anyone with the VM id. ` +
          `Set up network policies on Arker if you need access control.`,
      );
    }
    try {
      const computer = await this._arker.vm(template).fork(opts.title ? { name: opts.title } : {});
      return new Sandbox(this._arker, computer, "FORK", this._arker.region ?? "");
    } catch (error) {
      throw translateArkerError(error);
    }
  }

  /** Returns SandboxInfo (matches @codesandbox/sdk). For a connectable
   * Sandbox handle, use `resume(id)`. */
  async get(sandboxId: string): Promise<SandboxInfo> {
    if (!sandboxId) throw new CodeSandboxError("sandbox_id is required");
    try {
      const info = (await this._arker.get(sandboxId)) as {
        vm_id?: string;
        name?: string;
        created_at?: string;
        last_activity?: string;
      };
      return _vmToInfo(info);
    } catch (error) {
      throw translateArkerError(error);
    }
  }

  async resume(sandboxId: string): Promise<Sandbox> {
    if (!sandboxId) throw new CodeSandboxError("sandbox_id is required");
    try {
      await this._arker.get(sandboxId);
    } catch (error) {
      throw translateArkerError(error);
    }
    return new Sandbox(this._arker, this._arker.vm(sandboxId), "RESUME", this._arker.region ?? "");
  }

  async restart(sandboxId: string, _opts?: unknown): Promise<Sandbox> {
    if (!sandboxId) throw new CodeSandboxError("sandbox_id is required");
    try {
      await this._arker.get(sandboxId);
    } catch (error) {
      throw translateArkerError(error);
    }
    return new Sandbox(this._arker, this._arker.vm(sandboxId), "CLEAN", this._arker.region ?? "");
  }

  /** No-op + warn — Arker has no hibernate primitive. */
  async hibernate(_sandboxId: string): Promise<void> {
    // eslint-disable-next-line no-console
    console.warn(
      "arker.codesandbox: sandboxes.hibernate() is a no-op — Arker has no VM hibernate primitive.",
    );
  }

  /** No-op + warn — Arker has no stop-without-delete primitive. */
  async shutdown(_sandboxId: string): Promise<void> {
    // eslint-disable-next-line no-console
    console.warn(
      "arker.codesandbox: sandboxes.shutdown() is a no-op — Arker has no stop-without-delete primitive. " +
        "Use delete() to destroy the VM.",
    );
  }

  async delete(sandboxId: string): Promise<void> {
    if (!sandboxId) throw new CodeSandboxError("sandbox_id is required");
    try {
      await this._arker.vm(sandboxId).delete();
    } catch (error) {
      throw translateArkerError(error);
    }
  }

  async list(opts: ListOpts = {}): Promise<SandboxListResponse> {
    if (opts.tags && opts.tags.length > 0) {
      throw new CodeSandboxError(
        "arker.codesandbox: sandboxes.list({tags}) is not supported — Arker doesn't store sandbox tags server-side.",
      );
    }
    for (const k of ["status", "orderBy", "direction"] as const) {
      if (opts[k]) {
        throw new CodeSandboxError(
          `arker.codesandbox: sandboxes.list({${k}}) is not supported — ` +
            `Arker's list endpoint doesn't honor it.`,
        );
      }
    }
    let vms: Array<{ vm_id?: string; name?: string; created_at?: string; last_activity?: string }> = [];
    try {
      const response = (await this._arker.list()) as { vms?: typeof vms };
      vms = response.vms ?? [];
    } catch (error) {
      if (!(error instanceof ArkerError)) throw error;
      return {
        sandboxes: [],
        totalCount: 0,
        pagination: { currentPage: 1, nextPage: null, pageSize: opts.limit ?? 50 },
        hasMore: false,
      };
    }
    const infos: SandboxInfo[] = vms
      .filter((vm) => typeof vm.vm_id === "string")
      .map(_vmToInfo);
    const total = infos.length;
    const page = Math.max(1, opts.pagination?.page ?? 1);
    const pageSize = Math.max(1, opts.pagination?.pageSize ?? opts.limit ?? 50);
    const start = (page - 1) * pageSize;
    const end = start + pageSize;
    const items = infos.slice(start, end);
    const nextPage = end < total ? page + 1 : null;
    return {
      sandboxes: items,
      totalCount: total,
      pagination: { currentPage: page, nextPage, pageSize },
      hasMore: end < total,
    };
  }

  /** @deprecated alias for `create({ id })`. */
  async fork(sandboxId: string, opts: CreateSandboxOpts = {}): Promise<Sandbox> {
    // eslint-disable-next-line no-console
    console.warn(
      "sandboxes.fork() is deprecated in @codesandbox/sdk; use sandboxes.create({ id }).",
    );
    return this.create({ ...opts, id: sandboxId });
  }
}

export class CodeSandbox {
  readonly sandboxes: Sandboxes;
  readonly hosts: Record<string, unknown>;

  constructor(apiToken?: string, opts: CodeSandboxOpts = {}) {
    const arker = opts._arker ?? buildArker(apiToken);
    this.sandboxes = new Sandboxes(arker);
    this.hosts = new Proxy({}, {
      get(_t, prop) {
        throw new Error(
          `arker.codesandbox: CodeSandbox.hosts.${String(prop)} is not supported — ` +
            `host tokens are codesandbox auth-server primitives.`,
        );
      },
    });
  }
}
