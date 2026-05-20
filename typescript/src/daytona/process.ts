import { ArkerError, type BackgroundRunResult, type CompletedRunResult } from "../index.js";
import type { Sandbox } from "./sandbox.js";
import {
  type CodeRunParams,
  type Command,
  type ExecuteResponse,
  ProcessError,
  type Session,
  type SessionCommandLogsResponse,
  type SessionExecuteRequest,
  type SessionExecuteResponse,
  SessionNotFoundError,
  translateArkerError,
} from "./types.js";

const LANGUAGE_RUNTIME: Record<string, [string, string]> = {
  python: ["python3", "py"],
  python3: ["python3", "py"],
  javascript: ["node", "js"],
  js: ["node", "js"],
  node: ["node", "js"],
  ts: ["ts-node", "ts"],
  typescript: ["ts-node", "ts"],
  bash: ["bash", "sh"],
  sh: ["bash", "sh"],
  ruby: ["ruby", "rb"],
};

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`;
}

export function wrapCommand(cmd: string, cwd?: string, env?: Record<string, string>): string {
  const parts: string[] = [];
  if (cwd) parts.push(`cd ${shellQuote(cwd)} &&`);
  if (env && Object.keys(env).length > 0) {
    parts.push("env");
    for (const [k, v] of Object.entries(env)) {
      parts.push(`${shellQuote(k)}=${shellQuote(v)}`);
    }
  }
  parts.push(cmd);
  return parts.join(" ");
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

function randHex(n: number): string {
  const bytes = new Uint8Array(n);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

export interface ExecOpts {
  cwd?: string;
  env?: Record<string, string>;
  timeout?: number;
}

function resolveRunAsync(req: SessionExecuteRequest): boolean {
  // Accept all three field names daytona's API has used over time.
  return req.async ?? req.runAsync ?? req.varAsync ?? false;
}

export class Process {
  private readonly sbx: Sandbox;
  private readonly sessions = new Map<string, Command[]>();
  private readonly commandLogs = new Map<string, SessionCommandLogsResponse>();

  constructor(sbx: Sandbox) {
    this.sbx = sbx;
  }

  async exec(command: string, opts: ExecOpts = {}): Promise<ExecuteResponse> {
    const mergedEnv = { ...this.sbx._env, ...(opts.env ?? {}) };
    const wrapped = wrapCommand(command, opts.cwd, mergedEnv);
    let result: CompletedRunResult;
    try {
      result = (await this.sbx._computer.run(wrapped, { timeout: opts.timeout })) as CompletedRunResult;
    } catch (error) {
      throw translateArkerError(error);
    }
    if (result.type !== "completed") {
      throw new ProcessError(`unexpected run type ${result.type}`);
    }
    const stdout = decode(result.stdout);
    return {
      exitCode: result.exitCode,
      result: stdout,
      artifacts: { stdout, charts: [] },
    };
  }

  async codeRun(code: string, params?: CodeRunParams, timeout?: number): Promise<ExecuteResponse> {
    const [interp, ext] = LANGUAGE_RUNTIME["python"]!;
    const scratch = `/tmp/arker-daytona-${randHex(8)}.${ext}`;
    try {
      await this.sbx._computer.sync.writeFile(scratch, code);
    } catch (error) {
      throw translateArkerError(error);
    }
    try {
      const argv = params?.argv?.map(shellQuote).join(" ") ?? "";
      const extraEnv = params?.env ?? {};
      let cmd = `${interp} ${shellQuote(scratch)}`;
      if (argv) cmd = `${cmd} ${argv}`;
      return await this.exec(cmd, { env: extraEnv, timeout });
    } finally {
      try {
        await this.sbx._computer.run(`rm -f ${shellQuote(scratch)}`);
      } catch {
        // best-effort cleanup
      }
    }
  }

  // ---- Sessions ----

  createSession(sessionId: string): void {
    if (!this.sessions.has(sessionId)) this.sessions.set(sessionId, []);
  }

  async listSessions(): Promise<Session[]> {
    let remoteIds = new Set<string>();
    try {
      const info = (await this.sbx._arker.get(this.sbx._computer.id)) as {
        sessions?: Array<{ session_id?: string }>;
      };
      for (const s of info.sessions ?? []) {
        if (typeof s.session_id === "string") remoteIds.add(s.session_id);
      }
    } catch {
      remoteIds = new Set();
    }
    const sids = new Set<string>([...remoteIds, ...this.sessions.keys()]);
    return Array.from(sids).map((sid) => ({
      sessionId: sid,
      commands: [...(this.sessions.get(sid) ?? [])],
    }));
  }

  async getSession(sessionId: string): Promise<Session> {
    const list = await this.listSessions();
    const found = list.find((s) => s.sessionId === sessionId);
    if (!found) throw new SessionNotFoundError(`session ${sessionId} not found`);
    return found;
  }

  /** Mirror daytona: raise on missing session. Local-bookkeeping only until
   * the Arker SDK exposes DELETE /v1/vms/{id}/sessions/{sid}. */
  deleteSession(sessionId: string): void {
    if (!this.sessions.has(sessionId)) {
      throw new SessionNotFoundError(`session ${sessionId} not found`);
    }
    this.sessions.delete(sessionId);
  }

  async executeSessionCommand(
    sessionId: string,
    req: SessionExecuteRequest,
    timeout?: number,
  ): Promise<SessionExecuteResponse> {
    if (!this.sessions.has(sessionId)) this.sessions.set(sessionId, []);
    const runAsync = resolveRunAsync(req);

    let result;
    try {
      result = await this.sbx._computer.run(req.command, {
        ...(runAsync ? { background: true } : {}),
        session_id: sessionId,
        timeout,
      });
    } catch (error) {
      throw translateArkerError(error);
    }

    if (runAsync) {
      const bg = result as BackgroundRunResult;
      if (bg.type !== "background") {
        throw new ProcessError(`async session run returned ${bg.type}`);
      }
      this.sessions.get(sessionId)!.push({ id: bg.runId, command: req.command, exitCode: null });
      // Daytona coerces None → "" — keep strings non-null so len(...) doesn't crash.
      return {
        cmdId: bg.runId,
        exitCode: null,
        output: "",
        stdout: "",
        stderr: "",
      };
    }

    const completed = result as CompletedRunResult;
    if (completed.type !== "completed") {
      throw new ProcessError(`sync session run returned ${completed.type}`);
    }
    const cmdId = randHex(8);
    const stdout = decode(completed.stdout);
    const stderr = decode(completed.stderr);
    const output = stdout + stderr;
    this.commandLogs.set(cmdId, { output, stdout, stderr });
    this.sessions.get(sessionId)!.push({
      id: cmdId,
      command: req.command,
      exitCode: completed.exitCode,
    });
    return { cmdId, exitCode: completed.exitCode, output, stdout, stderr };
  }

  getSessionCommand(sessionId: string, commandId: string): Command {
    const commands = this.sessions.get(sessionId);
    if (!commands) throw new SessionNotFoundError(`session ${sessionId} not found`);
    const cmd = commands.find((c) => c.id === commandId);
    if (!cmd) throw new SessionNotFoundError(`command ${commandId} not found in session ${sessionId}`);
    return cmd;
  }

  async getSessionCommandLogs(_sessionId: string, commandId: string): Promise<SessionCommandLogsResponse> {
    const cached = this.commandLogs.get(commandId);
    if (cached) return cached;
    let status;
    try {
      status = await this.sbx._computer.runStatus(commandId);
    } catch (error) {
      throw new SessionNotFoundError(`command ${commandId} not found: ${(error as Error).message}`);
    }
    const stdout = decode(decodeStreamBytes(
      (status as { stdout: unknown }).stdout,
      (status as { stdout_encoding?: unknown }).stdout_encoding,
    ));
    const stderr = decode(decodeStreamBytes(
      (status as { stderr: unknown }).stderr,
      (status as { stderr_encoding?: unknown }).stderr_encoding,
    ));
    return { output: stdout + stderr, stdout, stderr };
  }

  // ---- Not implemented (loud) ----

  async getEntrypointSession(): Promise<Session> {
    throw new Error(
      "arker.daytona: process.getEntrypointSession is not implemented — " +
        "Arker has no entrypoint-session concept.",
    );
  }

  async getEntrypointLogs(): Promise<SessionCommandLogsResponse> {
    throw new Error("arker.daytona: process.getEntrypointLogs is not implemented.");
  }

  async getEntrypointLogsAsync(..._args: unknown[]): Promise<void> {
    throw new Error("arker.daytona: process.getEntrypointLogsAsync is not implemented.");
  }

  async getSessionCommandLogsAsync(..._args: unknown[]): Promise<void> {
    throw new Error(
      "arker.daytona: process.getSessionCommandLogsAsync is not implemented — needs WS streaming.",
    );
  }

  async sendSessionCommandInput(..._args: unknown[]): Promise<void> {
    throw new Error(
      "arker.daytona: process.sendSessionCommandInput is not implemented — no non-PTY stdin primitive.",
    );
  }

  // ---- PTY sessions (need WS) ----

  private readonly ptyUnsupported = (): never => {
    throw new Error("arker.daytona: PTY sessions require a WebSocket client we haven't shipped yet.");
  };

  async createPtySession(..._args: unknown[]): Promise<never> { return this.ptyUnsupported(); }
  async connectPtySession(..._args: unknown[]): Promise<never> { return this.ptyUnsupported(); }
  async listPtySessions(): Promise<never> { return this.ptyUnsupported(); }
  async getPtySessionInfo(..._args: unknown[]): Promise<never> { return this.ptyUnsupported(); }
  async killPtySession(..._args: unknown[]): Promise<never> { return this.ptyUnsupported(); }
  async resizePtySession(..._args: unknown[]): Promise<never> { return this.ptyUnsupported(); }

  // Use ArkerError import to satisfy TS (re-exporting helper).
  static _arkerErrorTag = ArkerError;
}
