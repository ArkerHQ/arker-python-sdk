import { CommandHandle } from "./handle.js";
import type { Sandbox } from "./sandbox.js";
import type { PtySize } from "./types.js";

const UNSUPPORTED =
  "arker.e2b.pty is not supported yet — Arker exposes PTY over WebSocket " +
  "(`wsUrl` on the run response) but the SDK has no WS client. Use " +
  "commands.run for non-interactive work, or wait for the WS upgrade.";

/**
 * `sandbox.pty` namespace.
 *
 * All methods throw — interactive PTY needs a WebSocket client we haven't
 * shipped yet. Loud failure keeps callers from silently dropping input.
 */
export class Pty {
  constructor(_sbx: Sandbox) {}

  async create(_size: PtySize, _opts: { timeout?: number } = {}): Promise<CommandHandle> {
    throw new Error(UNSUPPORTED);
  }

  async sendStdin(_pid: number, _data: Uint8Array): Promise<void> {
    throw new Error(UNSUPPORTED);
  }

  async resize(_pid: number, _size: PtySize): Promise<void> {
    throw new Error(UNSUPPORTED);
  }

  async kill(_pid: number): Promise<boolean> {
    throw new Error(UNSUPPORTED);
  }
}
