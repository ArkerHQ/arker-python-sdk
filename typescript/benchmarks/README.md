# TypeScript SDK benchmarks

These benchmarks separate deterministic regression gates from measurements that
depend on machine load or a live Arker environment.

## HTTP/2 transport

Build the SDK before running the transport benchmark:

```sh
bun run build
bun benchmarks/http2.mjs
node --expose-gc benchmarks/http2.mjs
```

The benchmark uses a local HTTP/2 server and reports latency percentiles,
throughput, CPU per request, memory deltas, warning counts, and session reuse for
sequential, multiplexed, large-payload, and chunked-response workloads. Add
`--quick --assert` for the deterministic CI-sized invariant check.

Compare two built SDK artifacts by alternating them on the same machine:

```sh
bun benchmarks/compare-http2.mjs \
  --runtime bun \
  --baseline /path/to/baseline/dist/index.js \
  --candidate /path/to/candidate/dist/index.js \
  --repeat 5 \
  --assert
```

The default comparison budget rejects median throughput or CPU regressions over
10%. A p95 latency change must exceed both 10% and 0.1 ms to reject the run, so
sub-millisecond scheduling noise does not dominate the result. Override these
with `--max-regression-percent` and `--max-latency-regression-ms`.

## Startup and toolchain

`startup.mjs` measures cold CLI and SDK-import process startup under Node and Bun
and reports the built artifact size. `toolchain.mjs` measures install, typecheck,
build, and test commands. Use fresh worktrees when comparing installs so one
package manager cannot reuse another run's dependency directory.

```sh
node benchmarks/startup.mjs
bun benchmarks/toolchain.mjs --runner bun --repeat 3
```

## Live core operations

The live benchmark measures fork, run, sync-write, and sync-read latency. It
requires the normal SDK environment plus `ARKER_SOURCE_VM` and deletes every VM
that it creates.

```sh
ARKER_API_KEY=... ARKER_REGION=... ARKER_SOURCE_VM=... \
  bun benchmarks/live-core.mjs
```

Live results are trend evidence rather than a hard CI gate because backend and
network variance are outside the SDK process.
