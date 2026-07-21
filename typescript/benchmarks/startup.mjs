import assert from "node:assert/strict";
import { readdirSync, statSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { performance } from "node:perf_hooks";

function argument(name, fallback) {
  const index = process.argv.indexOf(name);
  return index === -1 ? fallback : process.argv[index + 1];
}

const packageRoot = argument("--cwd", fileURLToPath(new URL("..", import.meta.url)));
const quick = process.argv.includes("--quick");
const samples = quick ? 10 : 50;
const warmups = quick ? 2 : 10;

function percentile(values, value) {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * value / 100))] ?? 0;
}

function round(value) {
  return Number(value.toFixed(3));
}

function commandAvailable(command) {
  return spawnSync(command, ["--version"], { stdio: "ignore" }).status === 0;
}

function measure(name, command, args) {
  const env = { ...process.env };
  delete env.ARKER_API_KEY;
  delete env.AUTH_KEY;
  const durations = [];
  for (let index = 0; index < warmups + samples; index++) {
    const started = performance.now();
    const result = spawnSync(command, args, {
      cwd: packageRoot,
      env,
      encoding: "utf8",
      maxBuffer: 8 * 1024 * 1024,
    });
    const elapsed = performance.now() - started;
    assert.equal(result.status, 0, `${name} failed: ${result.stderr}`);
    if (index >= warmups) durations.push(elapsed);
  }
  return {
    name,
    samples,
    p50Ms: round(percentile(durations, 50)),
    p95Ms: round(percentile(durations, 95)),
    p99Ms: round(percentile(durations, 99)),
  };
}

function directoryBytes(path) {
  let total = 0;
  for (const entry of readdirSync(path, { withFileTypes: true })) {
    const entryPath = `${path}/${entry.name}`;
    total += entry.isDirectory() ? directoryBytes(entryPath) : statSync(entryPath).size;
  }
  return total;
}

const results = [
  measure("node-cli-version", "node", ["dist/cli.js", "--version"]),
  measure("node-cli-help", "node", ["dist/cli.js", "--help"]),
  measure("node-sdk-import", "node", ["--input-type=module", "--eval", "await import('./dist/index.js')"]),
];

if (commandAvailable("bun")) {
  results.push(
    measure("bun-cli-version", "bun", ["dist/cli.js", "--version"]),
    measure("bun-cli-help", "bun", ["dist/cli.js", "--help"]),
    measure("bun-sdk-import", "bun", ["--eval", "await import('./dist/index.js')"]),
  );
}

console.log(JSON.stringify({
  generatedAt: new Date().toISOString(),
  platform: `${process.platform}-${process.arch}`,
  cwd: packageRoot,
  artifactBytes: directoryBytes(`${packageRoot}/dist`),
  results,
}, null, 2));
