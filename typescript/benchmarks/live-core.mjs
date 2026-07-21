import assert from "node:assert/strict";
import { pathToFileURL } from "node:url";
import { performance } from "node:perf_hooks";

function argument(name, fallback) {
  const index = process.argv.indexOf(name);
  return index === -1 ? fallback : process.argv[index + 1];
}

const sdkPath = argument("--sdk", new URL("../dist/index.js", import.meta.url).pathname);
const forkSamples = Number(argument("--forks", "3"));
const operationSamples = Number(argument("--operations", "20"));
const apiKey = process.env.ARKER_API_KEY ?? process.env.AUTH_KEY;
const sourceVm = process.env.ARKER_SOURCE_VM;

assert.ok(apiKey, "ARKER_API_KEY or AUTH_KEY is required");
assert.ok(sourceVm, "ARKER_SOURCE_VM is required");
assert.ok(Number.isInteger(forkSamples) && forkSamples > 0, "--forks must be a positive integer");
assert.ok(Number.isInteger(operationSamples) && operationSamples > 0, "--operations must be a positive integer");

const { Arker } = await import(pathToFileURL(sdkPath).href);
const options = { apiKey, retry: false };
if (process.env.ARKER_BASE_URL) options.baseUrl = process.env.ARKER_BASE_URL;
if (process.env.ARKER_CONTROL_BASE_URL) options.controlBaseUrl = process.env.ARKER_CONTROL_BASE_URL;
if (process.env.ARKER_REGION) options.region = process.env.ARKER_REGION;
if (process.env.ARKER_PROVIDER) options.provider = process.env.ARKER_PROVIDER;
const arker = new Arker(options);

function percentile(values, value) {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * value / 100))] ?? 0;
}

function summarize(name, values) {
  return {
    name,
    samples: values.length,
    p50Ms: Number(percentile(values, 50).toFixed(2)),
    p95Ms: Number(percentile(values, 95).toFixed(2)),
    p99Ms: Number(percentile(values, 99).toFixed(2)),
  };
}

async function measure(values, fn) {
  const started = performance.now();
  await fn();
  values.push(performance.now() - started);
}

const stamp = `${Date.now()}-${process.pid}`;
const vms = [];
const forks = [];
const runs = [];
const syncWrites = [];
const syncReads = [];

try {
  for (let index = 0; index < forkSamples; index++) {
    await measure(forks, async () => {
      const vm = await arker.fork(sourceVm, { name: `sdk-perf-${stamp}-${index}` });
      vms.push(vm);
    });
  }

  const vm = vms[0];
  assert.ok(vm, "fork did not return a VM");
  for (let index = 0; index < operationSamples; index++) {
    await measure(runs, () => vm.run("printf sdk-perf"));
  }
  for (let index = 0; index < operationSamples; index++) {
    const path = `/tmp/sdk-perf-${stamp}-${index}.txt`;
    const body = `sdk-perf-${index}`;
    await measure(syncWrites, () => vm.sync(path, body));
    await measure(syncReads, async () => {
      const value = await vm.sync(path);
      assert.equal(new TextDecoder().decode(value), body);
    });
  }
} finally {
  const cleanup = await Promise.allSettled(vms.map((vm) => vm.delete()));
  const cleanupErrors = cleanup
    .filter((result) => result.status === "rejected")
    .map((result) => result.reason);
  if (cleanupErrors.length > 0) {
    throw new AggregateError(cleanupErrors, `failed to delete ${cleanupErrors.length} benchmark VM(s)`);
  }
}

console.log(JSON.stringify({
  generatedAt: new Date().toISOString(),
  runtime: process.versions.bun ? `bun-${process.versions.bun}` : `node-${process.versions.node}`,
  sdkPath,
  results: [
    summarize("fork", forks),
    summarize("run", runs),
    summarize("sync-write", syncWrites),
    summarize("sync-read", syncReads),
  ],
}, null, 2));
