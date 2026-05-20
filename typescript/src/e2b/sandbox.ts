import { Arker, ArkerError, type ArkerOptions, type Computer } from "../index.js";
import { Commands } from "./commands.js";
import { Filesystem } from "./files.js";
import { Pty } from "./pty.js";

const DEFAULT_TEMPLATE_ENV = "ARKER_E2B_DEFAULT_TEMPLATE";
const DEFAULT_TEMPLATE = "ubuntu";

function resolveTemplate(template?: string): string {
  if (template) return template;
  if (typeof process !== "undefined") {
    return process.env[DEFAULT_TEMPLATE_ENV] ?? DEFAULT_TEMPLATE;
  }
  return DEFAULT_TEMPLATE;
}

export interface SandboxOptions {
  /** Override the default template. Defaults to $ARKER_E2B_DEFAULT_TEMPLATE or "ubuntu". */
  template?: string;
  /** Attach to an existing Arker VM instead of forking a new one. */
  sandboxId?: string;
  /** Sandbox-wide env vars merged into every commands.run call. */
  envs?: Record<string, string>;
  /** Sandbox lifetime hint (seconds). Stored locally; Arker has no SDK-level TTL yet. */
  timeout?: number;
  /** Free-form metadata. `metadata.name` is used as the new VM's display name. */
  metadata?: Record<string, string>;
  /** Forwarded to the underlying `Arker` client. Falls back to env vars. */
  apiKey?: string;
  /** Forwarded to the underlying `Arker` client. */
  region?: string;
  /** Forwarded to the underlying `Arker` client. */
  baseUrl?: string;
  /** Used by unit tests; pass a pre-constructed Arker. */
  _arker?: Arker;
  /** Used by unit tests; pass a pre-constructed Computer (bypasses fork). */
  _computer?: Computer;
}

/**
 * e2b.Sandbox drop-in, backed by Arker.
 *
 * Construct via `await Sandbox.create({ template })` to keep the fork call
 * async (the underlying Arker SDK is async-only). The synchronous `new
 * Sandbox()` constructor is reserved for the `_computer` test-injection path.
 */
export class Sandbox {
  readonly _arker: Arker;
  readonly _computer: Computer;
  readonly _defaultEnvs: Record<string, string>;
  readonly _bgRuns = new Map<number, { runId: string; cmd: string }>();
  _nextPid = 1;

  readonly commands: Commands;
  readonly files: Filesystem;
  readonly pty: Pty;

  protected constructor(arker: Arker, computer: Computer, envs: Record<string, string>) {
    this._arker = arker;
    this._computer = computer;
    this._defaultEnvs = envs;
    this.commands = new Commands(this);
    this.files = new Filesystem(this);
    this.pty = new Pty(this);
  }

  get sandboxId(): string {
    return this._computer.id;
  }

  static async create(opts: SandboxOptions = {}): Promise<Sandbox> {
    const arker = opts._arker ?? new Arker(buildArkerOptions(opts));
    let computer: Computer;
    if (opts._computer) {
      computer = opts._computer;
    } else if (opts.sandboxId) {
      computer = arker.vm(opts.sandboxId);
    } else {
      const source = resolveTemplate(opts.template);
      const name = opts.metadata?.name;
      computer = await arker.vm(source).fork(name ? { name } : {});
    }
    return new Sandbox(arker, computer, { ...(opts.envs ?? {}) });
  }

  static async connect(sandboxId: string, opts: Omit<SandboxOptions, "sandboxId"> = {}): Promise<Sandbox> {
    return Sandbox.create({ ...opts, sandboxId });
  }

  async kill(): Promise<boolean> {
    try {
      const r = await this._computer.delete();
      return !!r.deleted;
    } catch (error) {
      if (error instanceof ArkerError) return false;
      throw error;
    }
  }

  async isRunning(): Promise<boolean> {
    try {
      const info = (await this._arker.get(this._computer.id)) as { state?: string };
      return info.state === "running";
    } catch (error) {
      if (error instanceof ArkerError) return false;
      throw error;
    }
  }

  /** Sandbox lifetime hint. Stored locally — Arker has no SDK-level VM TTL yet. */
  setTimeout(_timeout: number): void {
    this._timeoutValue = _timeout;
  }

  get timeout(): number | undefined {
    return this._timeoutValue;
  }

  private _timeoutValue?: number;

  _registerRun(runId: string, cmd: string): number {
    const pid = this._nextPid++;
    this._bgRuns.set(pid, { runId, cmd });
    return pid;
  }

  _runIdFor(pid: number): string | undefined {
    return this._bgRuns.get(pid)?.runId;
  }

  _forgetPid(pid: number): void {
    this._bgRuns.delete(pid);
  }
}

function buildArkerOptions(opts: SandboxOptions): ArkerOptions {
  const out: ArkerOptions = {};
  if (opts.apiKey) out.apiKey = opts.apiKey;
  if (opts.region) out.region = opts.region;
  if (opts.baseUrl) out.baseUrl = opts.baseUrl;
  return out;
}
