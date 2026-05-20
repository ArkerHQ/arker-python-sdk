import { Arker, ArkerError, type ArkerOptions } from "../index.js";
import { Sandbox } from "./sandbox.js";
import { type DaytonaConfig, SandboxNotFoundError } from "./types.js";

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
  // daytona's `target` is "us"/"eu" (cluster) or a region; if it looks like a
  // region (e.g. "aws-us-west-2"), forward it.
  if (config?.target && config.target !== "us" && config.target !== "eu") {
    out.region = config.target;
  }
  return out;
}

export interface CreateOpts {
  image?: string;
  name?: string;
  env?: Record<string, string>;
  labels?: Record<string, string>;
  /** Test escape: inject a pre-constructed Arker client. */
  _arker?: Arker;
}

export class Daytona {
  private readonly arker: Arker;
  private readonly config: DaytonaConfig;

  constructor(config: DaytonaConfig | undefined = undefined, opts: { _arker?: Arker } = {}) {
    this.config = config ?? {};
    this.arker = opts._arker ?? new Arker(buildArkerOptions(this.config));
  }

  async create(opts: CreateOpts = {}): Promise<Sandbox> {
    const source = resolveTemplate(opts.image);
    const name = opts.name;
    const computer = await this.arker.vm(source).fork(name ? { name } : {});
    return new Sandbox(this.arker, computer, {
      env: opts.env,
      labels: opts.labels,
      snapshot: source,
    });
  }

  async get(sandboxId: string): Promise<Sandbox> {
    try {
      const info = (await this.arker.get(sandboxId)) as { source_golden?: string };
      return new Sandbox(this.arker, this.arker.vm(sandboxId), { snapshot: info.source_golden });
    } catch (error) {
      if (error instanceof ArkerError) {
        throw new SandboxNotFoundError(`sandbox ${sandboxId}: ${error.message}`);
      }
      throw error;
    }
  }

  async list(): Promise<Sandbox[]> {
    try {
      const response = (await this.arker.list()) as { vms?: Array<{ vm_id?: string; source_golden?: string }> };
      const vms = response.vms ?? [];
      return vms
        .filter((vm) => typeof vm.vm_id === "string")
        .map((vm) =>
          new Sandbox(this.arker, this.arker.vm(vm.vm_id!), { snapshot: vm.source_golden ?? undefined }),
        );
    } catch (error) {
      if (error instanceof ArkerError) return [];
      throw error;
    }
  }

  async find(filters: { id?: string; name?: string; snapshot?: string }): Promise<Sandbox | null> {
    const list = await this.list();
    for (const sbx of list) {
      if (filters.id != null && sbx.id !== filters.id) continue;
      if (filters.name != null) {
        try {
          const info = (await this.arker.get(sbx.id)) as { name?: string };
          if (info.name !== filters.name) continue;
        } catch {
          continue;
        }
      }
      if (filters.snapshot != null) {
        const snap = await sbx.getSnapshot();
        if (snap !== filters.snapshot) continue;
      }
      return sbx;
    }
    return null;
  }

  async remove(sandboxId: string): Promise<void> {
    try {
      await this.arker.vm(sandboxId).delete();
    } catch (error) {
      if (error instanceof ArkerError) {
        throw new SandboxNotFoundError(`sandbox ${sandboxId}: ${error.message}`);
      }
      throw error;
    }
  }

  /** Symmetry with daytona's API; nothing to release on our side (the
   * underlying Arker client uses global `fetch`). */
  async close(): Promise<void> {
    // no-op
  }
}
