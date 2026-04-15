/**
 * Pure range helpers for CHANGELOG slicing. Split from `changelog-slice.ts`
 * so the web app can parse range query params without transitively pulling
 * `js-tiktoken` (which the slicer needs for token-mode encoding).
 */

export const DEFAULT_CHANGELOG_SLICE_LIMIT = 40_000;

export function parseRangeParam(raw: string | null | undefined): number | undefined {
  if (raw == null || raw === "") return undefined;
  const n = Number(raw);
  if (!Number.isFinite(n)) return undefined;
  return n;
}
