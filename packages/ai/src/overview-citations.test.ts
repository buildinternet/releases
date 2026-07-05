/**
 * Tests for overview-citations.ts (#1934: source list, no body offsets).
 *
 * Coverage:
 *   decodeHtmlEntities — the five entities, single-pass, idempotent
 *   resolveOverviewCitations
 *     - resolves a known source URL to a { sourceUrl, title } citation
 *     - empty citation list
 *     - strips a leaked trailing Citations:/Sources: section from the body
 *     - drops unknown URLs
 *     - dedupes repeated source URLs
 */

import { describe, it, expect, test } from "bun:test";
import { decodeHtmlEntities, resolveOverviewCitations } from "./overview-citations.js";

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

test("resolveOverviewCitations resolves a known source URL to a { sourceUrl, title } citation", () => {
  const { body, citations } = resolveOverviewCitations(
    "Shipped a new streaming API and faster cold starts.",
    [{ url: SRC }],
    input,
  );
  expect(body).toBe("Shipped a new streaming API and faster cold starts.");
  expect(citations).toEqual([{ sourceUrl: SRC, title: "v2.0" }]);
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
  const { body, citations } = resolveOverviewCitations(leaky, [{ url: SRC }], input);
  expect(body).toBe("Shipped a new streaming API.");
  expect(body).not.toMatch(/citations/i);
  expect(citations).toEqual([{ sourceUrl: SRC, title: "v2.0" }]);

  const sources = resolveOverviewCitations("Body text here.\n\nSources: https://x", [], input);
  expect(sources.body).toBe("Body text here.");
});

test("resolveOverviewCitations drops unknown source URLs", () => {
  const badUrl = resolveOverviewCitations("Body text here.", [{ url: "https://other.com" }], input);
  expect(badUrl.citations).toEqual([]);
});

test("resolveOverviewCitations dedupes repeated source URLs", () => {
  const { citations } = resolveOverviewCitations(
    "Body citing the same source twice.",
    [{ url: SRC }, { url: SRC }],
    input,
  );
  expect(citations).toEqual([{ sourceUrl: SRC, title: "v2.0" }]);
});

test("resolveOverviewCitations falls back to a null title for a source with no display title", () => {
  const noTitleSrc = "https://acme.dev/releases/v3";
  const { citations } = resolveOverviewCitations("Body.", [{ url: noTitleSrc }], {
    validSources: new Set([noTitleSrc]),
    titleBySource: new Map(),
  });
  expect(citations).toEqual([{ sourceUrl: noTitleSrc, title: null }]);
});
