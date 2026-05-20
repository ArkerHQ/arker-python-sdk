import type { PtyRunResult } from "../index.js";
import { CommandHandle } from "./handle.js";
import type { Sandbox } from "./sandbox.js";
import type { PtySize } from "./types.js";

function randomSessionId(): string {
  const bytes = new Uint8Array(8);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

export class Pty {
  private readonly sbx: Sandbox;

  constructor(sbx: Sandbox) {
    this.sbx = sbx;
  }

  async create(_size: PtySize, opts: { timeout?: number } = {}): Promise<CommandHandle> {
    const sessionId = randomSessionId();
    const result = (await this.sbx._computer.run("/bin/bash", {
      session_id: sessionId,
      timeout: opts.timeout,
    })) as PtyRunResult;
    if (result.type !== "pty") {
      throw new Error(`pty.create expected PtyRunResult, got ${result.type}`);
    }
    const pid = this.sbx._registerRun(sessionId, "/bin/bash");
    return new CommandHandle(this.sbx, pid, sessionId, "/bin/bash");
  }

  async sendStdin(_pid: number, _data: Uint8Array): Promise<void> {
    // WS not wired up yet — input dropped; silent so existing code doesn't crash.
  }

  async resize(_pid: number, _size: PtySize): Promise<void> {
    // WS not wired up yet — silent no-op.
  }

  async kill(pid: number): Promise<boolean> {
    // Sessions are deleted via /v1/vms/{id}/sessions/{sid}, not exposed by SDK
    // yet. Local-only cleanup; real remote cancel lands with WS support.
    this.sbx._forgetPid(pid);
    return true;
  }
}
