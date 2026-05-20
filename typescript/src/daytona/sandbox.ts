import { Arker, ArkerError, type Computer } from "../index.js";
import { FileSystem } from "./files.js";
import { Process } from "./process.js";
import { SandboxState } from "./types.js";

export interface SandboxConstructorOpts {
  env?: Record<string, string>;
  labels?: Record<string, string>;
  snapshot?: string;
}

/** daytona.Sandbox drop-in, backed by an Arker `Computer`. */
export class Sandbox {
  readonly _arker: Arker;
  readonly _computer: Computer;
  readonly _env: Record<string, string>;
  private _labels: Record<string, string>;
  private _snapshotId?: string;

  readonly process: Process;
  readonly fs: FileSystem;

  constructor(arker: Arker, computer: Computer, opts: SandboxConstructorOpts = {}) {
    this._arker = arker;
    this._computer = computer;
    this._env = { ...(opts.env ?? {}) };
    this._labels = { ...(opts.labels ?? {}) };
    this._snapshotId = opts.snapshot;
    this.process = new Process(this);
    this.fs = new FileSystem(this);
  }

  get id(): string {
    return this._computer.id;
  }

  get env(): Record<string, string> {
    return { ...this._env };
  }

  get labels(): Record<string, string> {
    return { ...this._labels };
  }

  async getState(): Promise<SandboxState> {
    try {
      const info = (await this._arker.get(this._computer.id)) as { state?: string };
      if (info.state === "running") return SandboxState.Started;
      if (info.state === "stopped") return SandboxState.Stopped;
      return SandboxState.Error;
    } catch (error) {
      if (error instanceof ArkerError) return SandboxState.Error;
      throw error;
    }
  }

  async getSnapshot(): Promise<string | null> {
    if (this._snapshotId != null) return this._snapshotId;
    try {
      const info = (await this._arker.get(this._computer.id)) as { source_golden?: string };
      return info.source_golden ?? null;
    } catch {
      return null;
    }
  }

  get user(): string {
    return "user";
  }

  get target(): string {
    return this._arker.region ?? "";
  }

  // ---- Lifecycle ----

  async delete(): Promise<void> {
    try {
      await this._computer.delete();
    } catch (error) {
      if (!(error instanceof ArkerError)) throw error;
    }
  }

  async start(): Promise<void> {
    // No-op: Arker VMs are running on fork.
  }

  async stop(): Promise<void> {
    // No-op: Arker has no stopped state.
  }

  async archive(): Promise<void> {
    // No-op.
  }

  // ---- Configuration ----

  setLabels(labels: Record<string, string>): Record<string, string> {
    this._labels = { ...labels };
    return { ...this._labels };
  }

  getUserHomeDir(): string {
    return "/home/user";
  }

  getWorkDir(): string {
    return "/home/user";
  }

  async refreshData(): Promise<void> {
    // Arker has no batched-refresh equivalent; properties read live.
  }
}
