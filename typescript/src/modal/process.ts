import type { RunStatusResponse } from "../index.js";
import type { Sandbox } from "./sandbox.js";
import { InvalidError, translateArkerError } from "./types.js";

const POLL_BASE_MS = 200;
const POLL_MAX_MS = 1_000;

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

function nextDelay(last: number): number {
  return Math.min(POLL_MAX_MS, Math.max(POLL_BASE_MS, last * 1.5));
}

function decode(bytes: Uint8Array): string {
  return new TextDecoder("utf-8", { fatal: false }).decode(bytes);
}

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

/** Map Arker's exit_code into modal's `128 + signal` encoding. Negative
 * exit codes (Python/Go subprocess convention for signal kills) become the
 * positive form modal returns; null/undefined → -1. */
export function normalizeReturncode(raw: number | null | undefined): number {
  if (raw == null) return -1;
  if (raw < 0) return 128 + Math.abs(raw);
  return raw;
}

function readStream(status: RunStatusResponse, which: "stdout" | "stderr"): Uint8Array {
  const s = status as Record<string, unknown>;
  const value = s[which];
  const encoding = s[`${which}_encoding`];
  return decodeStreamBytes(value, encoding);
}

/** Poll-based stream reader. `read()` blocks until the process finishes;
 * `for await` yields lines as they appear per poll cycle. */
export class StreamReader {
  private readonly proc: ContainerProcess;
  private readonly which: "stdout" | "stderr";
  private readonly text: boolean;
  private cursor = 0;

  constructor(proc: ContainerProcess, which: "stdout" | "stderr", text: boolean) {
    this.proc = proc;
    this.which = which;
    this.text = text;
  }

  async read(): Promise<string | Uint8Array> {
    await this.proc.wait();
    const snap = await this.proc._snapshot();
    const data = snap[this.which];
    return this.text ? decode(data) : data;
  }

  async *[Symbol.asyncIterator](): AsyncIterableIterator<string | Uint8Array> {
    let delay = POLL_BASE_MS;
    let buffer = new Uint8Array();
    while (true) {
      const snap = await this.proc._snapshot();
      const stream = snap[this.which];
      const newSlice = stream.subarray(this.cursor);
      this.cursor = stream.length;
      if (newSlice.length > 0) {
        const merged = new Uint8Array(buffer.length + newSlice.length);
        merged.set(buffer);
        merged.set(newSlice, buffer.length);
        buffer = merged;
        let nl = buffer.indexOf(0x0a);
        while (nl !== -1) {
          const line = buffer.subarray(0, nl + 1);
          buffer = buffer.subarray(nl + 1);
          yield this.text ? decode(line) : line;
          nl = buffer.indexOf(0x0a);
        }
      }
      if (snap.completed) {
        if (buffer.length > 0) yield this.text ? decode(buffer) : buffer;
        return;
      }
      await sleep(delay);
      delay = nextDelay(delay);
    }
  }
}

/** Placeholder for `process.stdin`. Arker has no non-PTY stdin primitive. */
export class StreamWriter {
  async write(_data: Uint8Array): Promise<void> {
    throw new Error("arker.modal: ContainerProcess.stdin.write is not supported — Arker has no non-PTY stdin primitive.");
  }
  async drain(): Promise<void> {
    throw new Error("arker.modal: ContainerProcess.stdin.drain is not supported.");
  }
  async writeEof(): Promise<void> {
    throw new Error("arker.modal: ContainerProcess.stdin.writeEof is not supported.");
  }
}

export class ContainerProcess {
  private readonly sbx: Sandbox;
  private readonly runId: string;
  private readonly text: boolean;
  private _returncode: number | null = null;
  // `Uint8Array` without an explicit ArrayBuffer parameter — Buffer.from()
  // returns Uint8Array<ArrayBufferLike> under newer @types/node strict typing.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private finalStdout: any = new Uint8Array();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private finalStderr: any = new Uint8Array();

  readonly stdout: StreamReader;
  readonly stderr: StreamReader;
  readonly stdin: StreamWriter;

  constructor(sbx: Sandbox, runId: string, text: boolean) {
    this.sbx = sbx;
    this.runId = runId;
    this.text = text;
    this.stdout = new StreamReader(this, "stdout", text);
    this.stderr = new StreamReader(this, "stderr", text);
    this.stdin = new StreamWriter();
  }

  /** Matches modal: throws InvalidError until `.wait()` resolves.
   * Use `.poll()` for the non-throwing check that returns null while running. */
  get returncode(): number {
    if (this._returncode === null) {
      throw new InvalidError(
        "You must call wait() before accessing the returncode. " +
          "To poll for the status of a running process, use poll() instead.",
      );
    }
    return this._returncode;
  }

  async poll(): Promise<number | null> {
    if (this._returncode !== null) return this._returncode;
    let status: RunStatusResponse;
    try {
      status = await this.sbx._computer.runStatus(this.runId);
    } catch (error) {
      throw translateArkerError(error);
    }
    this.finalStdout = readStream(status, "stdout");
    this.finalStderr = readStream(status, "stderr");
    if ((status as { completed?: boolean }).completed) {
      this._returncode = normalizeReturncode((status as { exit_code?: number | null }).exit_code);
    }
    return this._returncode;
  }

  async wait(): Promise<number> {
    let delay = POLL_BASE_MS;
    while ((await this.poll()) === null) {
      await sleep(delay);
      delay = nextDelay(delay);
    }
    return this._returncode!;
  }

  async kill(): Promise<void> {
    try {
      await this.sbx._computer.cancelRun(this.runId);
    } catch {
      // Ignore: process may already be gone.
    }
  }

  async terminate(): Promise<void> {
    await this.kill();
  }

  /** @internal poll status snapshot for the StreamReader. */
  async _snapshot(): Promise<{ stdout: Uint8Array; stderr: Uint8Array; completed: boolean }> {
    if (this._returncode !== null) {
      return { stdout: this.finalStdout, stderr: this.finalStderr, completed: true };
    }
    let status: RunStatusResponse;
    try {
      status = await this.sbx._computer.runStatus(this.runId);
    } catch (error) {
      throw translateArkerError(error);
    }
    const completed = !!(status as { completed?: boolean }).completed;
    const stdoutBytes = readStream(status, "stdout");
    const stderrBytes = readStream(status, "stderr");
    if (completed && this._returncode === null) {
      this._returncode = normalizeReturncode((status as { exit_code?: number | null }).exit_code);
      this.finalStdout = stdoutBytes;
      this.finalStderr = stderrBytes;
    }
    return { stdout: stdoutBytes, stderr: stderrBytes, completed };
  }
}
