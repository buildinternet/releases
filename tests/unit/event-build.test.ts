import { describe, it, expect } from "bun:test";
import { buildReleaseEventPayloads } from "../../workers/api/src/events/build-event.js";

describe("buildReleaseEventPayloads", () => {
  it("maps inserted rows + source context to the wire shape", () => {
    const events = buildReleaseEventPayloads({
      src: {
        name: "Claude Code",
        slug: "claude-code",
        type: "github",
        org: {
          slug: "anthropic",
          name: "Anthropic",
          avatarUrl: "https://media.releases.sh/orgs/anthropic.png",
          githubHandle: "anthropics",
        },
        product: { slug: "claude-code", name: "Claude Code" },
      },
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
      sourceType: "github",
      org: {
        slug: "anthropic",
        name: "Anthropic",
        avatarUrl: "https://media.releases.sh/orgs/anthropic.png",
        githubHandle: "anthropics",
      },
      product: { slug: "claude-code", name: "Claude Code" },
      summary: null,
      titleGenerated: null,
      titleShort: null,
      media: [{ type: "image", url: "https://ex/1.png" }],
      contentChars: null,
      contentTokens: null,
    });
    expect(events[1].media).toEqual([]);
    expect(events[1].version).toBeNull();
  });

  it("yields null org/product and undefined sourceType when source context is absent", () => {
    const events = buildReleaseEventPayloads({
      src: { name: "Orphan", slug: "orphan" },
      inserted: [{ id: "r", title: "t", version: null, publishedAt: null, media: null }],
    });
    expect(events[0].org).toBeNull();
    expect(events[0].product).toBeNull();
    expect(events[0].sourceType).toBeUndefined();
  });

  it("silently yields empty media when the JSON blob is malformed", () => {
    const events = buildReleaseEventPayloads({
      src: { name: "X", slug: "x" },
      inserted: [{ id: "r", title: "t", version: null, publishedAt: null, media: "{not-json" }],
    });
    expect(events[0].media).toEqual([]);
  });
});
