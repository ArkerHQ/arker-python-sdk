import type { BackgroundRunResult, CompletedRunResult } from "../index.js";
import type { Sandbox } from "./sandbox.js";
import {
  type Command,
  type CodeRunParams,
  type ExecuteResponse,
  ProcessError,
  type Session,
  type SessionCommandLogsResponse,
  type SessionExecuteRequest,
  type SessionExecuteResponse,
  SessionNotFoundError,
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

export class Process {
  private readonly sbx: Sandbox;
  /** Tracked sessions (Arker creates them on first run; we mirror state). */
  private readonly sessions = new Map<string, { commands: Command[] }>();
  /** Foreground command-log cache: cmdId -> logs. */
  private readonly commandLogs = new Map<string, SessionCommandLogsResponse>();

  constructor(sbx: Sandbox) {
    this.sbx = sbx;
  }

  async exec(command: string, opts: ExecOpts = {}): Promise<ExecuteResponse> {
    const mergedEnv = { ...this.sbx._env, ...(opts.env ?? {}) };
    const wrapped = wrapCommand(command, opts.cwd, mergedEnv);
    const result = (await this.sbx._computer.run(wrapped, {
      timeout: opts.timeout,
    })) as CompletedRunResult;
    if (result.type !== "completed") {
      throw new ProcessError(`unexpected run type ${result.type}`);
    }
    const stdout = decode(result.stdout);
    return {
      exitCode: result.exitCode,
      result: stdout,
      artifacts: { stdout, charts: null },
    };
  }

  async codeRun(code: string, params?: CodeRunParams, timeout?: number): Promise<ExecuteResponse> {
    const [interp, ext] = LANGUAGE_RUNTIME["python"]!;
    const scratch = `/tmp/arker-daytona-${randHex(8)}.${ext}`;
    await this.sbx._computer.sync.writeFile(scratch, code);
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
    if (!this.sessions.has(sessionId)) this.sessions.set(sessionId, { commands: [] });
  }

  async listSessions(): Promise<Session[]> {
    let remote: Record<string, { state?: string; cwd?: string }> = {};
    try {
      const info = (await this.sbx._arker.get(this.sbx._computer.id)) as {
        sessions?: Array<{ session_id?: string; state?: string; cwd?: string }>;
      };
      for (const s of info.sessions ?? []) {
        if (typeof s.session_id === "string") {
          remote[s.session_id] = { state: s.state, cwd: s.cwd };
        }
      }
    } catch {
      remote = {};
    }
    const sids = new Set<string>([...Object.keys(remote), ...this.sessions.keys()]);
    return Array.from(sids).map((sid) => ({
      sessionId: sid,
      state: remote[sid]?.state ?? "unknown",
      cwd: remote[sid]?.cwd ?? "/home/user",
      commands: this.sessions.get(sid)?.commands ?? [],
    }));
  }

  async getSession(sessionId: string): Promise<Session> {
    const list = await this.listSessions();
    const found = list.find((s) => s.sessionId === sessionId);
    if (!found) throw new SessionNotFoundError(`session ${sessionId} not found`);
    return found;
  }

  /** Local-only — Arker's session-delete isn't exposed by the SDK yet.
   * TODO(arker-daytona): wire to DELETE /v1/vms/{id}/sessions/{sid}. */
  deleteSession(sessionId: string): void {
    this.sessions.delete(sessionId);
  }

  async executeSessionCommand(
    sessionId: string,
    req: SessionExecuteRequest,
    timeout?: number,
  ): Promise<SessionExecuteResponse> {
    const wrapped = wrapCommand(req.command, req.cwd, req.env);
    if (!this.sessions.has(sessionId)) this.sessions.set(sessionId, { commands: [] });
    const asyncRun = req.async ?? req.runAsync ?? false;

    if (asyncRun) {
      const result = (await this.sbx._computer.run(wrapped, {
        background: true,
        session_id: sessionId,
        timeout,
      })) as BackgroundRunResult;
      if (result.type !== "background") {
        throw new ProcessError(`async session run returned ${result.type}`);
      }
      const cmdId = result.runId;
      this.sessions.get(sessionId)!.commands.push({ id: cmdId, command: req.command, exitCode: null });
      return { cmdId, output: null, exitCode: null };
    }

    const result = (await this.sbx._computer.run(wrapped, {
      session_id: sessionId,
      timeout,
    })) as CompletedRunResult;
    if (result.type !== "completed") {
      throw new ProcessError(`sync session run returned ${result.type}`);
    }
    const cmdId = randHex(8);
    const stdout = decode(result.stdout);
    const stderr = decode(result.stderr);
    this.commandLogs.set(cmdId, { stdout, stderr, exitCode: result.exitCode });
    this.sessions.get(sessionId)!.commands.push({
      id: cmdId,
      command: req.command,
      exitCode: result.exitCode,
    });
    return { cmdId, output: stdout, exitCode: result.exitCode };
  }

  getSessionCommand(sessionId: string, commandId: string): Command {
    const sess = this.sessions.get(sessionId);
    if (!sess) throw new SessionNotFoundError(`session ${sessionId} not found`);
    const cmd = sess.commands.find((c) => c.id === commandId);
    if (!cmd) throw new SessionNotFoundError(`command ${commandId} not found in session ${sessionId}`);
    return cmd;
  }

  async getSessionCommandLogs(sessionId: string, commandId: string): Promise<SessionCommandLogsResponse> {
    const cached = this.commandLogs.get(commandId);
    if (cached) return cached;
    // Background path: commandId == runId; poll once.
    const status = await this.sbx._computer.runStatus(commandId).catch((error) => {
      throw new SessionNotFoundError(`command ${commandId} not found: ${(error as Error).message}`);
    });
    const stdout = decode(decodeStreamBytes(
      (status as { stdout: unknown }).stdout,
      (status as { stdout_encoding?: unknown }).stdout_encoding,
    ));
    const stderr = decode(decodeStreamBytes(
      (status as { stderr: unknown }).stderr,
      (status as { stderr_encoding?: unknown }).stderr_encoding,
    ));
    return { stdout, stderr, exitCode: (status as { exit_code?: number | null }).exit_code ?? null };
  }

  // ---- Not implemented (loud) ----

  async getEntrypointSession(): Promise<Session> {
    throw new Error(
      "arker.daytona: process.getEntrypointSession is not implemented — " +
        "Arker has no entrypoint-session concept; use createSession + executeSessionCommand.",
    );
  }

  async getEntrypointLogs(): Promise<SessionCommandLogsResponse> {
    throw new Error("arker.daytona: process.getEntrypointLogs is not implemented (no entrypoint session).");
  }

  async getEntrypointLogsAsync(..._args: unknown[]): Promise<void> {
    throw new Error("arker.daytona: process.getEntrypointLogsAsync is not implemented.");
  }

  async getSessionCommandLogsAsync(..._args: unknown[]): Promise<void> {
    throw new Error(
      "arker.daytona: process.getSessionCommandLogsAsync is not implemented — " +
        "live streaming needs WS; poll getSessionCommandLogs instead.",
    );
  }

  async sendSessionCommandInput(..._args: unknown[]): Promise<void> {
    throw new Error(
      "arker.daytona: process.sendSessionCommandInput is not implemented — " +
        "Arker has no non-PTY stdin primitive.",
    );
  }

  // ---- PTY sessions (need WS) ----

  private readonly ptyUnsupported = (): never => {
    throw new Error(
      "arker.daytona: PTY sessions require a WebSocket client we haven't " +
        "shipped yet.",
    );
  };

  async createPtySession(..._args: unknown[]): Promise<never> { return this.ptyUnsupported(); }
  async connectPtySession(..._args: unknown[]): Promise<never> { return this.ptyUnsupported(); }
  async listPtySessions(): Promise<never> { return this.ptyUnsupported(); }
  async getPtySessionInfo(..._args: unknown[]): Promise<never> { return this.ptyUnsupported(); }
  async killPtySession(..._args: unknown[]): Promise<never> { return this.ptyUnsupported(); }
  async resizePtySession(..._args: unknown[]): Promise<never> { return this.ptyUnsupported(); }
}
