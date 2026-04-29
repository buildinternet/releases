/**
 * Tests for the scrape-path routing logic that detects a brand-new source
 * (zero known releases) and sends it to full agent extraction rather than
 * the incremental Haiku path.
 *
 * The decision is exposed as `isSeedRun`; these tests exercise the helper
 * directly so a regression of the routing condition fails here.
 */

import { describe, it, expect } from "bun:test";
import type { KnownRelease } from "@releases/adapters/extract";
import { isSeedRun } from "../../workers/discovery/src/scrape-fetch";

const oneRelease: KnownRelease[] = [{ title: "v1.0.0", version: "1.0.0", publishedAt: null }];

describe("isSeedRun", () => {
  it("returns true when knownReleases is empty (new source)", () => {
    expect(isSeedRun([])).toBe(true);
  });

  it("returns false when at least one release is known", () => {
    expect(isSeedRun(oneRelease)).toBe(false);
  });
});
