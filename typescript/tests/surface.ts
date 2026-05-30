/**
 * Full-surface exercise of the SDK against a live backend.
 * Calls every public method on Arker / Computer / Runs / Sessions /
 * Tunnels / Syncs / Filesystems and reports PASS / FAIL / STUB.
 *
 *   ARKER_API_KEY=... ARKER_BASE_URL=http://host:8080/api tsx tests/surface.ts
 */
export {};

import { Arker, ARKER_ORG_ID } from "../src/index.js";

const apiKey = process.env.ARKER_API_KEY;
const baseUrl = process.env.ARKER_BASE_URL;
if (!apiKey || !baseUrl) throw new Error("set ARKER_API_KEY + ARKER_BASE_URL");

// On a single-host feature env, control + compute are the same instance.
const arker = new Arker({ apiKey, baseUrl, controlBaseUrl: baseUrl, retry: false });

type Status = "PASS" | "FAIL" | "STUB";
const rows: Array<[Status, string, string]> = [];
function rec(s: Status, name: string, detail = "") { rows.push([s, name, detail]); }

// Treat arkerd's intentional stubs (empty list / not-implemented) as STUB, not FAIL.
async function call(name: string, fn: () => Promise<unknown>, opts: { stubOk?: boolean } = {}) {
  try {
    const r = await fn();
    rec("PASS", name, summarize(r));
    return r;
  } catch (e: any) {
    const msg = e?.message ?? String(e);
    const code = e?.code ?? "";
    if (opts.stubOk && /not.?implemented|unsupported|not found|404|501/i.test(`${code} ${msg}`)) {
      rec("STUB", name, `${code} ${msg}`.slice(0, 80));
    } else {
      rec("FAIL", name, `${code} ${msg}`.slice(0, 120));
    }
    return undefined;
  }
}

function summarize(r: unknown): string {
  if (r == null) return "";
  if (Array.isArray((r as any)?.vms)) return `${(r as any).vms.length} vms`;
  if (Array.isArray((r as any)?.runs)) return `${(r as any).runs.length} runs`;
  if (Array.isArray((r as any)?.sessions)) return `${(r as any).sessions.length} sessions`;
  if (Array.isArray((r as any)?.tunnels)) return `${(r as any).tunnels.length} tunnels`;
  if (Array.isArray((r as any)?.syncs)) return `${(r as any).syncs.length} syncs`;
  if (Array.isArray((r as any)?.filesystems)) return `${(r as any).filesystems.length} filesystems`;
  if ((r as any)?.type) return `run:${(r as any).type}`;
  if ((r as any)?.id) return `id=${(r as any).id}`;
  if ((r as any)?.run_id) return `run_id=${(r as any).run_id}`;
  if ((r as any)?.session_id) return `session=${(r as any).session_id}`;
  if (r instanceof Uint8Array) return `${r.length} bytes`;
  return JSON.stringify(r).slice(0, 60);
}

const stamp = process.env.SURFACE_STAMP ?? "sfc";

// ── Arker (control plane) ──────────────────────────────────────────
await call("Arker.list (vms)", () => arker.listVms());
await call("Arker.filesystems.list", () => arker.listFilesystems(), { stubOk: true });

// ── fork (the real SDK top-level path) ──────────────────────────────
let vm = await call("Arker.fork(sourceVmName=ubuntu)",
  () => arker.fork({ sourceVmName: "ubuntu", name: `${stamp}-a` })) as any;
if (!vm) {
  vm = await call("Arker.fork(sourceVmName=ubuntu, org=ArkerHQ)",
    () => arker.fork({ sourceVmName: "ubuntu", sourceOrgId: ARKER_ORG_ID, name: `${stamp}-b` })) as any;
}
if (!vm) { print(); throw new Error("fork failed — cannot exercise per-VM surface"); }
const vmId: string = vm.id;
rec("PASS", "fork → vmId", vmId);

// ── Arker.vm / Computer ─────────────────────────────────────────────
const computer = arker.vm(vmId);
await call("Computer.get", () => computer.refresh());
await call("Computer.run(echo)", () => computer.run("echo surface-hello"));
const bg = await call("Computer.run(background)", () => computer.run("sleep 1; echo bg", { background: true } as any)) as any;
await call("Computer.resize", () => computer.resize({ vcpu_count: 2 } as any), { stubOk: true });

// ── Runs ────────────────────────────────────────────────────────────
const runs = await call("Runs.list", () => computer.listRuns()) as any;
const someRun = bg?.runId ?? runs?.runs?.[0]?.run_id;
if (someRun) {
  await call("Runs.get", () => computer.getRun(someRun));
  await call("Runs.cancel", () => computer.cancelRun(someRun), { stubOk: true });
} else { rec("STUB", "Runs.get/cancel", "no run id available"); }

// ── Sessions ────────────────────────────────────────────────────────
await call("Sessions.list", () => computer.listSessions());
const sess = await call("Sessions.create", () => computer.createSession({})) as any;
const sid = sess?.session_id;
if (sid) {
  await call("Sessions.get", () => computer.getSession(sid));
  await call("Sessions.delete", () => computer.deleteSession(sid));
} else { rec("STUB", "Sessions.get/delete", "no session id"); }

// ── Syncs ───────────────────────────────────────────────────────────
const path = `/home/user/${stamp}.txt`;
await call("Syncs.writeFile", () => computer.sync(path, `${stamp}\n`));
await call("Syncs.readFile", async () => {
  const b = await computer.sync(path);
  const got = new TextDecoder().decode(b);
  if (got !== `${stamp}\n`) throw new Error(`readback mismatch: ${JSON.stringify(got)}`);
  return b;
});
await call("Syncs.list", () => computer.listSyncs(), { stubOk: true });
await call("Syncs.get", () => computer.getSync("sync_does_not_exist"), { stubOk: true });
await call("Syncs.delete", () => computer.deleteSync("sync_does_not_exist"), { stubOk: true });

// ── Tunnels ─────────────────────────────────────────────────────────
await call("Tunnels.list", () => computer.listTunnels(), { stubOk: true });
await call("Tunnels.get", () => computer.getTunnel(8080), { stubOk: true });
await call("Tunnels.delete", () => computer.deleteTunnel(8080), { stubOk: true });

// ── Filesystems get/delete ──────────────────────────────────────────
await call("Filesystems.get", () => arker.getFilesystem("fs_does_not_exist"), { stubOk: true });
await call("Filesystems.delete", () => arker.deleteFilesystem("fs_does_not_exist"), { stubOk: true });

// ── teardown ────────────────────────────────────────────────────────
await call("Computer.delete", () => computer.delete());

print();

function print() {
  console.log("\n──────── SDK SURFACE ────────");
  for (const [s, n, d] of rows) {
    const tag = s === "PASS" ? "✓ PASS" : s === "STUB" ? "~ STUB" : "✗ FAIL";
    console.log(`${tag}  ${n}${d ? "  — " + d : ""}`);
  }
  const fails = rows.filter((r) => r[0] === "FAIL").length;
  const pass = rows.filter((r) => r[0] === "PASS").length;
  const stub = rows.filter((r) => r[0] === "STUB").length;
  console.log(`\n${pass} pass, ${stub} stub, ${fails} fail`);
  if (fails > 0) process.exitCode = 1;
}
