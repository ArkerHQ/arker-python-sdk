import assert from "node:assert/strict";

import { deleteBenchmarkVms, withBenchmarkVmCleanup } from "../benchmarks/live-helpers.mjs";

async function testCleanupRequiresPositiveAcknowledgement() {
  await assert.rejects(
    () => deleteBenchmarkVms([{
      id: "vm_not_deleted",
      delete: async () => ({ deleted: false }),
    }]),
    (error) => {
      assert.ok(error instanceof AggregateError);
      assert.match(String(error.errors[0]), /deletion was not acknowledged/);
      return true;
    },
  );
}

async function testCleanupAttemptsEveryVmAndReportsFailures() {
  const attempted = [];
  await assert.rejects(
    () => deleteBenchmarkVms([
      {
        id: "vm_deleted",
        delete: async () => {
          attempted.push("vm_deleted");
          return { deleted: true };
        },
      },
      {
        id: "vm_rejected",
        delete: async () => {
          attempted.push("vm_rejected");
          throw new Error("delete failed");
        },
      },
    ]),
    /failed to delete 1 benchmark VM/,
  );
  assert.deepEqual(attempted.sort(), ["vm_deleted", "vm_rejected"]);
}

async function testBenchmarkAndCleanupFailuresAreBothPreserved() {
  await assert.rejects(
    () => withBenchmarkVmCleanup(
      [{
        id: "vm_cleanup_failed",
        delete: async () => ({ deleted: false }),
      }],
      async () => { throw new Error("benchmark failed"); },
    ),
    (error) => {
      assert.ok(error instanceof AggregateError);
      assert.match(error.message, /benchmark and VM cleanup both failed/);
      assert.match(String(error.errors[0]), /benchmark failed/);
      assert.match(String(error.errors[1]), /failed to delete 1 benchmark VM/);
      return true;
    },
  );
}

await testCleanupRequiresPositiveAcknowledgement();
await testCleanupAttemptsEveryVmAndReportsFailures();
await testBenchmarkAndCleanupFailuresAreBothPreserved();

console.log("PASS live benchmark cleanup");
