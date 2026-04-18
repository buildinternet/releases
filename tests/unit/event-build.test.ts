import { describe, it, expect } from "bun:test";
import { buildReleaseEventPayloads } from "../../workers/api/src/events/build-event.js";

describe("buildReleaseEventPayloads", () => {
  it("maps inserted rows + source context to the wire shape", () => {
    const events = buildReleaseEventPayloads({
      src: { name: "Claude Code", slug: "claude-code" },
      inserted: [
        {
          id: "rel_a",
          title: "v1.2.3",
          version: "1.2.3",
          publishedAt: "2026-04-18T10:00:00Z",
          media: '[{"type":"image","url":"https://ex/1.png"}]',
        },
        {
          id: "rel_b",
          title: "v1.2.4",
          version: null,
          publishedAt: null,
          media: null,
        },
      ],
    });

    expect(events).toHaveLength(2);
    expect(events[0]).toEqual({
      id: "rel_a",
      title: "v1.2.3",
      version: "1.2.3",
      publishedAt: "2026-04-18T10:00:00Z",
      sourceName: "Claude Code",
      sourceSlug: "claude-code",
      contentSummary: null,
      media: [{ type: "image", url: "https://ex/1.png" }],
    });
    expect(events[1].media).toEqual([]);
    expect(events[1].version).toBeNull();
  });

  it("silently yields empty media when the JSON blob is malformed", () => {
    const events = buildReleaseEventPayloads({
      src: { name: "X", slug: "x" },
      inserted: [{ id: "r", title: "t", version: null, publishedAt: null, media: "{not-json" }],
    });
    expect(events[0].media).toEqual([]);
  });
});
