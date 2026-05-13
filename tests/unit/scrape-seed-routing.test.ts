/**
 * Tests for the scrape-path routing logic that detects a brand-new source
 * (zero known releases) and sends it to full agent extraction rather than
 * the incremental Haiku path.
 *
 * `isSeedRun` and `shouldUseAgentExtraction` are exported helpers; these
 * tests exercise them directly so a regression of the routing condition fails
 * here.
 */

import { describe, it, expect } from "bun:test";
import type { KnownRelease } from "@releases/adapters/extract";
import { isSeedRun, shouldUseAgentExtraction } from "../../workers/discovery/src/scrape-fetch";

const oneRelease: KnownRelease[] = [{ title: "v1.0.0", version: "1.0.0", publishedAt: null }];

describe("isSeedRun", () => {
  it("returns true when knownReleases is empty (new source)", () => {
    expect(isSeedRun([])).toBe(true);
  });

  it("returns false when at least one release is known", () => {
    expect(isSeedRun(oneRelease)).toBe(false);
  });
});

describe("shouldUseAgentExtraction", () => {
  it("returns true on seed run (no known releases), not from crawl", () => {
    expect(shouldUseAgentExtraction(false, [])).toBe(true);
  });

  it("returns false when releases are known and markdown is not from crawl", () => {
    expect(shouldUseAgentExtraction(false, oneRelease)).toBe(false);
  });

  it("returns true when markdown came from crawl, even with known releases", () => {
    // Crawl output must bypass incremental extraction because incremental
    // deduplicates by title — per-post pages share titles with existing
    // fragment-URL rows and would produce zero new inserts.
    expect(shouldUseAgentExtraction(true, oneRelease)).toBe(true);
  });

  it("returns true when markdown came from crawl and there are no known releases", () => {
    expect(shouldUseAgentExtraction(true, [])).toBe(true);
  });
});
