import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

function argument(name, fallback) {
  const index = process.argv.indexOf(name);
  return index === -1 ? fallback : process.argv[index + 1];
}

const runtime = argument("--runtime", "bun");
const baseline = argument("--baseline");
const candidate = argument("--candidate");
const repetitions = Number(argument("--repeat", "3"));
const maxRegressionPercent = Number(argument("--max-regression-percent", "10"));
const maxLatencyRegressionMs = Number(argument("--max-latency-regression-ms", "0.1"));
const assertBudget = process.argv.includes("--assert");
const quick = process.argv.includes("--quick");
const caseFilter = argument("--case");
const benchmark = fileURLToPath(new URL("./http2.mjs", import.meta.url));

assert.ok(runtime === "bun" || runtime === "node", "--runtime must be bun or node");
assert.ok(baseline, "--baseline is required");
assert.ok(candidate, "--candidate is required");
assert.ok(Number.isInteger(repetitions) && repetitions > 0, "--repeat must be a positive integer");
assert.ok(Number.isFinite(maxRegressionPercent) && maxRegressionPercent >= 0, "invalid regression budget");
assert.ok(Number.isFinite(maxLatencyRegressionMs) && maxLatencyRegressionMs >= 0, "invalid latency budget");

function run(sdkPath) {
  const args = runtime === "node" ? ["--expose-gc", benchmark] : [benchmark];
  args.push("--json", "--sdk", sdkPath);
  if (quick) args.push("--quick");
  if (caseFilter) args.push("--case", caseFilter);
  const result = spawnSync(runtime, args, {
    encoding: "utf8",
    maxBuffer: 32 * 1024 * 1024,
  });
  assert.equal(result.status, 0, `benchmark failed:\n${result.stdout}\n${result.stderr}`);
  return JSON.parse(result.stdout);
}

function median(values) {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)] ?? 0;
}

function round(value, digits = 2) {
  return Number(value.toFixed(digits));
}

const reports = { baseline: [], candidate: [] };
for (let repetition = 0; repetition < repetitions; repetition++) {
  const order = repetition % 2 === 0
    ? [["baseline", baseline], ["candidate", candidate]]
    : [["candidate", candidate], ["baseline", baseline]];
  for (const [label, sdkPath] of order) reports[label].push(run(sdkPath));
}

function metric(report, caseName, read) {
  const result = report.results.find((entry) => entry.name === caseName);
  assert.ok(result, `missing ${caseName}`);
  return read(result);
}

const caseNames = reports.baseline[0].results.map((result) => result.name);
const comparisons = caseNames.map((caseName) => {
  const baselineRps = median(reports.baseline.map((report) => metric(report, caseName, (result) => result.requestsPerSecond)));
  const candidateRps = median(reports.candidate.map((report) => metric(report, caseName, (result) => result.requestsPerSecond)));
  const baselineP95 = median(reports.baseline.map((report) => metric(report, caseName, (result) => result.latencyMs.p95)));
  const candidateP95 = median(reports.candidate.map((report) => metric(report, caseName, (result) => result.latencyMs.p95)));
  const baselineCpu = median(reports.baseline.map((report) => metric(report, caseName, (result) => result.cpuMicrosPerRequest)));
  const candidateCpu = median(reports.candidate.map((report) => metric(report, caseName, (result) => result.cpuMicrosPerRequest)));
  return {
    name: caseName,
    baseline: {
      requestsPerSecond: round(baselineRps),
      p95Ms: round(baselineP95, 3),
      cpuMicrosPerRequest: round(baselineCpu),
      heapUsedDeltaBytes: median(reports.baseline.map((report) => metric(report, caseName, (result) => result.heapUsedDeltaBytes))),
      warnings: reports.baseline.reduce((total, report) => total + metric(report, caseName, (result) => result.warningCount), 0),
    },
    candidate: {
      requestsPerSecond: round(candidateRps),
      p95Ms: round(candidateP95, 3),
      cpuMicrosPerRequest: round(candidateCpu),
      heapUsedDeltaBytes: median(reports.candidate.map((report) => metric(report, caseName, (result) => result.heapUsedDeltaBytes))),
      warnings: reports.candidate.reduce((total, report) => total + metric(report, caseName, (result) => result.warningCount), 0),
    },
    changePercent: {
      requestsPerSecond: round((candidateRps / baselineRps - 1) * 100),
      p95Ms: round((candidateP95 / baselineP95 - 1) * 100),
      cpuMicrosPerRequest: round((candidateCpu / baselineCpu - 1) * 100),
    },
  };
});

if (assertBudget) {
  for (const comparison of comparisons) {
    assert.equal(comparison.candidate.warnings, 0, `${comparison.name} emitted warnings`);
    assert.ok(
      comparison.changePercent.requestsPerSecond >= -maxRegressionPercent,
      `${comparison.name} throughput regressed ${comparison.changePercent.requestsPerSecond}%`,
    );
    assert.ok(
      comparison.changePercent.p95Ms <= maxRegressionPercent ||
        comparison.candidate.p95Ms - comparison.baseline.p95Ms <= maxLatencyRegressionMs,
      `${comparison.name} p95 regressed ${comparison.changePercent.p95Ms}% ` +
        `(${comparison.candidate.p95Ms - comparison.baseline.p95Ms}ms)`,
    );
    assert.ok(
      comparison.changePercent.cpuMicrosPerRequest <= maxRegressionPercent,
      `${comparison.name} CPU regressed ${comparison.changePercent.cpuMicrosPerRequest}%`,
    );
  }
}

console.log(JSON.stringify({
  generatedAt: new Date().toISOString(),
  runtime,
  repetitions,
  maxRegressionPercent,
  maxLatencyRegressionMs,
  baseline,
  candidate,
  comparisons,
}, null, 2));
