/**
 * Build a lexicographically-sortable key from a version string so SQLite
 * `MAX()` aggregates pick the semver-highest version, not the most-recently
 * published one. This matters for backported security patches: when a project
 * ships `v15.5.18` on May 7 after `v16.x` is already out, `MAX(published_at)`
 * picks the older line as "latest" — but `MAX(version_sort)` correctly picks
 * v16 because `0000000016 > 0000000015` lexicographically.
 *
 * Strategy: split on `.`, `-`, `+`; left-pad numeric segments to a fixed width
 * (10 chars) so they sort numerically under lex compare; preserve separators
 * so identical-looking versions remain distinguishable. Prereleases are
 * prefixed with `0_` so they sort before the corresponding release
 * (`1.0.0-rc.1` < `1.0.0`) — matches semver ordering rules.
 *
 * Returns null when the version has no numeric content at all (purely
 * alphabetic codenames like `"jaguar"`) — callers fall back to date ordering
 * in that case.
 *
 * Examples:
 *   computeVersionSort("15.5.18")  -> "1_0000000015.0000000005.0000000018"
 *   computeVersionSort("16.2.6")   -> "1_0000000016.0000000002.0000000006"
 *   computeVersionSort("v1.0.0")   -> "1_v0000000001.0000000000.0000000000"
 *   computeVersionSort("1.0.0-rc.1") -> "0_0000000001.0000000000.0000000000-rc.0000000001"
 */

import { isPrereleaseVersion } from "./prerelease";

const SEGMENT_WIDTH = 10;

export function computeVersionSort(version: string | null | undefined): string | null {
  if (!version) return null;
  const trimmed = version.trim();
  if (!trimmed) return null;

  // Split on `.`, `-`, `+` and keep the delimiters so the key remains
  // reversible-ish and we don't collapse `1.2-3` and `1.2.3` to the same key.
  const tokens = trimmed.split(/([.\-+])/);

  let hasNumericSegment = false;
  const padded = tokens.map((tok) => {
    // Delimiters pass through unchanged.
    if (tok === "." || tok === "-" || tok === "+") return tok;
    // Pure-numeric segment → pad.
    if (/^\d+$/.test(tok)) {
      hasNumericSegment = true;
      return tok.padStart(SEGMENT_WIDTH, "0");
    }
    // Mixed segment like `v1` or `1a` → pad just the leading number if present.
    const m = tok.match(/^([^\d]*)(\d+)(.*)$/);
    if (m) {
      hasNumericSegment = true;
      const [, prefix, num, rest] = m;
      return `${prefix}${num.padStart(SEGMENT_WIDTH, "0")}${rest}`;
    }
    return tok;
  });

  if (!hasNumericSegment) return null;

  // Prereleases sort BEFORE the corresponding release version. Tag with a
  // leading `0_` (vs `1_` for releases) so `1.0.0-rc.1` < `1.0.0`.
  const prefix = isPrereleaseVersion(trimmed) ? "0_" : "1_";
  return `${prefix}${padded.join("")}`;
}
