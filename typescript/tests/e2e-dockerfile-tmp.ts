/** End-to-end check of SDK-driven Dockerfile builds, TypeScript side.
 *
 * Mirrors the Python e2e: COPY followed by a RUN that depends on the copied
 * file, which is the case the whole design exists for. */

import fs from "node:fs";
import os from "node:os";
import nodePath from "node:path";

import { Arker } from "../src/index.js";

const client = new Arker({
  apiKey: process.env.ARKER_API_KEY!,
  baseUrl: process.env.ARKERD_URL!,
});

const ctx = fs.mkdtempSync(nodePath.join(os.tmpdir(), "arker-e2e-ts-"));
fs.writeFileSync(nodePath.join(ctx, "app.js"), "console.log('hello from app.js')\n");
fs.writeFileSync(nodePath.join(ctx, "package.json"), '{"name":"demo"}\n');
fs.writeFileSync(nodePath.join(ctx, "package-lock.json"), '{"lockfileVersion":3}\n');
fs.writeFileSync(nodePath.join(ctx, "ignored.txt"), "nope\n");
fs.mkdirSync(nodePath.join(ctx, "src"));
fs.writeFileSync(nodePath.join(ctx, "src", "index.txt"), "from-src\n");
fs.writeFileSync(
  nodePath.join(ctx, "Dockerfile"),
  [
    "FROM ubuntu:24.04",
    "WORKDIR /app",
    "COPY app.js /app/app.js",
    "COPY package*.json /app/",
    "COPY src /app/src",
    'ENV GREETING="hello world"',
    "RUN cat /app/app.js > /app/proof.txt",
    'RUN echo "$GREETING" >> /app/proof.txt',
    "",
  ].join("\n"),
);

console.log(">>> building");
const vm = await client.fork({ dockerfile: nodePath.join(ctx, "Dockerfile") });
console.log(`>>> vm ${vm.id}`);

const checks: [string, string][] = [
  ["cat /app/proof.txt", "hello from app.js"],
  ["cat /app/proof.txt", "hello world"],
  ["ls /app/package.json /app/package-lock.json", "package-lock.json"],
  ["ls /app/ignored.txt 2>&1 || true", "No such file"],
  ["cat /app/src/index.txt", "from-src"],
  ["pwd", "/app"],
  ["echo $GREETING", "hello world"],
];

let failures = 0;
for (const [command, expected] of checks) {
  const result = (await vm.run(command)) as { stdout?: string; stderr?: string };
  const out = `${result.stdout ?? ""}${result.stderr ?? ""}`;
  const ok = out.includes(expected);
  if (!ok) failures += 1;
  console.log(`${ok ? "ok  " : "FAIL"} ${JSON.stringify(command)} -> ${JSON.stringify(out.trim().slice(0, 80))}`);
}

console.log(`\n>>> cleaning up ${vm.id}`);
try {
  await vm.delete();
} catch (error) {
  console.log(`warning: delete failed: ${String(error)}`);
}
fs.rmSync(ctx, { recursive: true, force: true });

if (failures > 0) {
  console.log(`\n${failures} check(s) FAILED`);
  process.exit(1);
}
console.log("\nall checks passed");
