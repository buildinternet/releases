import { describe, expect, test } from "bun:test";
import {
  buildCollectionWeekBlock,
  generateCollectionWeeklyDigest,
  isSubstantiveRelease,
  MAX_RELEASES,
  parseWeeklyDigest,
  resolveReleasePlaceholders,
  selectWeeklyDigestReleases,
  type CollectionWeekInput,
  type WeeklyDigestRelease,
} from "./collection-weekly-digest";
import type { TextModel } from "./text-model";

function release(overrides: Partial<WeeklyDigestRelease> = {}): WeeklyDigestRelease {
  return {
    id: "rel_1",
    org: "Anthropic",
    product: "Claude Code",
    title: "Something shipped",
    summary: "A concise summary.",
    body: null,
    publishedAt: "2026-07-07T15:00:00.000Z",
    importance: null,
    ...overrides,
  };
}

describe("isSubstantiveRelease", () => {
  test("a release with a summary counts", () => {
    expect(isSubstantiveRelease(release({ summary: "x", body: null }))).toBe(true);
  });
  test("a release with a long body but no summary counts", () => {
    expect(isSubstantiveRelease(release({ summary: null, body: "x".repeat(200) }))).toBe(true);
  });
  test("a release with a short body and no summary does not count", () => {
    expect(isSubstantiveRelease(release({ summary: null, body: "short" }))).toBe(false);
  });
  test("a release with no summary and no body does not count", () => {
    expect(isSubstantiveRelease(release({ summary: null, body: null }))).toBe(false);
  });
});

describe("selectWeeklyDigestReleases", () => {
  test("returns everything unchanged when under the cap", () => {
    const releases = [release({ id: "rel_1" }), release({ id: "rel_2" })];
    const { selected, omittedCount } = selectWeeklyDigestReleases(releases);
    expect(selected).toHaveLength(2);
    expect(omittedCount).toBe(0);
  });

  test("always includes every importance >= 4 release, even over the cap", () => {
    const high = Array.from({ length: 5 }, (_, i) =>
      release({ id: `rel_high_${i}`, importance: 5 }),
    );
    const low = Array.from({ length: MAX_RELEASES }, (_, i) =>
      release({ id: `rel_low_${i}`, importance: 1 }),
    );
    const { selected, omittedCount } = selectWeeklyDigestReleases([...low, ...high]);
    expect(selected.length).toBe(MAX_RELEASES);
    for (const h of high) {
      expect(selected.some((r) => r.id === h.id)).toBe(true);
    }
    expect(omittedCount).toBe(low.length + high.length - MAX_RELEASES);
  });

  test("fills the remainder by importance desc then recency desc, once over the cap", () => {
    const filler = Array.from({ length: MAX_RELEASES - 2 }, (_, i) =>
      release({ id: `rel_filler_${i}`, importance: 2, publishedAt: "2026-07-05T00:00:00.000Z" }),
    );
    const releases = [
      release({ id: "rel_old_mid", importance: 3, publishedAt: "2026-07-06T00:00:00.000Z" }),
      release({ id: "rel_new_mid", importance: 3, publishedAt: "2026-07-08T00:00:00.000Z" }),
      release({ id: "rel_low", importance: 1, publishedAt: "2026-07-09T00:00:00.000Z" }),
      ...filler,
    ];
    const { selected } = selectWeeklyDigestReleases(releases);
    expect(selected.length).toBe(MAX_RELEASES);
    // The two importance=3 releases outrank the importance=2 filler and are
    // ordered newest-first between themselves; the importance=1 release loses
    // to the filler and is dropped.
    expect(selected[0].id).toBe("rel_new_mid");
    expect(selected[1].id).toBe("rel_old_mid");
    expect(selected.some((r) => r.id === "rel_low")).toBe(false);
  });
});

describe("buildCollectionWeekBlock", () => {
  const input: CollectionWeekInput = {
    collectionName: "Coding agents",
    weekStart: "2026-07-06",
    releases: [release({ id: "rel_1" })],
  };

  test("renders collection, week, and a release line with its id", () => {
    const selection = selectWeeklyDigestReleases(input.releases);
    const block = buildCollectionWeekBlock(input, selection);
    expect(block).toContain("Collection: Coding agents");
    expect(block).toContain("Week starting (ET Monday): 2026-07-06");
    expect(block).toContain("[rel_1] Anthropic / Claude Code: Something shipped");
  });

  test("notes the omitted count without listing rel_ids for it", () => {
    const block = buildCollectionWeekBlock(input, { selected: input.releases, omittedCount: 12 });
    expect(block).toContain("12 additional lower-priority releases");
  });
});

describe("parseWeeklyDigest", () => {
  test("parses title/intro/body/releases tags", () => {
    const raw =
      "<title>A quiet week</title><intro>Not much happened.</intro>" +
      "<body>### Nothing much\n\n[Claude Code](rel:rel_1) shipped a fix.</body>" +
      "<releases>rel_1, rel_2</releases>";
    const parsed = parseWeeklyDigest(raw);
    expect(parsed.title).toBe("A quiet week");
    expect(parsed.intro).toBe("Not much happened.");
    expect(parsed.body).toContain("[Claude Code](rel:rel_1)");
    expect(parsed.citedIds).toEqual(["rel_1", "rel_2"]);
  });

  test("throws when a required tag is missing", () => {
    expect(() => parseWeeklyDigest("<intro>x</intro><body>y</body>")).toThrow();
  });
});

describe("resolveReleasePlaceholders", () => {
  test("resolves a known id to its path and collects it", () => {
    const idToPath = new Map([["rel_1", "/release/rel_1-something"]]);
    const { body, releaseIds } = resolveReleasePlaceholders(
      "Read about [the fix](rel:rel_1) here.",
      idToPath,
    );
    expect(body).toBe("Read about [the fix](/release/rel_1-something) here.");
    expect(releaseIds).toEqual(["rel_1"]);
  });

  test("drops the link (keeps plain text) for an id not in the provided set", () => {
    const idToPath = new Map<string, string>();
    const { body, releaseIds } = resolveReleasePlaceholders(
      "Read about [a hallucinated release](rel:rel_ghost) here.",
      idToPath,
    );
    expect(body).toBe("Read about a hallucinated release here.");
    expect(body).not.toContain("rel:rel_ghost");
    expect(releaseIds).toEqual([]);
  });

  test("dedupes repeated citations of the same id", () => {
    const idToPath = new Map([["rel_1", "/release/rel_1"]]);
    const { releaseIds } = resolveReleasePlaceholders(
      "[First](rel:rel_1) and [again](rel:rel_1).",
      idToPath,
    );
    expect(releaseIds).toEqual(["rel_1"]);
  });

  test("unlinks non-rel markdown links, keeping the anchor text", () => {
    const idToPath = new Map([["rel_1", "/release/rel_1"]]);
    const { body, releaseIds } = resolveReleasePlaceholders(
      "[Good](rel:rel_1), [docs](https://evil.example/x), and [mail](mailto:a@example.com).",
      idToPath,
    );
    expect(body).toBe("[Good](/release/rel_1), docs, and mail.");
    expect(releaseIds).toEqual(["rel_1"]);
  });
});

describe("generateCollectionWeeklyDigest", () => {
  function fakeModel(text: string): TextModel {
    return {
      id: "test:model",
      async complete() {
        return { text, usage: { input: 1, output: 1, cacheCreate: 0, cacheRead: 0 } };
      },
    };
  }

  test("derives releaseIds from the resolved body, not the model's <releases> tag", async () => {
    // The model claims rel_ghost in <releases> but never links it in the body —
    // and links rel_1, which IS in the provided set.
    const raw =
      "<title>T</title><intro>I</intro>" +
      "<body>[Claude Code](rel:rel_1) shipped something.</body>" +
      "<releases>rel_1, rel_ghost</releases>";
    const idToPath = new Map([["rel_1", "/release/rel_1"]]);
    const result = await generateCollectionWeeklyDigest(
      fakeModel(raw),
      { collectionName: "C", weekStart: "2026-07-06", releases: [release({ id: "rel_1" })] },
      idToPath,
    );
    expect(result.releaseIds).toEqual(["rel_1"]);
    expect(result.body).toContain("(/release/rel_1)");
    expect(result.attempts).toBe(1);
  });

  /** Fake model that returns each text in sequence and counts calls. */
  function sequencedModel(texts: string[]): TextModel & { calls: () => number } {
    let i = 0;
    return {
      id: "test:model",
      calls: () => i,
      async complete() {
        const text = texts[Math.min(i, texts.length - 1)]!;
        i++;
        return { text, usage: { input: 10, output: 5, cacheCreate: 0, cacheRead: 0 } };
      },
    };
  }

  const goodRaw =
    "<title>T</title><intro>I</intro>" +
    "<body>[Claude Code](rel:rel_1) shipped something big.</body>" +
    "<releases>rel_1</releases>";

  test("retries once on a fabricated id, returns the clean attempt", async () => {
    const badRaw =
      "<title>T</title><intro>I</intro>" +
      "<body>[Claude Code](rel:rel_1) and [ghost](rel:rel_ghost).</body>" +
      "<releases>rel_1, rel_ghost</releases>";
    const model = sequencedModel([badRaw, goodRaw]);
    const result = await generateCollectionWeeklyDigest(
      model,
      { collectionName: "C", weekStart: "2026-07-06", releases: [release({ id: "rel_1" })] },
      new Map([["rel_1", "/release/rel_1"]]),
    );
    expect(model.calls()).toBe(2);
    expect(result.attempts).toBe(2);
    expect(result.body).not.toContain("ghost](");
    // usage summed across both attempts
    expect(result.usage.input).toBe(20);
  });

  test("accepts a soft-only attempt as fallback when the retry is no better", async () => {
    // Both attempts fabricate one id, but keep enough real links + coverage —
    // shippable, since resolution drops the bad link to plain text.
    const softRaw =
      "<title>T</title><intro>I</intro>" +
      "<body>[Claude Code](rel:rel_1) plus [ghost](rel:rel_ghost).</body>" +
      "<releases>rel_1</releases>";
    const model = sequencedModel([softRaw, softRaw]);
    const result = await generateCollectionWeeklyDigest(
      model,
      { collectionName: "C", weekStart: "2026-07-06", releases: [release({ id: "rel_1" })] },
      new Map([["rel_1", "/release/rel_1"]]),
    );
    expect(model.calls()).toBe(2);
    expect(result.releaseIds).toEqual(["rel_1"]);
    expect(result.body).toContain("ghost."); // anchor text kept, link dropped
    expect(result.body).not.toContain("(rel:");
  });

  test("retries when an importance>=4 release is uncited, throws after two hard failures", async () => {
    const uncitedRaw =
      "<title>T</title><intro>I</intro>" +
      "<body>[One](rel:rel_1), [two](rel:rel_2), [three](rel:rel_3); the big one went unmentioned.</body>" +
      "<releases>rel_1, rel_2, rel_3</releases>";
    const model = sequencedModel([uncitedRaw, uncitedRaw]);
    const releases = [
      release({ id: "rel_1" }),
      release({ id: "rel_2" }),
      release({ id: "rel_3" }),
      release({ id: "rel_big", title: "Major launch", importance: 5 }),
    ];
    const idToPath = new Map([
      ["rel_1", "/release/rel_1"],
      ["rel_2", "/release/rel_2"],
      ["rel_3", "/release/rel_3"],
      ["rel_big", "/release/rel_big"],
    ]);
    await expect(
      generateCollectionWeeklyDigest(
        model,
        { collectionName: "C", weekStart: "2026-07-06", releases },
        idToPath,
      ),
    ).rejects.toThrow(/importance>=4 releases uncited: rel_big/);
    expect(model.calls()).toBe(2);
  });

  test("retries on a parse failure and succeeds on the second attempt", async () => {
    const model = sequencedModel(["no tags at all", goodRaw]);
    const result = await generateCollectionWeeklyDigest(
      model,
      { collectionName: "C", weekStart: "2026-07-06", releases: [release({ id: "rel_1" })] },
      new Map([["rel_1", "/release/rel_1"]]),
    );
    expect(result.attempts).toBe(2);
    expect(result.releaseIds).toEqual(["rel_1"]);
  });

  test("throws when too few links survive resolution on both attempts", async () => {
    const linkless =
      "<title>T</title><intro>I</intro>" +
      "<body>Plenty happened this week but nothing is linked.</body>" +
      "<releases></releases>";
    const model = sequencedModel([linkless, linkless]);
    await expect(
      generateCollectionWeeklyDigest(
        model,
        { collectionName: "C", weekStart: "2026-07-06", releases: [release({ id: "rel_1" })] },
        new Map([["rel_1", "/release/rel_1"]]),
      ),
    ).rejects.toThrow(/too few resolvable release links/);
  });
});
