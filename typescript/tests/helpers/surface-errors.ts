const EXPECTED_SURFACE_STUB_CODES = new Set([
  "not_found",
  "not_implemented",
  "unsupported_operation",
]);

export function isExpectedSurfaceStub(code: unknown, message: string): boolean {
  if (typeof code === "string" && EXPECTED_SURFACE_STUB_CODES.has(code)) return true;
  return /not.?implemented|unsupported|not found|404|501/i.test(`${String(code ?? "")} ${message}`);
}
