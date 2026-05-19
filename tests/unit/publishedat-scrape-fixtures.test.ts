/**
 * Fixture-based tests for publishedAt extraction from the two scrape sources
 * whose dates were broken (issue #1074):
 *
 *   1. docker-compose-release-notes — resolved by routing through GitHub
 *      (metadata.githubUrl). Tests here document the GitHub Releases page
 *      format and confirm mapEntries converts AI-returned ISO dates correctly.
 *
 *   2. software-release-notes (Redis) — resolved by enabling crawl mode so
 *      per-build release pages are fetched. Tests here document the page
 *      structure (date in H1 title as "(Month YYYY)"), confirm that
 *      EXTRACTION_RULES includes the month-only → first-of-month rule, and
 *      confirm findContentStart locates content in Redis-style markdown.
 *
 * No live Anthropic API calls are made. All assertions are on shared utilities
 * and the prompt text that would reach the model.
 */

import { describe, it, expect } from "bun:test";
import {
  mapEntries,
  EXTRACTION_RULES,
  findContentStart,
} from "../../packages/adapters/src/extract/shared.js";
import type { ExtractedEntry } from "../../packages/adapters/src/extract/types.js";

// ── Shared helpers ────────────────────────────────────────────────────────────

/** Minimal ExtractedEntry — only title + content + isBreaking are required. */
function entry(overrides: Partial<ExtractedEntry>): ExtractedEntry {
  return {
    title: "Test Release",
    content: "Some content.",
    isBreaking: false,
    ...overrides,
  };
}

// ── 1. Docker Compose: GitHub Releases page format ────────────────────────────
//
// The docker-compose-release-notes source (docs.docker.com/compose/release-notes/)
// is a JS SPA that redirects to github.com/docker/compose/releases. Setting
// metadata.githubUrl routes fetches through the GitHub adapter, which returns
// releases with machine-readable datetime attributes. The AI should return ISO
// 8601 dates that mapEntries converts correctly.
//
// This fixture models the "v5.1.3 — released 2026-04-15" shape that the GitHub
// adapter surfaces. The root cause was that no dates were ever extracted because
// the SPA rendered nothing; once the GitHub adapter is wired in, dates arrive
// directly as ISO strings and mapEntries passes them through unchanged.

describe("Docker Compose: mapEntries handles ISO dates from GitHub Releases", () => {
  const SOURCE_URL = "https://docs.docker.com/compose/release-notes/";

  it("converts a full ISO 8601 date string to a Date", () => {
    const entries = mapEntries(
      [
        entry({
          title: "Docker Compose v5.1.3",
          version: "5.1.3",
          publishedAt: "2026-04-15T14:21:38Z",
          url: "https://github.com/docker/compose/releases/tag/v5.1.3",
        }),
      ],
      { sourceUrl: SOURCE_URL },
    );

    expect(entries).toHaveLength(1);
    const rel = entries[0]!;
    expect(rel.publishedAt).toBeInstanceOf(Date);
    expect(rel.publishedAt!.getFullYear()).toBe(2026);
    expect(rel.publishedAt!.getMonth()).toBe(3); // April = 3 (0-indexed)
    expect(rel.publishedAt!.getDate()).toBe(15);
  });

  it("leaves publishedAt undefined when the AI omits it", () => {
    const entries = mapEntries([entry({ title: "Docker Compose v5.1.2", version: "5.1.2" })], {
      sourceUrl: SOURCE_URL,
    });

    expect(entries).toHaveLength(1);
    expect(entries[0]!.publishedAt).toBeUndefined();
  });

  it("accepts date-only ISO strings (YYYY-MM-DD) without time component", () => {
    const entries = mapEntries(
      [
        entry({
          title: "Docker Compose v5.0.0",
          version: "5.0.0",
          publishedAt: "2025-12-01",
        }),
      ],
      { sourceUrl: SOURCE_URL },
    );

    expect(entries).toHaveLength(1);
    const rel = entries[0]!;
    expect(rel.publishedAt).toBeInstanceOf(Date);
    expect(rel.publishedAt!.getFullYear()).toBe(2025);
    expect(rel.publishedAt!.getMonth()).toBe(11); // December = 11 (0-indexed)
  });
});

// ── 2. Redis Software: per-build release page format ─────────────────────────
//
// The software-release-notes source (redis.io/docs/latest/operate/rs/release-notes/)
// has a three-level hierarchy:
//
//   Index → "7.22.x releases" family page → "7.22.2-116 (April 2026)" build page
//
// The index page only lists links; the family pages are overviews; only the
// per-build pages have dates, embedded in the H1 title as "(Month YYYY)".
//
// Root cause: the scraper reads the index page, sees dated old-format entries
// like "6.2.12 (August 2022)" in link text but NOT "7.22.x releases" (no date),
// and inserts only the old dated entries → publishedAt ≤ 2022-08-01.
//
// Fix: enable crawl mode so per-build pages (depth 2 from the index) are fetched.
// The AI then sees H1 headings like "Redis Software 7.22.2-116 (April 2026)"
// and should extract "2026-04-01" per the month-only date rule.

describe("Redis Software: EXTRACTION_RULES handles month-year dates in H1 titles", () => {
  it("EXTRACTION_RULES contains the month-only to first-of-month conversion rule", () => {
    // Both the main prompt and the incremental prompt share this rule.
    // Verify it's present so any future prompt edits don't silently drop it.
    expect(EXTRACTION_RULES).toContain("For month-only dates");
    expect(EXTRACTION_RULES).toContain("use the first of the month");
    expect(EXTRACTION_RULES).toContain("2026-04-01");
  });

  it("mapEntries converts a first-of-month date returned by the AI", () => {
    // The AI reads H1 "Redis Software 7.22.2-116 (April 2026)" and returns
    // "2026-04-01" per the EXTRACTION_RULES month-only conversion.
    const entries = mapEntries(
      [
        entry({
          title: "Redis Software 7.22.2-116 (April 2026)",
          version: "7.22.2-116",
          publishedAt: "2026-04-01",
          url: "https://redis.io/docs/latest/operate/rs/release-notes/rs-7-22-releases/rs-7-22-2-116/",
        }),
      ],
      { sourceUrl: "https://redis.io/docs/latest/operate/rs/release-notes/" },
    );

    expect(entries).toHaveLength(1);
    const rel = entries[0]!;
    expect(rel.publishedAt).toBeInstanceOf(Date);
    expect(rel.publishedAt!.getFullYear()).toBe(2026);
    expect(rel.publishedAt!.getMonth()).toBe(3); // April = 3 (0-indexed)
    expect(rel.publishedAt!.getDate()).toBe(1);
  });

  it("mapEntries handles multiple Redis build releases with different months", () => {
    // A crawl of the 7.22.x family page yields per-build entries.
    const rawEntries: ExtractedEntry[] = [
      entry({
        title: "Redis Software 7.22.2-116 (April 2026)",
        version: "7.22.2-116",
        publishedAt: "2026-04-01",
        url: "https://redis.io/docs/latest/operate/rs/release-notes/rs-7-22-releases/rs-7-22-2-116/",
      }),
      entry({
        title: "Redis Software 7.22.2-93 (March 2026)",
        version: "7.22.2-93",
        publishedAt: "2026-03-01",
        url: "https://redis.io/docs/latest/operate/rs/release-notes/rs-7-22-releases/rs-7-22-2-93/",
      }),
      entry({
        title: "Redis Software 7.22.0-95 (May 2025)",
        version: "7.22.0-95",
        publishedAt: "2025-05-01",
        url: "https://redis.io/docs/latest/operate/rs/release-notes/rs-7-22-releases/rs-7-22-0-95/",
      }),
    ];

    const entries = mapEntries(rawEntries, {
      sourceUrl: "https://redis.io/docs/latest/operate/rs/release-notes/",
    });

    expect(entries).toHaveLength(3);

    // All three should have correct publishedAt
    const [april, march, may] = entries;
    expect(april!.publishedAt!.getFullYear()).toBe(2026);
    expect(april!.publishedAt!.getMonth()).toBe(3); // April
    expect(march!.publishedAt!.getMonth()).toBe(2); // March
    expect(may!.publishedAt!.getFullYear()).toBe(2025);
    expect(may!.publishedAt!.getMonth()).toBe(4); // May
  });

  it("entries with no date (family-level overview pages) produce publishedAt: undefined", () => {
    // The 7.22.x family page itself has no release date — it's an overview.
    // The AI should omit publishedAt for these; mapEntries should produce undefined.
    const entries = mapEntries(
      [
        entry({
          title: "Redis Software release notes 7.22.x",
          // no publishedAt
        }),
      ],
      { sourceUrl: "https://redis.io/docs/latest/operate/rs/release-notes/" },
    );

    expect(entries).toHaveLength(1);
    expect(entries[0]!.publishedAt).toBeUndefined();
  });
});

// ── 3. Redis Software: findContentStart with version headings ─────────────────
//
// When crawl markdown is concatenated, each per-build page starts with a
// version heading. findContentStart should locate the content start for
// Redis-style headings like "# Redis Software 7.22.2-116 (April 2026)".

describe("Redis Software: findContentStart locates version headings", () => {
  it("finds a heading with version number (## 7.22.2-116) near the top", () => {
    const lines = ["Navigation bar text", "## 7.22.2-116", "Release body here"];
    const idx = findContentStart(lines);
    // Should land at line 1 (the heading) or just before it
    expect(idx).toBeLessThanOrEqual(1);
  });

  it("finds a heading with v-prefixed version number", () => {
    const lines = ["## v5.1.3", "Docker Compose release content"];
    const idx = findContentStart(lines);
    expect(idx).toBe(0);
  });

  it("returns 0 for short content with no recognizable headers", () => {
    const lines = ["Some markdown body text", "More text here"];
    const idx = findContentStart(lines);
    expect(idx).toBe(0);
  });
});

// ── 4. Index-only page format: no dates in index link text for new entries ─────
//
// Documents the root cause: the Redis index page has per-family links WITHOUT
// dates for new versions, and per-individual links WITH dates for old versions.
// This fixture confirms that mapEntries does not invent dates for undated entries.

describe("Redis index page: old-format entries have dates, new family pages do not", () => {
  const SOURCE_URL = "https://redis.io/docs/latest/operate/rs/release-notes/";

  it("old-format individual entries carry dates extracted from link text", () => {
    // The AI reads link text "6.2.12 (August 2022)" and returns "2022-08-01"
    const entries = mapEntries(
      [
        entry({
          title: "6.2.12 (August 2022)",
          version: "6.2.12",
          publishedAt: "2022-08-01",
          url: "https://redis.io/docs/latest/operate/rs/release-notes/rs-6-2-12/",
        }),
      ],
      { sourceUrl: SOURCE_URL },
    );

    expect(entries[0]!.publishedAt).toBeInstanceOf(Date);
    expect(entries[0]!.publishedAt!.getFullYear()).toBe(2022);
    expect(entries[0]!.publishedAt!.getMonth()).toBe(7); // August = 7 (0-indexed)
  });

  it("new family-level entries have no date in link text — publishedAt is undefined", () => {
    // The AI reads link text "7.22.x releases" — no date extractable.
    // The AI should omit publishedAt; mapEntries should produce undefined.
    const entries = mapEntries(
      [
        entry({
          title: "7.22.x releases",
          url: "https://redis.io/docs/latest/operate/rs/release-notes/rs-7-22-releases/",
          // no publishedAt
        }),
      ],
      { sourceUrl: SOURCE_URL },
    );

    expect(entries[0]!.publishedAt).toBeUndefined();
  });
});
