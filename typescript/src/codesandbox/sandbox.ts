import { Arker, type Computer } from "../index.js";
import { SandboxClient } from "./sandbox-client.js";
import type { BootupType } from "./types.js";

/** Drop-in for `@codesandbox/sdk` Sandbox. */
export class Sandbox {
  readonly _arker: Arker;
  readonly _computer: Computer;
  readonly id: string;
  readonly bootupType: BootupType;
  readonly cluster: string;
  readonly isUpToDate: boolean;
  private _hibernationTimeoutSeconds?: number;

  constructor(
    arker: Arker,
    computer: Computer,
    bootupType: BootupType = "FORK",
    cluster: string = "",
  ) {
    this._arker = arker;
    this._computer = computer;
    this.id = computer.id;
    this.bootupType = bootupType;
    this.cluster = cluster;
    this.isUpToDate = true;
  }

  /** Live VM-tier rescale isn't supported — Arker has no equivalent. */
  async updateTier(_tier: unknown): Promise<void> {
    throw new Error(
      "arker.codesandbox: Sandbox.updateTier is not supported — Arker has no live VM-tier rescale.",
    );
  }

  /** Stored locally — Arker has no server-side hibernation. Silent success
   * (matches codesandbox, which also doesn't warn). */
  async updateHibernationTimeout(timeoutSeconds: number): Promise<void> {
    this._hibernationTimeoutSeconds = timeoutSeconds;
  }

  async connect(_customSession?: unknown): Promise<SandboxClient> {
    return new SandboxClient(this);
  }
}
