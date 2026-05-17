/**
 * Per-category item counts for a release, produced by the AI release-content
 * pass and persisted under `releases.metadata.composition`. Surfaced on the
 * release detail wire shape ("12 fixes · 3 features · 1 enhancement" chip).
 *
 * The shape and parse policy live here in core (not api-types) so the OSS CLI,
 * worker handlers, and the published api-types schema all read the same
 * definition without a cross-package import cycle.
 */
export interface ReleaseComposition {
  bugs: number;
  features: number;
  enhancements: number;
}

/**
 * Extract the composition object from a release's stored `metadata` text blob.
 * Returns `null` for any of the following non-error cases:
 *
 *   - `metadata` is null / empty / not valid JSON,
 *   - the parsed object has no `composition` key,
 *   - `composition` is JSON null (we write this when the model didn't emit counts),
 *   - any of bugs / features / enhancements is missing, non-integer, or negative,
 *   - all three counts are zero (boilerplate / docs case — nothing useful to show).
 *
 * Errors are swallowed because malformed metadata should not break a read path;
 * the chip just falls back to "not shown" and the caller carries on.
 */
export function parseCompositionFromMetadata(
  metadata: string | null | undefined,
): ReleaseComposition | null {
  if (!metadata) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(metadata);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object") return null;
  const composition = (parsed as Record<string, unknown>).composition;
  if (!composition || typeof composition !== "object") return null;
  const c = composition as Record<string, unknown>;
  const bugs = asCount(c.bugs);
  const features = asCount(c.features);
  const enhancements = asCount(c.enhancements);
  if (bugs === null || features === null || enhancements === null) return null;
  if (bugs === 0 && features === 0 && enhancements === 0) return null;
  return { bugs, features, enhancements };
}

function asCount(v: unknown): number | null {
  if (typeof v !== "number") return null;
  if (!Number.isFinite(v) || !Number.isInteger(v) || v < 0) return null;
  return v;
}
