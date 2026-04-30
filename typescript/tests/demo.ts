/**
 * Live SDK demo: exercises every public method against the production
 * deployment, printing what each call sends on the wire and the result.
 * Mirrors python/tests/demo.py — same 17 checks, same output shape.
 *
 * Run:
 *   ARKER_API_KEY=ark_live_... npx tsx tests/demo.ts
 *
 * Exits 0 on full pass, 1 on any failure.
 */
import {
  Arker,
  ArkerError,
  Computer,
  type RunResult,
  type VmSummary,
  type VmList,
} from "../src/index.js";

const API_KEY = process.env.ARKER_API_KEY ?? process.env.AUTH_KEY;
if (!API_KEY) {
  console.error("ARKER_API_KEY is required");
  process.exit(2);
}
/** Source VM to fork from. Defaults to the public `arkuntu` base image. */
const SOURCE_VM = process.env.ARKER_SOURCE_VM ?? "arkuntu";

// ── Wire-level request tracing ──────────────────────────────────────
// Wrap fetch so every HTTP call the SDK makes is printed verbatim.
const origFetch = globalThis.fetch;
globalThis.fetch = (async (input: any, init?: any) => {
  const url = typeof input === "string" ? input : input.url;
  const method = init?.method ?? (typeof input === "object" ? input.method : undefined) ?? "GET";
  const body = init?.body;
  let bodyPreview = "";
  if (body) {
    if (typeof body === "string") {
      bodyPreview = body.length > 200 ? `  (${body.length} byte body)` : `  body=${body}`;
    } else if (body instanceof Uint8Array || body instanceof ArrayBuffer) {
      const n = body instanceof Uint8Array ? body.byteLength : body.byteLength;
      bodyPreview = `  (${n} byte body)`;
    }
  }
  console.log(`    → ${method} ${url}${bodyPreview}`);
  return origFetch(input, init);
}) as typeof fetch;

// ── Test harness ────────────────────────────────────────────────────
type Result = { name: string; ok: boolean; detail: string };
const results: Result[] = [];
const section = (title: string) => console.log(`\n━━━ ${title} ━━━`);
const check = (name: string, ok: boolean, detail = "") => {
  results.push({ name, ok, detail });
  const icon = ok ? "✅" : "❌";
  console.log(`  ${icon} ${name}${detail ? `  [${detail}]` : ""}`);
};

const decode = (b: Uint8Array) => new TextDecoder().decode(b);

async function sha256(b: Uint8Array): Promise<string> {
  const hash = await crypto.subtle.digest("SHA-256", b as BufferSource);
  return Array.from(new Uint8Array(hash))
    .map((x) => x.toString(16).padStart(2, "0"))
    .join("");
}

// ── 0. Construct client ────────────────────────────────────────────
section("new Arker({ apiKey })");
const arkerClient = new Arker({ apiKey: API_KEY });
console.log(`  default base_url: ${(arkerClient as any).baseUrl}`);
check("client constructed", arkerClient instanceof Arker);

// ── 1. list() — paginated VMs (always hits arker.ai) ──────────────
section("arkerClient.list({ limit: 5 }) — should hit https://arker.ai");
const pageBefore = await arkerClient.list({ limit: 5 });
check(
  "returns VmList",
  pageBefore.items.every((s: VmSummary) => typeof s.vm_id === "string"),
  `total=${pageBefore.total} items=${pageBefore.items.length}`,
);
for (const summary of pageBefore.items.slice(0, 3)) {
  console.log(
    `     · ${summary.vm_id}  name=${JSON.stringify(summary.name)}  region=${summary.region}  created=${summary.created_at}`,
  );
}

// ── 2. vm() — open handle, no network call ─────────────────────────
section(`arkerClient.vm("${SOURCE_VM}") — handle, no network call`);
const source = arkerClient.vm(SOURCE_VM);
check(
  `arkerClient.vm("${SOURCE_VM}") returns Computer`,
  source instanceof Computer && source.id === SOURCE_VM,
  `id="${source.id}"`,
);

// ── 3. fork() ──────────────────────────────────────────────────────
section(`source.fork({ name: "ts-sdk-demo" }) — fork from ${SOURCE_VM}`);
const vm = await source.fork({ name: "ts-sdk-demo" });
check(
  "fork returns Computer with new ULID id",
  vm instanceof Computer && vm.id !== "arkuntu" && vm.id.length >= 26,
  `vm.id=${vm.id}`,
);

let allOk = true;
try {
  // ── 4. run(simple command) ─────────────────────────────────────
  section('vm.run("echo hello") — POST .../run');
  const runResult: RunResult = await vm.run("echo hello-from-ts-sdk");
  check(
    "run returns RunResult",
    typeof runResult.exitCode === "number",
    `exit=${runResult.exitCode} duration_ms=${Math.round(runResult.durationMs)}`,
  );
  check("stdout matches", decode(runResult.stdout) === "hello-from-ts-sdk\n", `stdout=${JSON.stringify(decode(runResult.stdout))}`);

  // ── 5. writeFile (small) ───────────────────────────────────────
  section('vm.sync.writeFile("/home/user/small.txt", ...) — single call');
  const payloadSmall = new TextEncoder().encode("hello-small-payload\n");
  await vm.sync.writeFile("/home/user/small.txt", payloadSmall);
  check("small write returned", true, `${payloadSmall.length} bytes`);

  // ── 6. readFile (small / inline) ───────────────────────────────
  section('vm.sync.readFile("/home/user/small.txt") — inline response');
  const backSmall = await vm.sync.readFile("/home/user/small.txt");
  check(
    "small round-trip",
    decode(backSmall) === decode(payloadSmall),
    `${backSmall.length} bytes`,
  );

  // ── 7. cat the file via run() ──────────────────────────────────
  section('vm.run("cat /home/user/small.txt") — same bytes via shell');
  const catResult = await vm.run("cat /home/user/small.txt");
  check(
    "shell sees the SDK-written file",
    catResult.exitCode === 0 && decode(catResult.stdout) === decode(payloadSmall),
    `stdout=${JSON.stringify(decode(catResult.stdout))}`,
  );

  // ── 8. writeFile (large / presigned bypass) ────────────────────
  section("vm.sync.writeFile(big_blob) — large payload uses presigned upload");
  // crypto.getRandomValues has a 64 KB per-call limit; fill in chunks.
  const payloadBig = new Uint8Array(8 * 1024 * 1024);
  for (let off = 0; off < payloadBig.length; off += 65536) {
    crypto.getRandomValues(payloadBig.subarray(off, Math.min(off + 65536, payloadBig.length)));
  }
  const t0 = Date.now();
  await vm.sync.writeFile("/home/user/big.bin", payloadBig);
  check("8 MiB write returned", true, `${Date.now() - t0}ms`);

  // ── 9. readFile (large) ────────────────────────────────────────
  section("vm.sync.readFile(big_blob) — handles inline-or-presigned automatically");
  const t1 = Date.now();
  const backBig = await vm.sync.readFile("/home/user/big.bin");
  const same = (await sha256(backBig)) === (await sha256(payloadBig));
  check("8 MiB round-trip integrity", same, `${Date.now() - t1}ms, sha256 ${same ? "match" : "MISMATCH"}`);

  // ── 10. fork from existing VM ──────────────────────────────────
  section('vm.fork({ name: "branch" }) — fork an existing VM');
  const child = await vm.fork({ name: "ts-sdk-demo-child" });
  check(
    "child has new id",
    child instanceof Computer && child.id !== vm.id,
    `child.id=${child.id}`,
  );

  // ── 11. child sees parent's filesystem ─────────────────────────
  section('child.run("cat /home/user/small.txt") — child inherits parent state');
  const childCat = await child.run("cat /home/user/small.txt");
  check(
    "child sees parent's file",
    childCat.exitCode === 0 && decode(childCat.stdout) === decode(payloadSmall),
    `stdout=${JSON.stringify(decode(childCat.stdout))}`,
  );
  await child.delete();
  check("child.delete() succeeded", true);

  // ── 12. error path ─────────────────────────────────────────────
  section("error path: vm.sync.readFile('/home/user/does-not-exist.txt')");
  try {
    await vm.sync.readFile("/home/user/does-not-exist.txt");
    check("missing file raises ArkerError", false, "no exception raised");
  } catch (err) {
    if (err instanceof ArkerError) {
      check(
        "ArkerError(not_found, status=404)",
        err.code === "not_found" && err.status === 404,
        `code="${err.code}" status=${err.status}`,
      );
    } else {
      check("missing file raises ArkerError", false, `wrong error type: ${err}`);
    }
  }

  // ── 13. list() filter ──────────────────────────────────────────
  section('arkerClient.list({ q: "ts-sdk-demo" }) — filter shows the VMs we just made');
  const pageAfter = await arkerClient.list({ q: "ts-sdk-demo" });
  check(
    "list filters by name substring",
    pageAfter.items.some((s: VmSummary) => s.vm_id === vm.id),
    `total=${pageAfter.total} matched`,
  );
} catch (err) {
  console.error("Unexpected error:", err);
  allOk = false;
} finally {
  // ── 14. delete() — cleanup ───────────────────────────────────
  section("vm.delete() — cleanup");
  try {
    await vm.delete();
    check("vm.delete() succeeded", true);
  } catch (e) {
    check("vm.delete() succeeded", false, String(e));
  }
}

// ── Summary ─────────────────────────────────────────────────────────
const total = results.length;
const passed = results.filter((r) => r.ok).length;
console.log(`\n━━━ SUMMARY ━━━\n  ${passed}/${total} passed`);
if (passed !== total) {
  console.log("  Failures:");
  for (const r of results) if (!r.ok) console.log(`    × ${r.name}  [${r.detail}]`);
}
process.exit(passed === total && allOk ? 0 : 1);
