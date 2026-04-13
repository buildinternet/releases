import { describe, it, expect } from "bun:test";
import {
  preCheckMedia,
  filterJunkMedia,
  type MediaRef,
  type AmbiguousMediaClassifier,
} from "../../src/lib/media.js";

// ── preCheckMedia (deterministic) ───────────────────────────────────

describe("preCheckMedia — obvious drops", () => {
  it("drops LinkedIn tracking pixels", () => {
    const v = preCheckMedia("https://px.ads.linkedin.com/collect?pid=1");
    expect(v.kind).toBe("drop");
    if (v.kind === "drop") expect(v.reason).toContain("tracking domain");
  });

  it("drops Facebook tracking", () => {
    const v = preCheckMedia("https://www.facebook.com/tr?id=123&ev=PageView");
    expect(v.kind).toBe("drop");
  });

  it("drops favicon at site root", () => {
    const v = preCheckMedia("https://example.com/favicon.ico");
    expect(v.kind).toBe("drop");
    if (v.kind === "drop") expect(v.reason).toBe("favicon");
  });

  it("drops favicon variants", () => {
    const v = preCheckMedia("https://example.com/assets/favicon.svg");
    expect(v.kind).toBe("drop");
  });

  it("drops 1x1 spacer pixels", () => {
    const v = preCheckMedia("https://example.com/images/1x1.png");
    expect(v.kind).toBe("drop");
  });

  it("drops explicit spacer paths", () => {
    const v = preCheckMedia("https://example.com/assets/spacer.gif");
    expect(v.kind).toBe("drop");
  });
});

describe("preCheckMedia — obvious keeps (streaming embeds)", () => {
  it("keeps YouTube short-circuit", () => {
    const v = preCheckMedia("https://www.youtube.com/watch?v=abc");
    expect(v.kind).toBe("keep");
  });

  it("keeps youtu.be links", () => {
    const v = preCheckMedia("https://youtu.be/abc");
    expect(v.kind).toBe("keep");
  });

  it("keeps Vimeo", () => {
    const v = preCheckMedia("https://vimeo.com/12345");
    expect(v.kind).toBe("keep");
  });

  it("keeps Loom", () => {
    const v = preCheckMedia("https://www.loom.com/share/abc");
    expect(v.kind).toBe("keep");
  });
});

describe("preCheckMedia — ambiguous cases routed to classifier", () => {
  it("routes /avatar/ paths to classifier (previously hard-dropped)", () => {
    // Vercel author avatar regression case: filenames contain person names.
    const v = preCheckMedia("https://vercel.com/avatars/leerob.png");
    expect(v.kind).toBe("ambiguous");
  });

  it("routes /icons/ paths to classifier (previously hard-dropped)", () => {
    // "New icon set" release case: the /icons/ path is the actual editorial content.
    const v = preCheckMedia("https://cdn.example.com/posts/icons/new-design.png");
    expect(v.kind).toBe("ambiguous");
  });

  it("routes /logo paths to classifier", () => {
    const v = preCheckMedia("https://example.com/images/logo-redesign-v2.png");
    expect(v.kind).toBe("ambiguous");
  });

  it("routes /badge paths to classifier", () => {
    const v = preCheckMedia("https://example.com/badges/shield.svg");
    expect(v.kind).toBe("ambiguous");
  });

  it("routes ordinary screenshot URLs to classifier", () => {
    // A plain URL without any junk pattern is ambiguous too — classifier
    // will rubber-stamp it based on alt text / context.
    const v = preCheckMedia("https://cdn.example.com/posts/2026/dashboard.png");
    expect(v.kind).toBe("ambiguous");
  });
});

// ── filterJunkMedia (full pipeline) ─────────────────────────────────

describe("filterJunkMedia — full two-stage pipeline", () => {
  // Stub classifier: the tests inject this so we don't hit the real
  // Anthropic API. The production default classifier lives in
  // src/ai/classify-media.ts and is wired up when `classifier` is omitted.
  const makeClassifier = (
    rules: Record<string, { decision: "keep" | "drop"; confidence: "high" | "low" }>,
  ): AmbiguousMediaClassifier => {
    return async (items) =>
      items.map((item) => ({
        url: item.url,
        decision: rules[item.url]?.decision ?? "keep",
        confidence: rules[item.url]?.confidence ?? "low",
        reason: "test stub",
      }));
  };

  it("drops pre-check junk without calling the classifier", async () => {
    let called = false;
    const classifier: AmbiguousMediaClassifier = async () => {
      called = true;
      return null;
    };
    const media: MediaRef[] = [
      { type: "image", url: "https://example.com/favicon.ico" },
      { type: "image", url: "https://px.ads.linkedin.com/collect?pid=1" },
    ];
    const result = await filterJunkMedia(media, "body", { classifier });
    expect(result.media.length).toBe(0);
    expect(result.dropped.length).toBe(2);
    expect(called).toBe(false);
  });

  it("keeps streaming embeds without calling the classifier", async () => {
    let called = false;
    const classifier: AmbiguousMediaClassifier = async () => {
      called = true;
      return [];
    };
    const media: MediaRef[] = [
      { type: "video", url: "https://www.youtube.com/watch?v=abc" },
    ];
    const result = await filterJunkMedia(media, "see video here", { classifier });
    expect(result.media.length).toBe(1);
    expect(called).toBe(false);
  });

  it("sends ambiguous items to the classifier and honours high-confidence drops", async () => {
    const media: MediaRef[] = [
      // Ambiguous — classifier will drop as avatar (high confidence).
      { type: "image", url: "https://example.com/avatars/leerob.png", alt: "Lee Robinson" },
      // Ambiguous — classifier will keep (it's the actual release content).
      {
        type: "image",
        url: "https://cdn.example.com/posts/icons/new-design.png",
        alt: "New icon set",
      },
    ];
    const classifier = makeClassifier({
      "https://example.com/avatars/leerob.png": { decision: "drop", confidence: "high" },
      "https://cdn.example.com/posts/icons/new-design.png": { decision: "keep", confidence: "high" },
    });
    const result = await filterJunkMedia(media, "body", { classifier });
    expect(result.media.map((m) => m.url)).toEqual([
      "https://cdn.example.com/posts/icons/new-design.png",
    ]);
    expect(result.dropped.length).toBe(1);
    expect(result.dropped[0].url).toBe("https://example.com/avatars/leerob.png");
  });

  it("keeps low-confidence drops conservatively (precision-over-recall)", async () => {
    const media: MediaRef[] = [
      { type: "image", url: "https://example.com/badges/maybe.svg" },
    ];
    const classifier = makeClassifier({
      "https://example.com/badges/maybe.svg": { decision: "drop", confidence: "low" },
    });
    const result = await filterJunkMedia(media, "body", { classifier });
    expect(result.media.length).toBe(1);
    expect(result.dropped.length).toBe(0);
  });

  it("keeps ambiguous items when the classifier is unavailable (returns null)", async () => {
    const media: MediaRef[] = [
      { type: "image", url: "https://example.com/avatars/someone.png" },
    ];
    const classifier: AmbiguousMediaClassifier = async () => null;
    const result = await filterJunkMedia(media, "body", { classifier });
    expect(result.media.length).toBe(1);
  });

  it("strips markdown image references for dropped URLs", async () => {
    const media: MediaRef[] = [
      { type: "image", url: "https://example.com/favicon.ico" },
    ];
    const content = "before\n\n![favicon](https://example.com/favicon.ico)\n\nafter";
    const result = await filterJunkMedia(media, content, {
      classifier: async () => [],
    });
    expect(result.content).not.toContain("favicon.ico");
    expect(result.content).toContain("before");
    expect(result.content).toContain("after");
  });

  it("passes release context to the classifier", async () => {
    let seenCtx: { releaseTitle?: string; sourceSlug?: string } | null = null;
    const classifier: AmbiguousMediaClassifier = async (_items, ctx) => {
      seenCtx = ctx;
      return null;
    };
    await filterJunkMedia(
      [{ type: "image", url: "https://example.com/images/hero.png" }],
      "body text",
      {
        classifier,
        releaseTitle: "New dashboard",
        sourceSlug: "acme",
      },
    );
    expect(seenCtx).not.toBeNull();
    expect(seenCtx!.releaseTitle).toBe("New dashboard");
    expect(seenCtx!.sourceSlug).toBe("acme");
  });
});
