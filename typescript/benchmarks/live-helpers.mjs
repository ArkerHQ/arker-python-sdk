export async function deleteBenchmarkVms(vms) {
  const cleanup = await Promise.allSettled(vms.map(async (vm) => {
    const acknowledgement = await vm.delete();
    if (acknowledgement?.deleted !== true) {
      throw new Error(`VM ${vm.id} deletion was not acknowledged`);
    }
  }));
  const cleanupErrors = cleanup
    .filter((result) => result.status === "rejected")
    .map((result) => result.reason);
  if (cleanupErrors.length > 0) {
    throw new AggregateError(cleanupErrors, `failed to delete ${cleanupErrors.length} benchmark VM(s)`);
  }
}

export async function withBenchmarkVmCleanup(vms, benchmark) {
  let benchmarkError;
  try {
    await benchmark();
  } catch (error) {
    benchmarkError = error;
  }

  let cleanupError;
  try {
    await deleteBenchmarkVms(vms);
  } catch (error) {
    cleanupError = error;
  }

  if (benchmarkError && cleanupError) {
    throw new AggregateError([benchmarkError, cleanupError], "benchmark and VM cleanup both failed");
  }
  if (benchmarkError) throw benchmarkError;
  if (cleanupError) throw cleanupError;
}
