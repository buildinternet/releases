/**
 * Title-hierarchy logic for the chronological release feed (`ReleaseListItem`).
 *
 * The feed leads with a *descriptive* headline and demotes the version, instead
 * of using a bare `v2.1.154` as the headline (which loses product context). The
 * pure decisions live here so the rendering component stays a thin view layer
 * and the edge cases (bare-version detection, version normalization, AI-title
 * preference) are unit-tested. See
 * `.context/2026-05-29-feed-version-title-hierarchy.md`.
 */

import { fmtVersion } from "@/lib/cadence";

/**
 * Normalize a version string for display, tolerating null/whitespace input
 * (returns `null`). The "v"-prefix formatting itself is delegated to the
 * canonical `fmtVersion` — prepend "v" only for semver-ish versions, leave
 * already-prefixed (`v2.1.154`) and non-numeric tags (`R3`) untouched.
 */
export function normalizeVersionLabel(version: string | null | undefined): string | null {
  const v = version?.trim();
  return v ? fmtVersion(v) : null;
}

/**
 * True when the parsed title is just the version restated (with or without a
 * leading "v"), i.e. it carries no information beyond the version itself. An
 * empty title is treated as bare when a version exists. Returns `false` when
 * there is no version (a title can't be "just the version" if there isn't one).
 */
const stripV = (s: string) => s.replace(/^v/i, "");

export function titleIsBareVersion(title: string, version: string | null | undefined): boolean {
  const v = version?.trim();
  if (!v) return false;
  const t = title.trim();
  if (!t) return true;
  return t === v || stripV(t) === stripV(v);
}

export interface FeedTitleInput {
  title: string;
  version: string | null;
  titleGenerated?: string | null;
  titleShort?: string | null;
}

export interface FeedTitleParts {
  /**
   * The descriptive headline text when one exists: the AI smart-brevity title,
   * then the AI long title, then a raw parsed title that isn't merely the
   * version. `null` when the row has nothing more descriptive than its version
   * number — the caller then falls back to a product+version headline.
   */
  descriptive: string | null;
  /** Normalized version label (`v2.1.154`) or `null` when the row has no version. */
  versionLabel: string | null;
}

/**
 * Derive the headline + version parts for a feed row. The caller composes the
 * final layout (where the product name appears, what's dimmed) from these plus
 * its own source-context knowledge.
 */
export function deriveFeedTitle(input: FeedTitleInput): FeedTitleParts {
  const aiTitle = input.titleShort?.trim() || input.titleGenerated?.trim() || null;
  const rawTitle = input.title?.trim() || null;
  const descriptiveRaw =
    rawTitle && !titleIsBareVersion(input.title, input.version) ? rawTitle : null;
  return {
    descriptive: aiTitle || descriptiveRaw,
    versionLabel: normalizeVersionLabel(input.version),
  };
}
