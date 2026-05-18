import { describe, expect, it } from "bun:test";
import type Anthropic from "@anthropic-ai/sdk";
import {
  buildClassifierInput,
  classifyMarketing,
  MAX_CONTENT_CHARS,
  parseMarketingVerdict,
  type MarketingClassifierInput,
} from "@releases/ai-internal/marketing-classifier";

function baseInput(overrides?: Partial<MarketingClassifierInput>): MarketingClassifierInput {
  return {
    sourceName: "ClickHouse Blog",
    title: "How Some Customer migrated to ClickHouse",
    content: "Description text",
    url: "https://clickhouse.com/blog/somecustomer",
    ...overrides,
  };
}

// Build a stub Anthropic client that returns a canned `<marketing>…</marketing>`
// envelope. Pins the exact contract `classifyMarketing` parses without standing
// up the real SDK or making a network call.
function stubClient(text: string): Anthropic {
  return {
    messages: {
      create: async () => ({
        content: [{ type: "text", text }],
        stop_reason: "end_turn",
        usage: {
          input_tokens: 50,
          output_tokens: 8,
          cache_creation_input_tokens: 0,
          cache_read_input_tokens: 0,
        },
      }),
    },
  } as unknown as Anthropic;
}

describe("parseMarketingVerdict", () => {
  it("parses marketing=true with a known reason slug", () => {
    const raw = `<marketing>true</marketing>\n<reason>case_study</reason>`;
    expect(parseMarketingVerdict(raw)).toEqual({ isMarketing: true, reason: "case_study" });
  });

  it("parses each canonical marketing reason slug", () => {
    const slugs = [
      "case_study",
      "newsletter",
      "event_recap",
      "partner_announcement",
      "positioning_piece",
      "localized_marketing",
    ] as const;
    for (const slug of slugs) {
      const raw = `<marketing>true</marketing><reason>${slug}</reason>`;
      expect(parseMarketingVerdict(raw)).toEqual({ isMarketing: true, reason: slug });
    }
  });

  it("normalizes unknown marketing reason slugs to 'unspecified'", () => {
    const raw = `<marketing>true</marketing><reason>brand_new_category</reason>`;
    expect(parseMarketingVerdict(raw)).toEqual({ isMarketing: true, reason: "unspecified" });
  });

  it("returns isMarketing=false (reason omitted, per the updated prompt contract)", () => {
    expect(parseMarketingVerdict(`<marketing>false</marketing>`)).toEqual({
      isMarketing: false,
      reason: "unspecified",
    });
  });

  it("still parses marketing=false when the model emits a stray reason tag", () => {
    // Backwards-compatible with older prompt-contract output.
    expect(
      parseMarketingVerdict(`<marketing>false</marketing><reason>not_marketing</reason>`),
    ).toEqual({ isMarketing: false, reason: "unspecified" });
  });

  it("treats case-insensitive boolean tokens", () => {
    expect(parseMarketingVerdict(`<marketing>TRUE</marketing><reason>case_study</reason>`)).toEqual(
      { isMarketing: true, reason: "case_study" },
    );
  });

  it("throws when the <marketing> tag is absent (fail-open signal for the caller)", () => {
    expect(() => parseMarketingVerdict("no tags here at all")).toThrow(
      /missing or malformed <marketing>/,
    );
  });
});

describe("buildClassifierInput", () => {
  it("includes source name, title, and URL on separate lines", () => {
    const out = buildClassifierInput(baseInput());
    expect(out).toContain("Source: ClickHouse Blog");
    expect(out).toContain("Title: How Some Customer migrated to ClickHouse");
    expect(out).toContain("URL: https://clickhouse.com/blog/somecustomer");
  });

  it("omits the URL line when url is null", () => {
    const out = buildClassifierInput(baseInput({ url: null }));
    expect(out).not.toContain("URL:");
  });

  it("appends a Source hint line when provided", () => {
    const out = buildClassifierInput(
      baseInput({ hint: "Monthly newsletters live at /blog/YYYYMM-newsletter" }),
    );
    expect(out).toContain("Source hint: Monthly newsletters live at /blog/YYYYMM-newsletter");
  });

  it("ignores empty / whitespace-only hints", () => {
    const out = buildClassifierInput(baseInput({ hint: "   " }));
    expect(out).not.toContain("Source hint:");
  });

  it("truncates content beyond MAX_CONTENT_CHARS and marks it [truncated]", () => {
    const long = "x".repeat(MAX_CONTENT_CHARS + 500);
    const out = buildClassifierInput(baseInput({ content: long }));
    expect(out).toContain("[truncated]");
    // The body before [truncated] is exactly MAX_CONTENT_CHARS chars
    const bodyStart = out.indexOf("Content:\n") + "Content:\n".length;
    const truncatedTag = out.indexOf("\n\n[truncated]");
    expect(truncatedTag - bodyStart).toBe(MAX_CONTENT_CHARS);
  });
});

describe("classifyMarketing", () => {
  it("returns isMarketing=true + reason slug for a marketing verdict", async () => {
    const client = stubClient(`<marketing>true</marketing><reason>case_study</reason>`);
    const result = await classifyMarketing(client, baseInput());
    expect(result.isMarketing).toBe(true);
    expect(result.reason).toBe("case_study");
    expect(result.usage.input).toBe(50);
    expect(result.usage.output).toBe(8);
  });

  it("returns isMarketing=false for a product-news verdict", async () => {
    const client = stubClient(`<marketing>false</marketing><reason>not_marketing</reason>`);
    const result = await classifyMarketing(client, baseInput({ title: "ClickHouse Release 26.4" }));
    expect(result.isMarketing).toBe(false);
  });

  it("propagates parse failures so the caller can fail-open", async () => {
    const client = stubClient("malformed response with no tags");
    expect(classifyMarketing(client, baseInput())).rejects.toThrow(
      /missing or malformed <marketing>/,
    );
  });
});
