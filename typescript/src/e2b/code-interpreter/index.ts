/**
 * Drop-in for `@e2b/code-interpreter` Sandbox.
 *
 *     import { Sandbox } from "@arker-ai/sdk/e2b/code-interpreter";
 *     const sbx = await Sandbox.create();
 *     const ex = await sbx.runCode("console.log(2+2)", { language: "js" });
 */

import { CommandExitException, type CommandResult } from "../types.js";
import { Sandbox as BaseSandbox, type SandboxOptions } from "../sandbox.js";

export interface Logs {
  stdout: string[];
  stderr: string[];
}

export interface ExecutionError {
  name: string;
  value: string;
  traceback: string;
}

export interface Result {
  text?: string;
  html?: string;
  markdown?: string;
  png?: string;
  jpeg?: string;
  svg?: string;
  json?: unknown;
  isMainResult?: boolean;
}

export interface Execution {
  text: string;
  logs: Logs;
  error: ExecutionError | null;
  results: Result[];
}

export interface RunCodeOpts {
  language?: string;
  onStdout?: (chunk: string) => void;
  onStderr?: (chunk: string) => void;
  onError?: (err: ExecutionError) => void;
  envs?: Record<string, string>;
  timeout?: number;
}

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

export function runtimeFor(language: string): [string, string] {
  return LANGUAGE_RUNTIME[language.toLowerCase()] ?? ["python3", "py"];
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`;
}

function randHex(n: number): string {
  const bytes = new Uint8Array(n);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

export class Sandbox extends BaseSandbox {
  static override async create(opts: SandboxOptions = {}): Promise<Sandbox> {
    // Reuse the base factory's wire-up; the constructor is protected so we
    // call create() and re-wrap. Cleaner alternative would refactor base.
    const base = await BaseSandbox.create(opts);
    // Re-wrap into the subclass without re-forking. The base constructor
    // is protected; we cast through `any` to satisfy TS's class-private
    // visibility check (this is the canonical workaround for inheriting
    // a protected constructor with an async factory).
    const sub: Sandbox = Object.create(Sandbox.prototype);
    Object.assign(sub, base);
    return sub;
  }

  async runCode(code: string, opts: RunCodeOpts = {}): Promise<Execution> {
    const lang = opts.language ?? "python";
    const [interp, ext] = runtimeFor(lang);
    const scratch = `/tmp/arker-e2b-${randHex(8)}.${ext}`;
    await this._computer.sync.writeFile(scratch, code);

    let stdout = "";
    let stderr = "";
    let error: ExecutionError | null = null;

    try {
      const result = (await this.commands.run(`${interp} ${shellQuote(scratch)}`, {
        envs: opts.envs,
        timeout: opts.timeout,
        onStdout: opts.onStdout,
        onStderr: opts.onStderr,
      })) as CommandResult;
      stdout = result.stdout;
      stderr = result.stderr;
    } catch (err) {
      if (err instanceof CommandExitException) {
        error = {
          name: `${lang}.runtime_error`,
          value: err.result.stderr.trim() || `exit ${err.result.exitCode}`,
          traceback: err.result.stderr,
        };
        stdout = err.result.stdout;
        stderr = err.result.stderr;
        if (opts.onError) opts.onError(error);
      } else {
        throw err;
      }
    } finally {
      try {
        await this.files.remove(scratch);
      } catch {
        // best-effort cleanup
      }
    }

    return {
      text: stdout,
      logs: {
        stdout: stdout ? [stdout] : [],
        stderr: stderr ? [stderr] : [],
      },
      error,
      results: [],
    };
  }
}
