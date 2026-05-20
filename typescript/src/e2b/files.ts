import type { CompletedRunResult } from "../index.js";
import type { Sandbox } from "./sandbox.js";
import { type EntryInfo, FileType } from "./types.js";

// `find ... -printf "%f|%y\n"` — one line per entry, type letter f/d/l/...
const FIND_FMT = "%f|%y\\n";
const FIND_TYPE_TO_ENUM: Record<string, FileType> = {
  f: FileType.File,
  d: FileType.Dir,
};

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`;
}

function decode(bytes: Uint8Array): string {
  return new TextDecoder("utf-8", { fatal: false }).decode(bytes);
}

function basename(path: string): string {
  const trimmed = path.replace(/\/+$/, "");
  const idx = trimmed.lastIndexOf("/");
  return idx < 0 ? trimmed : trimmed.slice(idx + 1);
}

export interface ReadOptions {
  format?: "text" | "bytes" | "stream";
  user?: string;
}

export class WatchHandle {
  stop(): void {
    /* no-op */
  }
}

export class Filesystem {
  private readonly sbx: Sandbox;

  constructor(sbx: Sandbox) {
    this.sbx = sbx;
  }

  // ----- Native (sync API) -----

  async read(path: string, opts: ReadOptions = {}): Promise<string | Uint8Array | AsyncIterableIterator<Uint8Array>> {
    const data = await this.sbx._computer.sync.readFile(path);
    if (opts.format === "bytes") return data;
    if (opts.format === "stream") {
      const chunks = [data];
      async function* gen(): AsyncIterableIterator<Uint8Array> {
        for (const c of chunks) yield c;
      }
      return gen();
    }
    return decode(data);
  }

  async write(path: string, data: Uint8Array | string): Promise<EntryInfo> {
    await this.sbx._computer.sync.writeFile(path, data);
    return { name: basename(path), type: FileType.File, path };
  }

  // ----- Shell-shim -----

  async list(path: string): Promise<EntryInfo[]> {
    const { stdout, exitCode } = await this.shell(
      `find ${shellQuote(path)} -maxdepth 1 -mindepth 1 -printf ${shellQuote(FIND_FMT)}`,
    );
    if (exitCode !== 0) return [];
    const entries: EntryInfo[] = [];
    for (const line of stdout.split("\n")) {
      if (!line || !line.includes("|")) continue;
      const pipe = line.lastIndexOf("|");
      const name = line.slice(0, pipe);
      const kind = line.slice(pipe + 1);
      entries.push({
        name,
        type: FIND_TYPE_TO_ENUM[kind] ?? FileType.File,
        path: `${path.replace(/\/+$/, "")}/${name}`,
      });
    }
    return entries;
  }

  async exists(path: string): Promise<boolean> {
    const { exitCode } = await this.shell(`test -e ${shellQuote(path)}`);
    return exitCode === 0;
  }

  async remove(path: string): Promise<void> {
    await this.shell(`rm -rf ${shellQuote(path)}`);
  }

  async rename(oldPath: string, newPath: string): Promise<EntryInfo> {
    await this.shell(`mv ${shellQuote(oldPath)} ${shellQuote(newPath)}`);
    return { name: basename(newPath), type: FileType.File, path: newPath };
  }

  async makeDir(path: string): Promise<boolean> {
    const { exitCode } = await this.shell(`mkdir -p ${shellQuote(path)}`);
    return exitCode === 0;
  }

  watchDir(_path: string): WatchHandle {
    return new WatchHandle();
  }

  private async shell(cmd: string): Promise<{ stdout: string; stderr: string; exitCode: number }> {
    const result = (await this.sbx._computer.run(cmd)) as CompletedRunResult;
    if (result.type !== "completed") {
      throw new Error(`unexpected run result type ${result.type}`);
    }
    return {
      stdout: decode(result.stdout),
      stderr: decode(result.stderr),
      exitCode: result.exitCode,
    };
  }
}
