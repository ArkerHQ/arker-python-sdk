/**
 * Throughput bench for VM.syncDir FULL-sync (ARK-268).
 *
 * Measures the SDK's rsync-style directory sync on a first/full push: a tree of
 * ~3000 small files + a few large ones, forked onto a live VM, timed end-to-end
 * through the working-tree `VM.syncDir`. Reports files/s, MB/s, and the
 * tarball-vs-naive win — syncDir packs all changed files into ONE tarball the
 * guest extracts with `tar -x`, versus the naive path of one `vm.sync()` write
 * per file (N round-trips). The tarball collapses N round-trips to ~2, which is
 * the whole point of the method (the ~6.6s→~2.4s story at this scale).
 *
 * FULL-sync ONLY. The delta/repeat throughput bench is intentionally NOT here:
 * op=manifest reads the host rootfs.xfs directly, while syncDir's guest tar-x
 * writes only reach rootfs.xfs after an async host-side flush (~2-3s lag,
 * measured). So a back-to-back second syncDir re-sends everything (sent=N,
 * skipped=0) — the delta path is blocked on the manifest-flush fix
 * (quiesce/FIFREEZE-then-read, or a guest-agent manifest). Re-enable a delta
 * bench once the host manifest is flush-consistent for a running VM.
 *
 *   ARKER_API_KEY=ark_... ARKER_BASE_URL=http://host:8080/api \
 *   ARKER_SOURCE_VM=<source-name> bun tests/conformance/sync-dir-bench.ts
 *
 * Knobs (env): BENCH_N_FILES (3000), BENCH_SMALL_BYTES (256),
 * BENCH_LARGE_COUNT (3), BENCH_LARGE_MB (2), BENCH_NAIVE_FILES (400 — cap on
 * the naive per-file comparison so the bench stays quick over a real RTT;
 * the full-tree naive time is projected from the measured per-file rate).
 */

import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { Arker, type VM } from "../../src/index.js";

function requiredEnv(name: string): string {
  const value = process.env[name];
  if (!value?.trim()) throw new Error(`${name} is required`);
  return value.trim();
}
function envInt(name: string, dflt: number): number {
  const v = process.env[name];
  return v?.trim() ? Number.parseInt(v, 10) : dflt;
}
const now = () => Number(process.hrtime.bigint()) / 1e9;
const MiB = 1024 * 1024;

async function main(): Promise<void> {
  const arker = new Arker({
    apiKey: requiredEnv("ARKER_API_KEY"),
    baseUrl: requiredEnv("ARKER_BASE_URL"),
  });
  const source = requiredEnv("ARKER_SOURCE_VM");
  const nFiles = envInt("BENCH_N_FILES", 3000);
  const smallBytes = envInt("BENCH_SMALL_BYTES", 256);
  const largeCount = envInt("BENCH_LARGE_COUNT", 3);
  const largeMb = envInt("BENCH_LARGE_MB", 2);
  const naiveCap = Math.min(envInt("BENCH_NAIVE_FILES", 400), nFiles);

  // Build a nested local tree: nFiles small files (100 per dir) + a few large.
  const local = mkdtempSync(join(tmpdir(), "arker-syncdir-bench-"));
  const rels: string[] = [];
  const small = randomBytes(smallBytes);
  for (let i = 0; i < nFiles; i++) {
    const d = `d${String(Math.floor(i / 100)).padStart(4, "0")}`;
    mkdirSync(join(local, d), { recursive: true });
    const rel = `${d}/f${String(i).padStart(6, "0")}.dat`;
    writeFileSync(join(local, rel), small);
    rels.push(rel);
  }
  for (let i = 0; i < largeCount; i++) {
    const rel = `big${i}.bin`;
    writeFileSync(join(local, rel), randomBytes(largeMb * MiB));
    rels.push(rel);
  }
  const totalFiles = rels.length;
  const totalBytes = nFiles * smallBytes + largeCount * largeMb * MiB;

  let vm: VM | undefined;
  try {
    vm = await arker.fork(source);
    // Warm the guest so cold-boot doesn't pollute the sync timing.
    await vm.sync(`/home/user/.bench-warm`, "warm");

    // ── syncDir FULL-sync (tarball path) ─────────────────────────────────
    const remote = `/home/user/bench-syncdir-${Date.now()}`;
    const t0 = now();
    const res = await vm.syncDir(local, remote);
    const syncDirS = now() - t0;
    if (res.sent !== totalFiles) {
      console.warn(`WARN: syncDir sent=${res.sent} expected ${totalFiles} (skipped=${res.skipped})`);
    }
    const filesPerS = res.sent / Math.max(syncDirS, 1e-6);
    const mbPerS = res.bytesSent / MiB / Math.max(syncDirS, 1e-6);

    // ── naive per-file baseline (N round-trips), capped ──────────────────
    const remoteNaive = `/home/user/bench-naive-${Date.now()}`;
    const n0 = now();
    for (let i = 0; i < naiveCap; i++) {
      await vm.sync(`${remoteNaive}/${rels[i]}`, small);
    }
    const naiveS = now() - n0;
    const naivePerS = naiveCap / Math.max(naiveS, 1e-6);
    const naiveProjFullS = totalFiles / Math.max(naivePerS, 1e-6);
    const win = naiveProjFullS / Math.max(syncDirS, 1e-6);

    console.log("");
    console.log(`  tree: ${totalFiles} files (${nFiles}×${smallBytes}B + ${largeCount}×${largeMb}MB) = ${(totalBytes / MiB).toFixed(1)} MB`);
    console.log(`  syncDir FULL: ${syncDirS.toFixed(3)}s  ->  ${filesPerS.toFixed(0)} files/s  ${mbPerS.toFixed(1)} MB/s  (sent=${res.sent}, bytesSent=${res.bytesSent})`);
    console.log(`  naive/file:   ${naiveS.toFixed(3)}s for ${naiveCap} files  ->  ${naivePerS.toFixed(0)} files/s  (projected ${naiveProjFullS.toFixed(1)}s for all ${totalFiles})`);
    console.log(`  tarball win:  ~${win.toFixed(1)}x faster than naive per-file (syncDir ${syncDirS.toFixed(2)}s vs projected naive ${naiveProjFullS.toFixed(2)}s)`);
    console.log("");
    console.log(`SYNC_DIR_BENCH_JSON={"files":${totalFiles},"mb":${(totalBytes / MiB).toFixed(2)},"syncdir_s":${syncDirS.toFixed(3)},"files_s":${filesPerS.toFixed(1)},"mb_s":${mbPerS.toFixed(2)},"bytes_sent":${res.bytesSent},"naive_files":${naiveCap},"naive_s":${naiveS.toFixed(3)},"naive_files_s":${naivePerS.toFixed(1)},"naive_proj_full_s":${naiveProjFullS.toFixed(2)},"tarball_win_x":${win.toFixed(2)}}`);
    console.log("PASS sync-dir-bench");
  } finally {
    if (vm) {
      try { await vm.delete(); } catch (error) { console.warn(`WARN: delete ${vm.id}: ${String(error)}`); }
    }
    rmSync(local, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(`FAIL sync-dir-bench: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
});
