/**
 * Detect whether a release version string represents a pre-release.
 *
 * Used at ingest time as a fallback for non-GitHub adapters (the GitHub
 * adapter uses the API's authoritative `prerelease` field instead). Matches
 * the SemVer pre-release convention — anything after a `-` separator that
 * begins with a recognized identifier (`alpha`, `beta`, `rc`, `pre`,
 * `preview`, `nightly`, `dev`, `canary`, `next`, `snapshot`, `milestone`,
 * `m1`/`M1`, etc.). Date-suffixed nightlies (`-nightly.20260506`) and
 * commit-suffixed previews (`-preview.1.g80d269054`) match too.
 *
 * Conservative on purpose — when in doubt, return false so we don't
 * accidentally hide a real release. The flag is a UX nicety, not a
 * security boundary.
 */
const PRERELEASE_TAG_RE =
  /[-.](?:alpha|beta|rc|pre|preview|nightly|dev|canary|next|snapshot|milestone|m\d+|edge|insider|experimental|test|early-access|ea)\b/i;

export function isPrereleaseVersion(version: string | null | undefined): boolean {
  if (!version) return false;
  const trimmed = version.trim();
  if (!trimmed) return false;
  return PRERELEASE_TAG_RE.test(trimmed);
}
