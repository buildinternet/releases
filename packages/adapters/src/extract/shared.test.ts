import { describe, expect, test } from "bun:test";
import type Anthropic from "@anthropic-ai/sdk";
import { applySlidingCacheBreakpoint, buildBodyGuardrail, mapEntries } from "./shared.js";
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

describe("applySlidingCacheBreakpoint", () => {
  test("strips a stale breakpoint and re-anchors the last block of the last message", () => {
    const messages: Anthropic.MessageParam[] = [
      { role: "user", content: "kickoff" },
      {
        role: "assistant",
        content: [{ type: "text", text: "round 1", cache_control: { type: "ephemeral" } }],
      },
      {
        role: "assistant",
        content: [
          { type: "text", text: "round 2 a" },
          { type: "text", text: "round 2 b" },
        ],
      },
    ];

    applySlidingCacheBreakpoint(messages);

    // Old breakpoint removed — never accumulate past the 4-breakpoint cap.
    const prior = messages[1]!.content as Anthropic.TextBlockParam[];
    expect(prior[0]!.cache_control).toBeUndefined();
    // New breakpoint on the final block of the final turn.
    const tail = messages[2]!.content as Anthropic.TextBlockParam[];
    expect(tail[0]!.cache_control).toBeUndefined();
    expect(tail[1]!.cache_control).toEqual({ type: "ephemeral" });
  });

  test("skips a server-tool tail block and anchors the nearest eligible block", () => {
    // web_fetch pause_turn turns often end in a server_tool_use block; the API
    // doesn't document cache_control there, so we must anchor the text block
    // before it rather than risk a 400 that kills the extraction.
    const messages = [
      { role: "user", content: "kickoff" },
      {
        role: "assistant",
        content: [
          { type: "text", text: "fetching" },
          { type: "server_tool_use", id: "s1", name: "web_fetch", input: {} },
        ],
      },
    ] as unknown as Anthropic.MessageParam[];

    applySlidingCacheBreakpoint(messages);

    const tail = messages[1]!.content as Array<{ type: string; cache_control?: unknown }>;
    expect(tail[0]!.cache_control).toEqual({ type: "ephemeral" });
    expect(tail[1]!.cache_control).toBeUndefined();
  });

  test("is a no-op when the last message is a plain string (loop kickoff turn)", () => {
    const messages: Anthropic.MessageParam[] = [
      {
        role: "assistant",
        content: [{ type: "text", text: "earlier", cache_control: { type: "ephemeral" } }],
      },
      { role: "user", content: "string kickoff" },
    ];

    applySlidingCacheBreakpoint(messages);

    // Prior breakpoint still stripped; none re-added (a string turn can't carry one).
    const prior = messages[0]!.content as Anthropic.TextBlockParam[];
    expect(prior[0]!.cache_control).toBeUndefined();
  });
});
