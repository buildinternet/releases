/**
 * Tests for overview-citations.ts.
 *
 * Coverage:
 *   extractOverviewBody
 *     - empty (no text blocks) → empty body, empty citations
 *     - one text block + no citations → body unchanged, empty citations
 *     - one text block + one citation → citation spans the whole block
 *     - multiple text blocks → running offsets correct across blocks
 *     - non-text blocks (tool_use, etc.) skipped
 *     - non-`search_result_location` citations dropped
 *     - leading markdown heading stripped → offsets shifted; citation entirely
 *       inside heading dropped; partial overlap clamps startIndex to 0
 *
 *   clampCitationsToBody
 *     - fully in-bounds citation unchanged
 *     - past end clamped
 *     - zero-width entries filtered
 *     - negative start clamped to 0
 */

import { describe, it, expect, test } from "bun:test";
import type Anthropic from "@anthropic-ai/sdk";
import {
  extractOverviewBody,
  clampCitationsToBody,
  decodeHtmlEntities,
  resolveOverviewCitations,
  type OverviewCitation,
} from "./overview-citations.js";

// ── builder helpers ─────────────────────────────────────────────────────────

interface TextBlockArgs {
  text: string;
  citations?: Array<Record<string, unknown>>;
}

function makeMessage(blocks: Array<TextBlockArgs | { type: "tool_use" }>): Anthropic.Message {
  // Cast to Anthropic.Message — the runtime shape only relies on `content[i].type`
  // and `content[i].text` / `citations`. The full Message envelope (model, role,
  // usage, etc.) isn't read by the function.
  return {
    id: "msg_test",
    type: "message",
    role: "assistant",
    model: "claude-haiku-4-5-20251001",
    content: blocks.map((b) =>
      "type" in b && b.type === "tool_use"
        ? { type: "tool_use", id: "t1", name: "noop", input: {} }
        : {
            type: "text",
            text: (b as TextBlockArgs).text,
            citations: (b as TextBlockArgs).citations,
          },
    ),
    stop_reason: "end_turn",
    stop_sequence: null,
    usage: { input_tokens: 0, output_tokens: 0 },
  } as unknown as Anthropic.Message;
}

function citation(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    type: "search_result_location",
    source: "https://example.com/release-a",
    title: "Release A",
    cited_text: "snippet",
    start_block_index: 0,
    end_block_index: 1,
    ...overrides,
  };
}

// ── extractOverviewBody ─────────────────────────────────────────────────────

describe("extractOverviewBody", () => {
  it("returns empty body + citations when the response has no text blocks", () => {
    const out = extractOverviewBody(makeMessage([{ type: "tool_use" }]));
    expect(out.body).toBe("");
    expect(out.citations).toEqual([]);
    expect(out.strippedHeading).toBe(false);
  });

  it("returns body + empty citations when there are text blocks but no citations", () => {
    const out = extractOverviewBody(makeMessage([{ text: "Just narrative." }]));
    expect(out.body).toBe("Just narrative.");
    expect(out.citations).toEqual([]);
    expect(out.strippedHeading).toBe(false);
  });

  it("emits one citation spanning the whole text block", () => {
    const out = extractOverviewBody(
      makeMessage([{ text: "Block A.", citations: [citation({ source: "https://x/a" })] }]),
    );
    expect(out.body).toBe("Block A.");
    expect(out.citations.length).toBe(1);
    expect(out.citations[0]).toMatchObject({
      startIndex: 0,
      endIndex: "Block A.".length,
      sourceUrl: "https://x/a",
      title: "Release A",
      citedText: "snippet",
    });
  });

  it("tracks running offsets across multiple text blocks", () => {
    const out = extractOverviewBody(
      makeMessage([
        { text: "First. ", citations: [citation({ source: "https://x/a" })] },
        { text: "Second.", citations: [citation({ source: "https://x/b" })] },
      ]),
    );
    expect(out.body).toBe("First. Second.");
    expect(out.citations.length).toBe(2);
    expect(out.citations[0]).toMatchObject({
      startIndex: 0,
      endIndex: 7,
      sourceUrl: "https://x/a",
    });
    expect(out.citations[1]).toMatchObject({
      startIndex: 7,
      endIndex: 14,
      sourceUrl: "https://x/b",
    });
  });

  it("skips non-text blocks (tool_use) when accumulating offsets", () => {
    const out = extractOverviewBody(
      makeMessage([
        { text: "Before.", citations: [citation()] },
        { type: "tool_use" },
        { text: " After.", citations: [citation({ source: "https://x/b" })] },
      ]),
    );
    expect(out.body).toBe("Before. After.");
    expect(out.citations.length).toBe(2);
    expect(out.citations[1]).toMatchObject({
      startIndex: 7,
      endIndex: 14,
      sourceUrl: "https://x/b",
    });
  });

  it("ignores citations whose type isn't search_result_location", () => {
    const out = extractOverviewBody(
      makeMessage([
        {
          text: "Block.",
          citations: [
            citation({ type: "web_search_result_location", source: "https://web/c" }),
            citation({ source: "https://x/a" }),
          ],
        },
      ]),
    );
    expect(out.citations.length).toBe(1);
    expect(out.citations[0]!.sourceUrl).toBe("https://x/a");
  });

  it("strips a leading heading and shifts citation offsets", () => {
    const out = extractOverviewBody(
      makeMessage([
        {
          text: "## Heading\n\nBody text.",
          citations: [citation()],
        },
      ]),
    );
    expect(out.strippedHeading).toBe(true);
    // The whole rawBody = "## Heading\n\nBody text." (22 chars).
    // stripLeadingHeading drops "## Heading\n\n" (12 chars) leaving "Body text." (10 chars).
    expect(out.body).toBe("Body text.");
    expect(out.citations.length).toBe(1);
    // Original citation spanned 0..22; after shifting by 12 → 0..10.
    expect(out.citations[0]!.startIndex).toBe(0);
    expect(out.citations[0]!.endIndex).toBe(10);
  });

  it("drops citations that fall entirely inside a stripped heading", () => {
    // Two blocks: the heading block carries its own citation; the body block
    // also has one. The heading-only citation should be dropped after strip.
    const out = extractOverviewBody(
      makeMessage([
        {
          text: "## Heading\n\n",
          citations: [citation({ source: "https://x/heading" })],
        },
        {
          text: "Body text.",
          citations: [citation({ source: "https://x/body" })],
        },
      ]),
    );
    expect(out.strippedHeading).toBe(true);
    expect(out.body).toBe("Body text.");
    expect(out.citations.length).toBe(1);
    expect(out.citations[0]!.sourceUrl).toBe("https://x/body");
  });

  it("clamps startIndex to 0 for citations partially inside the stripped heading", () => {
    // Single block whose text begins with the heading and continues with body.
    // The citation covers the whole block (heading + body) — strip should
    // leave the citation with start=0 over the post-strip body.
    const out = extractOverviewBody(
      makeMessage([
        {
          text: "## Heading\n\nBody text.",
          citations: [citation()],
        },
      ]),
    );
    expect(out.body).toBe("Body text.");
    expect(out.citations[0]!.startIndex).toBe(0);
    expect(out.citations[0]!.endIndex).toBe(10);
  });

  it("decodes the transport-artifact HTML entities in the body (#1146)", () => {
    const out = extractOverviewBody(
      makeMessage([{ text: "Q&amp;A on streams.input&lt;T&gt; &quot;done&quot; &#39;ok&#39;" }]),
    );
    expect(out.body).toBe(`Q&A on streams.input<T> "done" 'ok'`);
    expect(out.citations).toEqual([]);
  });

  it("keeps a whole-block citation aligned to the DECODED body, not the escaped source", () => {
    // "Q&amp;A shipped." is 16 chars escaped, "Q&A shipped." is 12 decoded.
    // The citation spans the whole block, so its endIndex must be the decoded
    // length (12). A naive decode-after-accumulate would leave endIndex at 16
    // and clampCitationsToBody would silently truncate it.
    const out = extractOverviewBody(
      makeMessage([{ text: "Q&amp;A shipped.", citations: [citation({ source: "https://x/a" })] }]),
    );
    expect(out.body).toBe("Q&A shipped.");
    expect(out.citations.length).toBe(1);
    expect(out.citations[0]).toMatchObject({
      startIndex: 0,
      endIndex: "Q&A shipped.".length,
      sourceUrl: "https://x/a",
    });
  });

  it("tracks decoded running offsets so a later block's citation isn't shifted", () => {
    // Block 1 decodes 8→5 chars ("A &amp; B" → "A & B"). Block 2's whole-block
    // citation must start at the DECODED offset (5), not the escaped offset (9).
    const out = extractOverviewBody(
      makeMessage([
        { text: "A &amp; B" },
        { text: "plain.", citations: [citation({ source: "https://x/b" })] },
      ]),
    );
    expect(out.body).toBe("A & Bplain.");
    expect(out.citations.length).toBe(1);
    expect(out.citations[0]).toMatchObject({
      startIndex: "A & B".length,
      endIndex: "A & Bplain.".length,
      sourceUrl: "https://x/b",
    });
  });
});

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
