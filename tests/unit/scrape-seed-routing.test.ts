/**
 * Tests for the scrape-path routing logic that detects a brand-new source
 * (zero known releases) and sends it to full agent extraction rather than
 * the incremental Haiku path.
 *
 * `isSeedRun` and `shouldUseAgentExtraction` are exported helpers; these
 * tests exercise them directly so a regression of the routing condition fails
 * here.
 *
 * Also covers the CRAWL_SYSTEM_PROMPT export and verifies its shape so that
 * a regression (e.g. accidentally reintroducing the "Keep content concise"
 * summarization rule) fails here rather than in a live smoke test.
 */

import { describe, it, expect } from "bun:test";
import type { KnownRelease } from "@releases/adapters/extract";
import { CRAWL_SYSTEM_PROMPT, CRAWL_EXTRACTION_RULES } from "@releases/adapters/extract";
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

// ── CRAWL_SYSTEM_PROMPT shape ─────────────────────────────────────────────────
//
// Verifies that the crawl prompt:
//   1. Is exported from the extract module.
//   2. Omits the "Keep content concise" / "Don't reproduce entire pages" rules
//      present in EXTRACTION_RULES (those rules cause summarization; crawl
//      input is already one-release-per-page and must be preserved verbatim).
//   3. Instructs the model to preserve full per-page bodies.
//   4. Instructs the model to use the "# <url>" heading as the canonical URL.
//
// These assertions are the compile-time equivalent of the smoke-test check
// (bodies > 1500 bytes). If someone edits the prompt to add summarization back,
// this suite fails here instead of in production.

describe("CRAWL_EXTRACTION_RULES", () => {
  it("is exported from the extract module", () => {
    expect(typeof CRAWL_EXTRACTION_RULES).toBe("string");
    expect(CRAWL_EXTRACTION_RULES.length).toBeGreaterThan(0);
  });

  it("does NOT contain 'Keep content concise'", () => {
    expect(CRAWL_EXTRACTION_RULES).not.toContain("Keep content concise");
  });

  it("does NOT contain 'Don't reproduce entire pages'", () => {
    expect(CRAWL_EXTRACTION_RULES).not.toContain("Don't reproduce entire pages");
  });

  it("instructs to preserve the full body markdown", () => {
    expect(CRAWL_EXTRACTION_RULES.toLowerCase()).toContain("preserve the full body");
  });

  it("instructs to use the URL in the section heading", () => {
    expect(CRAWL_EXTRACTION_RULES.toLowerCase()).toContain("url");
    expect(CRAWL_EXTRACTION_RULES).toContain("# <url>");
  });
});

describe("CRAWL_SYSTEM_PROMPT", () => {
  it("is exported from the extract module", () => {
    expect(typeof CRAWL_SYSTEM_PROMPT).toBe("string");
    expect(CRAWL_SYSTEM_PROMPT.length).toBeGreaterThan(0);
  });

  it("references the crawl page-per-heading structure", () => {
    expect(CRAWL_SYSTEM_PROMPT).toContain("# <url>");
  });

  it("instructs the model NOT to summarize", () => {
    expect(CRAWL_SYSTEM_PROMPT).toContain("Do NOT summarize");
  });

  it("instructs the model to skip the index page", () => {
    expect(CRAWL_SYSTEM_PROMPT.toLowerCase()).toContain("index page");
  });

  it("embeds CRAWL_EXTRACTION_RULES verbatim", () => {
    expect(CRAWL_SYSTEM_PROMPT).toContain(CRAWL_EXTRACTION_RULES);
  });

  it("does NOT contain 'Keep content concise'", () => {
    // Guard against EXTRACTION_RULES leaking into the crawl prompt.
    expect(CRAWL_SYSTEM_PROMPT).not.toContain("Keep content concise");
  });

  it("does NOT contain 'Don't reproduce entire pages'", () => {
    expect(CRAWL_SYSTEM_PROMPT).not.toContain("Don't reproduce entire pages");
  });
});
