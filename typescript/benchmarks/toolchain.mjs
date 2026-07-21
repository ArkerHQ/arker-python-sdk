import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { performance } from "node:perf_hooks";

function argument(name, fallback) {
  const index = process.argv.indexOf(name);
  return index === -1 ? fallback : process.argv[index + 1];
}

const packageRoot = fileURLToPath(new URL("..", import.meta.url));
const cwd = argument("--cwd", packageRoot);
const runner = argument("--runner", "bun");
const repetitions = Number(argument("--repeat", "3"));
const commands = argument("--commands", "typecheck,build,test").split(",").filter(Boolean);
const includeInstall = process.argv.includes("--include-install");

assert.ok(cwd, "--cwd requires a value");
assert.ok(runner === "bun" || runner === "npm", "--runner must be bun or npm");
assert.ok(Number.isInteger(repetitions) && repetitions > 0, "--repeat must be a positive integer");
assert.ok(!includeInstall || repetitions === 1, "install measurement requires a fresh worktree and --repeat 1");

function percentile(values, value) {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * value / 100))] ?? 0;
}

function round(value) {
  return Number(value.toFixed(2));
}

function measure(name, args) {
  const samples = [];
  for (let index = 0; index < repetitions; index++) {
    const started = performance.now();
    const result = spawnSync(runner, args, {
      cwd,
      env: { ...process.env, CI: "1" },
      encoding: "utf8",
      maxBuffer: 32 * 1024 * 1024,
    });
    const elapsed = performance.now() - started;
    assert.equal(result.status, 0, `${name} failed:\n${result.stdout}\n${result.stderr}`);
    samples.push(elapsed);
  }
  return {
    name,
    samples: samples.map(round),
    p50Ms: round(percentile(samples, 50)),
    p95Ms: round(percentile(samples, 95)),
  };
}

const results = [];
if (includeInstall) results.push(measure("install", ["ci"]));
for (const command of commands) results.push(measure(command, ["run", command]));

console.log(JSON.stringify({
  generatedAt: new Date().toISOString(),
  runner,
  cwd,
  repetitions,
  results,
}, null, 2));
