import type { RunStatusResponse } from "../index.js";
import type { Sandbox } from "./sandbox.js";
import { CommandExitException, type CommandResult } from "./types.js";

const POLL_BASE_MS = 200;
const POLL_MAX_MS = 1_000;

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

function nextDelay(last: number): number {
  return Math.min(POLL_MAX_MS, Math.max(POLL_BASE_MS, last * 1.5));
}

function decode(bytes: Uint8Array): string {
  return new TextDecoder("utf-8", { fatal: false }).decode(bytes);
}

/** Decode the OpenAPI run-status `stdout`/`stderr` fields (string + encoding) into bytes. */
function decodeStreamBytes(value: unknown, encoding: unknown): Uint8Array {
  if (value instanceof Uint8Array) return value;
  if (typeof value !== "string") return new Uint8Array();
  if (encoding === "base64") {
    if (typeof Buffer !== "undefined") return new Uint8Array(Buffer.from(value, "base64"));
    const binary = atob(value);
    const out = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
    return out;
  }
  return new TextEncoder().encode(value);
}

function readStdout(status: RunStatusResponse): Uint8Array {
  const s = status as { stdout: unknown; stdout_encoding?: unknown };
  return decodeStreamBytes(s.stdout, s.stdout_encoding);
}

function readStderr(status: RunStatusResponse): Uint8Array {
  const s = status as { stderr: unknown; stderr_encoding?: unknown };
  return decodeStreamBytes(s.stderr, s.stderr_encoding);
}

function statusToResult(status: RunStatusResponse): CommandResult {
  return {
    stdout: decode(readStdout(status)),
    stderr: decode(readStderr(status)),
    exitCode: (status as { exit_code?: number }).exit_code ?? -1,
  };
}

export interface WaitOptions {
  onStdout?: (chunk: string) => void;
  onStderr?: (chunk: string) => void;
}

/**
 * Handle for a background run. Live-streaming is approximated by polling
 * `runStatus` and yielding deltas — true streaming requires WS support.
 *
 * TODO(arker-e2b): per-line streaming via the `ws_url` Arker returns from
 * `run`. Needs a WS client in core SDK. See pending-work item #3 in
 * index.ts.
 */
export class CommandHandle {
  readonly pid: number;
  private readonly sbx: Sandbox;
  private readonly runId: string;
  private readonly cmd: string;
  private stdoutEmitted = 0;
  private stderrEmitted = 0;

  constructor(sbx: Sandbox, pid: number, runId: string, cmd: string) {
    this.sbx = sbx;
    this.pid = pid;
    this.runId = runId;
    this.cmd = cmd;
  }

  async wait(opts: WaitOptions = {}): Promise<CommandResult> {
    let delay = POLL_BASE_MS;
    let last: RunStatusResponse | undefined;
    while (true) {
      const status = await this.sbx._computer.runStatus(this.runId);
      this.fireDeltas(status, opts);
      if ((status as { completed?: boolean }).completed) {
        last = status;
        break;
      }
      await sleep(delay);
      delay = nextDelay(delay);
    }
    const result = statusToResult(last!);
    if (result.exitCode !== 0) throw new CommandExitException(result);
    return result;
  }

  async kill(): Promise<boolean> {
    try {
      const r = await this.sbx._computer.cancelRun(this.runId);
      return !!r.cancelled;
    } finally {
      this.sbx._forgetPid(this.pid);
    }
  }

  disconnect(): void {
    this.sbx._forgetPid(this.pid);
  }

  async *iter(): AsyncIterableIterator<string> {
    let delay = POLL_BASE_MS;
    while (true) {
      const status = await this.sbx._computer.runStatus(this.runId);
      const stdout = readStdout(status);
      const newOut = stdout.subarray(this.stdoutEmitted);
      if (newOut.length > 0) {
        this.stdoutEmitted = stdout.length;
        yield decode(newOut);
      }
      if ((status as { completed?: boolean }).completed) return;
      await sleep(delay);
      delay = nextDelay(delay);
    }
  }

  [Symbol.asyncIterator](): AsyncIterableIterator<string> {
    return this.iter();
  }

  private fireDeltas(status: RunStatusResponse, opts: WaitOptions): void {
    const stdout = readStdout(status);
    const stderr = readStderr(status);
    if (opts.onStdout) {
      const d = stdout.subarray(this.stdoutEmitted);
      if (d.length > 0) opts.onStdout(decode(d));
    }
    if (opts.onStderr) {
      const d = stderr.subarray(this.stderrEmitted);
      if (d.length > 0) opts.onStderr(decode(d));
    }
    this.stdoutEmitted = stdout.length;
    this.stderrEmitted = stderr.length;
  }
}
