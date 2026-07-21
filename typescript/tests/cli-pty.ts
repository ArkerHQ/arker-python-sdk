import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { bridgePty, type PtyBridgeRuntime } from "../src/cli-pty.js";
import type { PtyCloseEvent, PtyConnection, PtyInput } from "../src/index.js";

class FakePty implements PtyConnection {
  readonly sessionId = "session_1";
  readonly ready: Promise<void>;
  private readonly events = new EventEmitter();

  constructor(ready: Promise<void> = Promise.resolve()) {
    this.ready = ready;
  }

  onData(listener: (data: Uint8Array) => void): () => void {
    this.events.on("data", listener);
    return () => this.events.off("data", listener);
  }

  onClose(listener: (event: PtyCloseEvent) => void): () => void {
    this.events.on("close", listener);
    return () => this.events.off("close", listener);
  }

  onError(listener: (error: unknown) => void): () => void {
    this.events.on("error", listener);
    return () => this.events.off("error", listener);
  }

  send(_data: PtyInput): void {}
  resize(_cols: number, _rows: number): void {}
  kill(): void {}
  close(_code?: number, _reason?: string): void {}

  emitClose(event: PtyCloseEvent): void { this.events.emit("close", event); }
  emitError(error: unknown): void { this.events.emit("error", error); }
}

function runtime(): { value: PtyBridgeRuntime; errors: string[] } {
  const input = new PassThrough() as PassThrough & { isTTY?: boolean; isRaw?: boolean; setRawMode?: (enabled: boolean) => void };
  input.isTTY = false;
  const output = new PassThrough() as PassThrough & { columns?: number; rows?: number; isTTY?: boolean };
  const signals = new EventEmitter();
  const errors: string[] = [];
  return {
    value: {
      input,
      output,
      signals,
      reportError: (message) => { errors.push(message); },
    },
    errors,
  };
}

async function testAbnormalCloseFails(): Promise<void> {
  const pty = new FakePty();
  const rt = runtime();
  const result = bridgePty(pty, { fallbackCols: 80, fallbackRows: 24, autoResize: false }, rt.value);
  await pty.ready;
  pty.emitClose({ code: 1011, reason: "transport failed" });
  assert.equal(await result, 1);
  assert.deepEqual(rt.errors, ["pty closed abnormally (1011): transport failed"]);
}

async function testPostOpenErrorFails(): Promise<void> {
  const pty = new FakePty();
  const rt = runtime();
  const result = bridgePty(pty, { fallbackCols: 80, fallbackRows: 24, autoResize: false }, rt.value);
  await pty.ready;
  pty.emitError(new Error("socket reset"));
  assert.equal(await result, 1);
  assert.deepEqual(rt.errors, ["pty error: socket reset"]);
}

async function testNormalCloseSucceeds(): Promise<void> {
  const pty = new FakePty();
  const rt = runtime();
  const result = bridgePty(pty, { fallbackCols: 80, fallbackRows: 24, autoResize: false }, rt.value);
  await pty.ready;
  pty.emitClose({ code: 1000, reason: "normal" });
  assert.equal(await result, 0);
  assert.deepEqual(rt.errors, []);
}

async function testOpenFailureFails(): Promise<void> {
  const pty = new FakePty(Promise.reject(new Error("upgrade rejected")));
  const rt = runtime();
  const result = bridgePty(pty, { fallbackCols: 80, fallbackRows: 24, autoResize: false }, rt.value);
  assert.equal(await result, 1);
  assert.deepEqual(rt.errors, ["pty failed to open: upgrade rejected"]);
}

await testAbnormalCloseFails();
await testPostOpenErrorFails();
await testNormalCloseSucceeds();
await testOpenFailureFails();

console.log("PASS cli pty");
