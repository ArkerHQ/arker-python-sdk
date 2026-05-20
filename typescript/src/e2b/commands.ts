import type { CompletedRunResult, BackgroundRunResult } from "../index.js";
import { CommandHandle } from "./handle.js";
import type { Sandbox } from "./sandbox.js";
import { CommandExitException, type CommandResult, type ProcessInfo } from "./types.js";

export interface RunOpts {
  background?: boolean;
  timeout?: number;
  envs?: Record<string, string>;
  cwd?: string;
  user?: string;
  onStdout?: (chunk: string) => void;
  onStderr?: (chunk: string) => void;
}

function shellQuote(value: string): string {
  // POSIX single-quote: replace ' with '\''
  return `'${value.replace(/'/g, "'\\''")}'`;
}

export function wrapCommand(cmd: string, cwd?: string, envs?: Record<string, string>): string {
  const parts: string[] = [];
  if (cwd) parts.push(`cd ${shellQuote(cwd)} &&`);
  if (envs && Object.keys(envs).length > 0) {
    parts.push("env");
    for (const [k, v] of Object.entries(envs)) {
      parts.push(`${shellQuote(k)}=${shellQuote(v)}`);
    }
  }
  parts.push(cmd);
  return parts.join(" ");
}

function decode(bytes: Uint8Array): string {
  return new TextDecoder("utf-8", { fatal: false }).decode(bytes);
}

export class Commands {
  private readonly sbx: Sandbox;

  constructor(sbx: Sandbox) {
    this.sbx = sbx;
  }

  async run(cmd: string, opts: RunOpts = {}): Promise<CommandResult | CommandHandle> {
    const envs = { ...this.sbx._defaultEnvs, ...(opts.envs ?? {}) };
    const wrapped = wrapCommand(cmd, opts.cwd, envs);

    if (opts.background) {
      const result = (await this.sbx._computer.run(wrapped, {
        background: true,
        timeout: opts.timeout,
      })) as BackgroundRunResult;
      if (result.type !== "background") {
        throw new Error(`background run returned unexpected type ${result.type}`);
      }
      const pid = this.sbx._registerRun(result.runId, wrapped);
      return new CommandHandle(this.sbx, pid, result.runId, wrapped);
    }

    const result = (await this.sbx._computer.run(wrapped, {
      timeout: opts.timeout,
    })) as CompletedRunResult;
    if (result.type !== "completed") {
      throw new Error(`foreground run returned unexpected type ${result.type}`);
    }

    const cr: CommandResult = {
      stdout: decode(result.stdout),
      stderr: decode(result.stderr),
      exitCode: result.exitCode,
    };

    if (opts.onStdout && cr.stdout) opts.onStdout(cr.stdout);
    if (opts.onStderr && cr.stderr) opts.onStderr(cr.stderr);

    if (cr.exitCode !== 0) throw new CommandExitException(cr);
    return cr;
  }

  list(): ProcessInfo[] {
    const out: ProcessInfo[] = [];
    for (const [pid, { runId, cmd }] of this.sbx._bgRuns.entries()) {
      out.push({ pid, tag: runId, cmd });
    }
    return out;
  }

  async kill(pid: number): Promise<boolean> {
    const runId = this.sbx._runIdFor(pid);
    if (!runId) return false;
    try {
      const r = await this.sbx._computer.cancelRun(runId);
      return !!r.cancelled;
    } finally {
      this.sbx._forgetPid(pid);
    }
  }

  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  async sendStdin(_pid: number, _data: string): Promise<void> {
    // Arker has no non-PTY stdin primitive. No-op (silent so existing e2b code paths don't crash).
  }

  connect(pid: number): CommandHandle {
    const runId = this.sbx._runIdFor(pid);
    if (!runId) throw new Error(`no background run is registered for pid=${pid}`);
    const cmd = this.sbx._bgRuns.get(pid)!.cmd;
    return new CommandHandle(this.sbx, pid, runId, cmd);
  }
}
