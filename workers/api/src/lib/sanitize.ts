/**
 * Common request-payload sanitizers shared by routes that accept caller-
 * controlled strings (telemetry events, search-query log, etc.). Trims
 * whitespace, caps length, and treats the empty string as null.
 */
export function sanitizeString(v: unknown, max: number): string | null {
  if (typeof v !== "string") return null;
  const trimmed = v.trim().slice(0, max);
  return trimmed.length > 0 ? trimmed : null;
}

export function sanitizeInt(v: unknown): number | null {
  if (typeof v !== "number" || !Number.isFinite(v)) return null;
  return Math.trunc(v);
}
