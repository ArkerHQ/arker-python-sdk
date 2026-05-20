import { Arker, ArkerError, type Computer } from "../index.js";
import { FileSystem } from "./files.js";
import { Process } from "./process.js";
import { SandboxState, translateArkerError } from "./types.js";

export interface SandboxConstructorOpts {
  env?: Record<string, string>;
  labels?: Record<string, string>;
  snapshot?: string;
  /** Optional VmInfo-shaped payload from a `arker.get(...)` / list response.
   * If provided, `state` and `snapshot` are populated from it — no extra HTTP. */
  info?: { state?: string; source_golden?: string };
}

function arkerStateToSandboxState(state: string | undefined): SandboxState {
  if (state === "running") return SandboxState.Started;
  if (state === "stopped") return SandboxState.Stopped;
  if (state === "creating" || state === "starting") return SandboxState.Starting;
  if (state === "error") return SandboxState.Error;
  return SandboxState.Unknown;
}

/** daytona.Sandbox drop-in, backed by an Arker `Computer`. Properties are
 * plain assignable fields; reading them doesn't issue HTTP. */
export class Sandbox {
  readonly _arker: Arker;
  readonly _computer: Computer;
  readonly _env: Record<string, string>;
  readonly id: string;
  labels: Record<string, string>;
  snapshot?: string;
  state: SandboxState;
  user = "user";
  public = false;
  readonly target: string;

  readonly process: Process;
  readonly fs: FileSystem;

  constructor(arker: Arker, computer: Computer, opts: SandboxConstructorOpts = {}) {
    this._arker = arker;
    this._computer = computer;
    this._env = { ...(opts.env ?? {}) };
    this.id = computer.id;
    this.labels = { ...(opts.labels ?? {}) };
    this.snapshot = opts.snapshot;
    this.state = SandboxState.Unknown;
    this.target = arker.region ?? "";

    if (opts.info) {
      this.state = arkerStateToSandboxState(opts.info.state);
      if (this.snapshot == null && typeof opts.info.source_golden === "string") {
        this.snapshot = opts.info.source_golden;
      }
    }

    this.process = new Process(this);
    this.fs = new FileSystem(this);
  }

  /** Reads `env` for parity with daytona's assignable-attribute pattern. */
  get env(): Record<string, string> {
    return this._env;
  }

  // Lazy getters retained for back-compat with Phase E test code.
  async getState(): Promise<SandboxState> {
    await this.refreshData();
    return this.state;
  }

  async getSnapshot(): Promise<string | null> {
    if (this.snapshot != null) return this.snapshot;
    try {
      const info = (await this._arker.get(this._computer.id)) as { source_golden?: string };
      this.snapshot = info.source_golden;
      return info.source_golden ?? null;
    } catch {
      return null;
    }
  }

  // ---- Lifecycle ----

  async delete(_timeout: number = 60): Promise<void> {
    try {
      await this._computer.delete();
    } catch (error) {
      throw translateArkerError(error);
    }
    this.state = SandboxState.Destroyed;
  }

  async start(): Promise<void> { /* no-op: Arker VMs run on fork */ }
  async stop(): Promise<void> { /* no-op: Arker has no stopped state */ }
  async archive(): Promise<void> { /* no-op */ }

  // ---- Configuration ----

  setLabels(labels: Record<string, string>): Record<string, string> {
    this.labels = { ...labels };
    return { ...this.labels };
  }

  getUserHomeDir(): string {
    return "/home/user";
  }

  getWorkDir(): string {
    return "/home/user";
  }

  async refreshData(): Promise<void> {
    try {
      const info = (await this._arker.get(this._computer.id)) as { state?: string; source_golden?: string };
      this.state = arkerStateToSandboxState(info.state);
      if (this.snapshot == null && typeof info.source_golden === "string") {
        this.snapshot = info.source_golden;
      }
    } catch (error) {
      if (error instanceof ArkerError) throw translateArkerError(error);
      throw error;
    }
  }
}
