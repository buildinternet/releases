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

import { describe, it, expect } from "bun:test";
import type Anthropic from "@anthropic-ai/sdk";
import {
  extractOverviewBody,
  clampCitationsToBody,
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
