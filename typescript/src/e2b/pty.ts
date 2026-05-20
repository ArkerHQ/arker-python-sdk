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
 *
 * TODO(arker-e2b): wire real PTY when core SDK ships a WS helper.
 * Includes session-delete (`DELETE /v1/vms/{id}/sessions/{sid}`) so
 * `pty.kill` cleans up server-side. See pending-work item #4 in index.ts.
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
