import { Arker, ArkerError, type ArkerOptions } from "../index.js";
import { Sandbox } from "./sandbox.js";
import {
  type CreateSandboxFromImageParams,
  type CreateSandboxFromSnapshotParams,
  type DaytonaConfig,
  DaytonaValidationError,
  PaginatedSandboxes,
  translateArkerError,
} from "./types.js";

const DEFAULT_TEMPLATE_ENV = "ARKER_DAYTONA_DEFAULT_TEMPLATE";
const DEFAULT_TEMPLATE = "base";

function resolveTemplate(template?: string): string {
  if (template) return template;
  if (typeof process !== "undefined") {
    return process.env[DEFAULT_TEMPLATE_ENV] ?? DEFAULT_TEMPLATE;
  }
  return DEFAULT_TEMPLATE;
}

function buildArkerOptions(config: DaytonaConfig | undefined): ArkerOptions {
  const out: ArkerOptions = {};
  if (config?.apiKey) out.apiKey = config.apiKey;
  if (config?.target && config.target !== "us" && config.target !== "eu") {
    out.region = config.target;
  }
  return out;
}

function isSnapshotParams(value: unknown): value is CreateSandboxFromSnapshotParams {
  return typeof value === "object" && value !== null && "snapshot" in (value as object);
}

function isImageParams(value: unknown): value is CreateSandboxFromImageParams {
  return typeof value === "object" && value !== null && "image" in (value as object);
}

/** Legacy keyword-style options accepted alongside the params object. */
export interface LegacyCreateOpts {
  image?: string;
  snapshot?: string;
  name?: string;
  env?: Record<string, string>;
  envVars?: Record<string, string>;
  labels?: Record<string, string>;
}

export class Daytona {
  private readonly arker: Arker;
  private readonly config: DaytonaConfig;

  constructor(config: DaytonaConfig | undefined = undefined, opts: { _arker?: Arker } = {}) {
    this.config = config ?? {};
    this.arker = opts._arker ?? new Arker(buildArkerOptions(this.config));
  }

  /**
   * Fork an Arker VM. Canonical daytona form takes a params object:
   *
   *   daytona.create({ snapshot: "py-base", envVars: { K: "V" } } as CreateSandboxFromSnapshotParams)
   *
   * Legacy keyword form is also supported for back-compat with Phase A.
   */
  async create(
    paramsOrOpts?: CreateSandboxFromSnapshotParams | CreateSandboxFromImageParams | LegacyCreateOpts,
  ): Promise<Sandbox> {
    let snapshot: string | undefined;
    let image: string | undefined;
    let name: string | undefined;
    const envVars: Record<string, string> = {};
    const labels: Record<string, string> = {};

    if (isSnapshotParams(paramsOrOpts)) {
      snapshot = paramsOrOpts.snapshot;
      name = paramsOrOpts.name;
      Object.assign(envVars, paramsOrOpts.envVars ?? {});
      Object.assign(labels, paramsOrOpts.labels ?? {});
    } else if (isImageParams(paramsOrOpts)) {
      image = paramsOrOpts.image;
      name = paramsOrOpts.name;
      Object.assign(envVars, paramsOrOpts.envVars ?? {});
      Object.assign(labels, paramsOrOpts.labels ?? {});
    } else if (paramsOrOpts != null) {
      const legacy = paramsOrOpts as LegacyCreateOpts;
      snapshot = legacy.snapshot;
      image = legacy.image;
      name = legacy.name;
      Object.assign(envVars, legacy.envVars ?? legacy.env ?? {});
      Object.assign(labels, legacy.labels ?? {});
    }

    const source = resolveTemplate(snapshot ?? image);
    try {
      const computer = await this.arker.vm(source).fork(name ? { name } : {});
      return new Sandbox(this.arker, computer, { env: envVars, labels, snapshot: source });
    } catch (error) {
      throw translateArkerError(error);
    }
  }

  async get(sandboxId: string): Promise<Sandbox> {
    if (!sandboxId) throw new DaytonaValidationError("sandboxId is required");
    try {
      const info = (await this.arker.get(sandboxId)) as { source_golden?: string; state?: string };
      return new Sandbox(this.arker, this.arker.vm(sandboxId), {
        snapshot: info.source_golden,
        info,
      });
    } catch (error) {
      throw translateArkerError(error);
    }
  }

  /**
   * Returns a `PaginatedSandboxes` wrapper. Daytona stores labels server-side
   * and filters there; Arker doesn't, so the `labels` arg is currently ignored.
   * `page`/`limit` paginate client-side.
   */
  async list(opts: { labels?: Record<string, string>; page?: number; limit?: number } = {}): Promise<PaginatedSandboxes<Sandbox>> {
    if (opts.labels && Object.keys(opts.labels).length > 0) {
      throw new DaytonaValidationError(
        "Daytona.list({ labels }) is not supported by the arker.daytona shim — " +
          "Arker doesn't store sandbox metadata server-side. Filter client-side after list().",
      );
    }
    if (opts.page !== undefined && opts.page < 1) {
      throw new DaytonaValidationError("page must be >= 1");
    }
    if (opts.limit !== undefined && opts.limit < 1) {
      throw new DaytonaValidationError("limit must be >= 1");
    }

    let vms: Array<{ vm_id?: string; source_golden?: string; state?: string }> = [];
    try {
      const response = (await this.arker.list()) as { vms?: Array<{ vm_id?: string; source_golden?: string; state?: string }> };
      vms = response.vms ?? [];
    } catch (error) {
      throw translateArkerError(error);
    }

    const sandboxes = vms
      .filter((vm) => typeof vm.vm_id === "string")
      .map((vm) =>
        new Sandbox(this.arker, this.arker.vm(vm.vm_id!), {
          snapshot: vm.source_golden ?? undefined,
          info: vm,
        }),
      );
    const total = sandboxes.length;
    const limit = opts.limit && opts.limit > 0 ? opts.limit : total || 1;
    const page = opts.page && opts.page > 0 ? opts.page : 1;
    const start = (page - 1) * limit;
    const items = sandboxes.slice(start, start + limit);
    const totalPages = Math.max(1, Math.ceil(total / limit));
    return new PaginatedSandboxes(items, total, page, totalPages);
  }

  /** Daytona-canonical: take the Sandbox object. Routes through
   * `Sandbox.delete()` so callers get the same typed error. */
  async delete(sandbox: Sandbox, timeout: number = 60): Promise<void> {
    await sandbox.delete(timeout);
  }

  async start(_sandbox: Sandbox, _timeout: number = 60): Promise<void> {
    // No-op: Arker VMs are running on fork.
  }

  async stop(_sandbox: Sandbox, _timeout: number = 60): Promise<void> {
    // No-op: Arker has no stopped state.
  }

  /** @deprecated Not in upstream daytona; use `Daytona.delete(sandbox)`. */
  async remove(sandboxId: string): Promise<void> {
    try {
      await this.arker.vm(sandboxId).delete();
    } catch (error) {
      throw translateArkerError(error);
    }
  }

  async close(): Promise<void> {
    // no-op
  }
}
