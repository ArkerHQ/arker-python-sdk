import type { BackgroundRunResult, CompletedRunResult } from "../index.js";
import type { SandboxClient } from "./sandbox-client.js";
import {
  type Command,
  CommandError,
  translateArkerError,
} from "./types.js";

export interface ShellRunOpts {
  dimensions?: { cols: number; rows: number };
  name?: string;
  env?: Record<string, string>;
  cwd?: string;
  asGlobalSession?: boolean;
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`;
}

function wrap(cmd: string | string[], cwd?: string, env?: Record<string, string>): string {
  const parts: string[] = [];
  if (cwd) parts.push(`cd ${shellQuote(cwd)} &&`);
  if (env && Object.keys(env).length > 0) {
    parts.push("env");
    for (const [k, v] of Object.entries(env)) {
      parts.push(`${shellQuote(k)}=${shellQuote(v)}`);
    }
  }
  if (Array.isArray(cmd)) {
    parts.push(cmd.map(shellQuote).join(" "));
  } else {
    parts.push(cmd);
  }
  return parts.join(" ");
}

function decode(bytes: Uint8Array): string {
  return new TextDecoder("utf-8", { fatal: false }).decode(bytes);
}

/** Mirrors `@codesandbox/sdk` SandboxCommands. */
export class Commands {
  private readonly client: SandboxClient;
  private readonly tracked = new Map<string, Command>();

  constructor(client: SandboxClient) {
    this.client = client;
  }

  /** Run a command and return its combined output string. Throws
   * CommandError on non-zero exit (matches codesandbox). */
  async run(command: string | string[], opts: ShellRunOpts = {}): Promise<string> {
    const wrapped = wrap(command, opts.cwd, opts.env);
    let result: CompletedRunResult;
    try {
      result = (await this.client._sandbox._computer.run(wrapped)) as CompletedRunResult;
    } catch (error) {
      throw translateArkerError(error);
    }
    if (result.type !== "completed") {
      throw new CommandError(`unexpected run result type ${result.type}`, -1, "");
    }
    const output = decode(result.stdout) + decode(result.stderr);
    if (result.exitCode !== 0) {
      throw new CommandError(
        `command exited with code ${result.exitCode}`,
        result.exitCode,
        output,
      );
    }
    return output;
  }

  async runBackground(command: string | string[], opts: ShellRunOpts = {}): Promise<Command> {
    const wrapped = wrap(command, opts.cwd, opts.env);
    let result: BackgroundRunResult;
    try {
      result = (await this.client._sandbox._computer.run(wrapped, { background: true })) as BackgroundRunResult;
    } catch (error) {
      throw translateArkerError(error);
    }
    if (result.type !== "background") {
      throw new CommandError(`unexpected background run result type ${result.type}`, -1, "");
    }
    const name = opts.name ?? `cmd-${this.tracked.size + 1}`;
    const cmd: Command = {
      name,
      status: "RUNNING",
      output: "",
      exitCode: null,
      _runId: result.runId,
    };
    this.tracked.set(name, cmd);
    return cmd;
  }

  async getAll(): Promise<Command[]> {
    return Array.from(this.tracked.values());
  }

  get(name: string): Command | undefined {
    return this.tracked.get(name);
  }
}
