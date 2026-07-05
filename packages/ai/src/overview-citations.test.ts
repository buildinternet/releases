/**
 * Tests for overview-citations.ts.
 *
 * Coverage:
 *   resolveOverviewCitations
 *     - resolves a valid citation to a body offset
 *     - empty citation list
 *     - strips a leaked trailing Citations:/Sources: section
 *     - drops unknown URLs and quotes not found in the body
 *
 *   clampCitationsToBody
 *     - fully in-bounds citation unchanged
 *     - past end clamped
 *     - zero-width entries filtered
 *     - negative start clamped to 0
 */

import { describe, it, expect, test } from "bun:test";
import {
  clampCitationsToBody,
  decodeHtmlEntities,
  resolveOverviewCitations,
  type OverviewCitation,
} from "./overview-citations.js";

// ── decodeHtmlEntities ───────────────────────────────────────────────────────

describe("decodeHtmlEntities", () => {
  it("decodes each of the five entities", () => {
    expect(decodeHtmlEntities("a &amp; b")).toBe("a & b");
    expect(decodeHtmlEntities("a &lt; b")).toBe("a < b");
    expect(decodeHtmlEntities("a &gt; b")).toBe("a > b");
    expect(decodeHtmlEntities("say &quot;hi&quot;")).toBe('say "hi"');
    expect(decodeHtmlEntities("it&#39;s")).toBe("it's");
  });

  it("decodes mixed entities in one pass", () => {
    expect(decodeHtmlEntities("(string &amp; {}) &lt;T&gt;")).toBe("(string & {}) <T>");
  });

  it("is single-pass: &amp;lt; decodes to &lt;, not <", () => {
    expect(decodeHtmlEntities("&amp;lt;")).toBe("&lt;");
  });

  it("is idempotent on already-decoded text", () => {
    expect(decodeHtmlEntities("foo & bar <T>")).toBe("foo & bar <T>");
  });

  it("leaves unrelated text unchanged", () => {
    expect(decodeHtmlEntities("hello world")).toBe("hello world");
  });
});

// ── resolveOverviewCitations ─────────────────────────────────────────────────

const SRC = "https://acme.dev/releases/v2";
const input = {
  validSources: new Set([SRC]),
  titleBySource: new Map<string, string | null>([[SRC, "v2.0"]]),
};

test("resolveOverviewCitations resolves a valid citation to a body offset", () => {
  const { body, citations } = resolveOverviewCitations(
    "Shipped a new streaming API and faster cold starts.",
    [{ url: SRC, quote: "streaming API" }],
    input,
  );
  expect(body).toBe("Shipped a new streaming API and faster cold starts.");
  expect(citations).toHaveLength(1);
  expect(citations[0]).toMatchObject({
    sourceUrl: SRC,
    title: "v2.0",
    citedText: "streaming API",
  });
  expect(body.slice(citations[0]!.startIndex, citations[0]!.endIndex)).toBe("streaming API");
});

test("resolveOverviewCitations returns no citations when the list is empty", () => {
  const { body, citations } = resolveOverviewCitations("Just a body, no citations.", [], input);
  expect(body).toBe("Just a body, no citations.");
  expect(citations).toEqual([]);
});

test("resolveOverviewCitations strips a trailing Citations:/Sources: section the model leaks into the body", () => {
  // DeepSeek sometimes appends a citations list to the body despite the prompt.
  const leaky =
    "Shipped a new streaming API.\n\nCitations:\nURL: https://acme.dev/releases/v2 — streaming API";
  const { body, citations } = resolveOverviewCitations(
    leaky,
    [{ url: SRC, quote: "streaming API" }],
    input,
  );
  expect(body).toBe("Shipped a new streaming API.");
  expect(body).not.toMatch(/citations/i);
  // The quote still resolves against the cleaned body.
  expect(citations).toHaveLength(1);

  const sources = resolveOverviewCitations("Body text here.\n\nSources: https://x", [], input);
  expect(sources.body).toBe("Body text here.");
});

test("resolveOverviewCitations drops unknown URLs and quotes not found in the body", () => {
  const badUrl = resolveOverviewCitations(
    "Body text here.",
    [{ url: "https://other.com", quote: "Body" }],
    input,
  );
  expect(badUrl.citations).toEqual([]);

  const missingQuote = resolveOverviewCitations(
    "Body text here.",
    [{ url: SRC, quote: "not in body" }],
    input,
  );
  expect(missingQuote.citations).toEqual([]);
});

// ── clampCitationsToBody ────────────────────────────────────────────────────

describe("clampCitationsToBody", () => {
  const body = "Hello, world.";
  const baseCit: OverviewCitation = {
    startIndex: 0,
    endIndex: 5,
    sourceUrl: "https://x/a",
    title: "A",
    citedText: "Hello",
  };

  it("leaves a fully in-bounds citation untouched", () => {
    const out = clampCitationsToBody(body, [baseCit]);
    expect(out).toEqual([baseCit]);
  });

  it("clamps endIndex when it overshoots body length", () => {
    const out = clampCitationsToBody(body, [{ ...baseCit, endIndex: 999 }]);
    expect(out.length).toBe(1);
    expect(out[0]!.endIndex).toBe(body.length);
  });

  it("clamps startIndex when it overshoots and drops the resulting zero-width entry", () => {
    const out = clampCitationsToBody(body, [{ ...baseCit, startIndex: 999, endIndex: 1000 }]);
    expect(out.length).toBe(0);
  });

  it("clamps a negative startIndex to 0", () => {
    const out = clampCitationsToBody(body, [{ ...baseCit, startIndex: -10 }]);
    expect(out.length).toBe(1);
    expect(out[0]!.startIndex).toBe(0);
  });

  it("filters zero-width entries", () => {
    const out = clampCitationsToBody(body, [{ ...baseCit, startIndex: 4, endIndex: 4 }]);
    expect(out.length).toBe(0);
  });
});
