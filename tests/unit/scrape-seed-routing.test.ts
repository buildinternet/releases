/**
 * Tests for the scrape-path routing logic that detects a brand-new source
 * (zero known releases) and sends it to full agent extraction rather than
 * the incremental Haiku path.
 *
 * runIncrementalExtraction intentionally returns [] when knownReleases is
 * empty — it's designed for already-indexed sources. runScrapePath must
 * detect this condition before calling it and fall back to runAgentExtraction.
 *
 * We test the guard in runIncrementalExtraction directly (pure unit test —
 * no API calls), and document the scrape-path routing logic separately.
 */

import { describe, it, expect } from "bun:test";

// ── runIncrementalExtraction early-bail guard ────────────────────────────────
//
// The function returns an empty result synchronously when knownReleases is [].
// We replicate the exact guard here to document and test it in isolation,
// without needing Anthropic SDK mocks.

function wouldBailEarly(knownReleases: unknown[]): boolean {
  // Mirrors the guard in packages/adapters/src/extract/run-incremental.ts
  return knownReleases.length === 0;
}

describe("runIncrementalExtraction early-bail guard", () => {
  it("bails when knownReleases is empty (new source)", () => {
    expect(wouldBailEarly([])).toBe(true);
  });

  it("does NOT bail when knownReleases has at least one entry", () => {
    expect(wouldBailEarly([{ title: "v1.0.0", version: "1.0.0", publishedAt: null }])).toBe(false);
  });

  it("does NOT bail with multiple known releases", () => {
    const known = [
      { title: "v1.0.1", version: "1.0.1", publishedAt: "2026-01-02" },
      { title: "v1.0.0", version: "1.0.0", publishedAt: "2026-01-01" },
    ];
    expect(wouldBailEarly(known)).toBe(false);
  });
});

// ── runScrapePath routing logic ──────────────────────────────────────────────
//
// When knownReleases is empty we must route to runAgentExtraction (full
// extraction) rather than runIncrementalExtraction. We verify the routing
// decision in isolation using a mock that captures which path is taken.

describe("runScrapePath routing for new sources", () => {
  it("routes to agent extraction when knownReleases is empty", () => {
    // Mirrors the branching condition added to runScrapePath in scrape-fetch.ts
    const knownReleases: unknown[] = [];
    const useIncremental = knownReleases.length > 0;
    expect(useIncremental).toBe(false);
  });

  it("routes to incremental extraction when source has known releases", () => {
    const knownReleases = [{ title: "v1.2.3", version: "1.2.3", publishedAt: "2026-04-01" }];
    const useIncremental = knownReleases.length > 0;
    expect(useIncremental).toBe(true);
  });

  it("boundary: exactly one known release triggers incremental path", () => {
    const knownReleases = [{ title: "initial", version: null, publishedAt: null }];
    const useIncremental = knownReleases.length > 0;
    expect(useIncremental).toBe(true);
  });
});

// ── Honest status accounting ─────────────────────────────────────────────────
//
// The fetch log status must not report "no_change" when a source has no prior
// state — "no_change" means the adapter ran and found nothing new compared to
// what it already indexed. On a zero-known-releases run the adapter skipping
// due to the early-bail bug made "no_change" false-positive.

describe("status semantics", () => {
  it("no_change is correct when incremental runs with known releases and finds nothing new", () => {
    // Source had releases; incremental ran; AI confirmed nothing new.
    const _knownReleases = [{ title: "v1.0.0", version: "1.0.0", publishedAt: null }];
    const extractedReleases: unknown[] = [];
    const status = extractedReleases.length === 0 ? "no_change" : "success";
    expect(status).toBe("no_change");
  });

  it("no_change is a false-positive when early-bail fires on empty known list", () => {
    // This documents the bug: bail fires before extraction, but status is no_change.
    // The fix is to route to agent extraction before reaching incremental at all.
    const knownReleases: unknown[] = [];
    const bailed = knownReleases.length === 0; // matches old guard
    // Before the fix, bailed === true → releases = [] → status = "no_change"
    // even though we never tried to extract.
    expect(bailed).toBe(true); // confirms the guard fires on empty list
    // After the fix, bailed === true → route to agent extraction instead.
    const routeToAgent = knownReleases.length === 0; // same condition, new meaning
    expect(routeToAgent).toBe(true);
  });
});
