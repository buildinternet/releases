import { describe, expect, test } from "bun:test";
import { buildBodyGuardrail, mapEntries } from "./shared.js";
import type { ExtractedEntry } from "./types.js";

const SRC = "https://docs.x.ai/developers/release-notes";

function entry(over: Partial<ExtractedEntry>): ExtractedEntry {
  return { title: "Title", content: "Body", isBreaking: false, ...over };
}

describe("mapEntries URL resolution", () => {
  test("relative non-anchor 'read more' link becomes a source anchor, not a doubled path", () => {
    // Single-page doc changelogs: the extract model emits each entry's
    // relative "read more" link. Resolving it against the source path doubles
    // segments (…/release-notes/developers/…) and 404s. The entry permalink
    // should be a stable anchor on the source page instead.
    const [r] = mapEntries(
      [
        entry({
          title: "Custom Voices",
          url: "release-notes/developers/model-capabilities/audio/custom-voices",
        }),
      ],
      { sourceUrl: SRC },
    );
    expect(r.url).toBe(`${SRC}#custom-voices`);
  });

  test("root-relative non-anchor link also becomes a source anchor", () => {
    const [r] = mapEntries([entry({ title: "Cost Tracking", url: "/developers/cost-tracking" })], {
      sourceUrl: SRC,
    });
    expect(r.url).toBe(`${SRC}#cost-tracking`);
  });

  test("absolute URLs are preserved (crawl / multi-page sources)", () => {
    const abs = "https://github.com/xai-org/xai-sdk-python/releases/tag/v1.13.0";
    const [r] = mapEntries([entry({ title: "v1.13.0", version: "v1.13.0", url: abs })], {
      sourceUrl: SRC,
    });
    expect(r.url).toBe(abs);
  });

  test("fragment-only URLs resolve against the source page", () => {
    const [r] = mapEntries([entry({ title: "Cost Tracking", url: "#cost-tracking" })], {
      sourceUrl: SRC,
    });
    expect(r.url).toBe(`${SRC}#cost-tracking`);
  });

  test("missing URL synthesizes an anchor from the title", () => {
    const [r] = mapEntries([entry({ title: "Cost Tracking" })], { sourceUrl: SRC });
    expect(r.url).toBe(`${SRC}#cost-tracking`);
  });

  test("version wins over title for the synthesized anchor", () => {
    const [r] = mapEntries([entry({ title: "Some Release", version: "v2.1.0" })], {
      sourceUrl: SRC,
    });
    expect(r.url).toBe(`${SRC}#v2-1-0`);
  });
});

describe("buildBodyGuardrail", () => {
  // Regression: the large-body guardrail told the model to "be aggressively
  // concise", and at temperature 0 the Haiku extractor obeyed by dropping each
  // entry's media array entirely (reproduced byte-for-byte against the Intercom
  // crawl: 10 entries, 0 media, identical 2,276-token output). Conciseness must
  // apply to prose only — media is ~1 URL/entry and must survive the guardrail.
  test("instructs the model to keep the media array despite being concise", () => {
    const g = buildBodyGuardrail(148_000);
    expect(g).toContain("media array");
    expect(g.toLowerCase()).toContain("never be dropped");
  });

  test("still rounds the token count into the prose", () => {
    expect(buildBodyGuardrail(148_156)).toContain("148,000 tokens");
  });
});
