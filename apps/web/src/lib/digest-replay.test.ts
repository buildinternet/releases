import { describe, expect, test } from "bun:test";
import type { DigestCoveredRelease } from "@/lib/api";
import { buildGlance, GLANCE_TOP_N, MAX_GLANCE_TILES, OTHERS_KEY } from "./digest-glance";
import {
  buildReplay,
  frameAt,
  LIVE_TOP_N,
  MAX_MARK_ROWS,
  nextDayStop,
  prevDayStop,
  REPLAY_DAYS,
  replayDay,
} from "./digest-replay";

const WEEK = "2026-09-28"; // Monday

function rel(
  id: string,
  product: string,
  importance: number | null,
  publishedAt: string | null,
  composition: { features: number; enhancements: number; bugs: number } | null = {
    features: 1,
    enhancements: 1,
    bugs: 1,
  },
): DigestCoveredRelease {
  return {
    id,
    title: `Title ${id}`,
    path: `/release/${id}`,
    url: null,
    org: {
      slug: `${product}-org`,
      name: product.toUpperCase(),
      avatarUrl: null,
      githubHandle: null,
    },
    product: { slug: product, name: product[0].toUpperCase() + product.slice(1) },
    importance,
    composition,
    publishedAt,
  };
}

describe("replayDay", () => {
  test("a timed stamp uses its ET day", () => {
    // 01:02 UTC Oct 3 is the evening of Oct 2 in New York.
    expect(replayDay("2026-10-03T01:02:04.000Z")).toEqual({ dayKey: "2026-10-02", hasTime: true });
    expect(replayDay("2026-09-28T15:26:39.000Z")).toEqual({ dayKey: "2026-09-28", hasTime: true });
  });

  test("exact UTC midnight is date-only and keeps its UTC date", () => {
    expect(replayDay("2026-09-29T00:00:00.000Z")).toEqual({ dayKey: "2026-09-29", hasTime: false });
    expect(replayDay("2026-09-29")).toEqual({ dayKey: "2026-09-29", hasTime: false });
  });

  test("missing or unparseable stamps return null", () => {
    expect(replayDay(null)).toBeNull();
    expect(replayDay(undefined)).toBeNull();
    expect(replayDay("not a date")).toBeNull();
  });
});

describe("buildReplay", () => {
  test("places releases on their day and clamps the week edges", () => {
    const replay = buildReplay(
      [
        rel("mon", "a", 3, "2026-09-28T15:00:00.000Z"),
        rel("tue-date", "a", 3, "2026-09-29T00:00:00.000Z"),
        rel("before", "a", 3, "2026-09-20T12:00:00.000Z"),
        rel("after", "a", 3, "2026-10-05T12:00:00.000Z"),
        rel("none", "a", 3, null),
      ],
      WEEK,
    );
    const day = Object.fromEntries(replay.items.map((it) => [it.release.id, it.day]));
    expect(day).toEqual({ mon: 0, before: 0, "tue-date": 1, after: 6, none: 6 });
    expect(replay.dayKeys).toEqual([
      "2026-09-28",
      "2026-09-29",
      "2026-09-30",
      "2026-10-01",
      "2026-10-02",
      "2026-10-03",
      "2026-10-04",
    ]);
  });

  test("spaces a day's releases evenly in publish order", () => {
    const replay = buildReplay(
      [
        rel("late", "a", 2, "2026-09-30T22:00:00.000Z"),
        rel("early", "b", 2, "2026-09-30T13:00:00.000Z"),
        rel("dated", "c", 2, "2026-09-30T00:00:00.000Z"), // noon ET for ordering
        rel("solo", "a", 2, "2026-10-01T15:00:00.000Z"),
      ],
      WEEK,
    );
    expect(replay.items.map((it) => [it.release.id, it.at])).toEqual([
      ["early", 2 + 0.5 / 3],
      ["dated", 2 + 1.5 / 3],
      ["late", 2 + 2.5 / 3],
      ["solo", 3.5],
    ]);
  });

  test("orders lanes by final impact, folding past the tile cap into Others", () => {
    const releases = Array.from({ length: MAX_GLANCE_TILES + 2 }, (_, i) =>
      rel(`r${i}`, `p${i}`, i < 3 ? 5 - i : 2, "2026-09-29T15:00:00.000Z"),
    );
    const replay = buildReplay(releases, WEEK);
    const final = buildGlance(releases);
    expect(replay.lanes.map((l) => l.key)).toEqual(final.products.map((p) => p.key));
    expect(replay.lanes.at(-1)!.key).toBe(OTHERS_KEY);
    expect(replay.lanes.at(-1)!.items.length).toBe(3);
  });

  test("packs a busy lane into rows, capped", () => {
    const busy = Array.from({ length: 8 }, (_, i) =>
      rel(`b${i}`, "a", 3, `2026-09-29T1${i}:00:00.000Z`),
    );
    const replay = buildReplay(busy, WEEK);
    const rows = replay.items.map((it) => it.row);
    expect(new Set(rows).size).toBe(MAX_MARK_ROWS);
    expect(Math.max(...rows)).toBe(MAX_MARK_ROWS - 1);

    // Releases on different days don't collide: one row.
    const spread = buildReplay(
      [rel("x", "a", 3, "2026-09-28T15:00:00.000Z"), rel("y", "a", 3, "2026-10-02T15:00:00.000Z")],
      WEEK,
    );
    expect(spread.items.map((it) => it.row)).toEqual([0, 0]);
  });
});

const WEEK_RELEASES = [
  rel("codex-5", "codex", 5, "2026-09-29T00:00:00.000Z"),
  rel("codex-fix", "codex", 1, "2026-09-29T00:00:00.000Z", {
    features: 0,
    enhancements: 0,
    bugs: 1,
  }),
  rel("claude-4", "claude", 4, "2026-09-28T18:02:03.000Z", {
    features: 9,
    enhancements: 0,
    bugs: 30,
  }),
  rel("claude-3", "claude", 3, "2026-09-29T19:27:30.000Z"),
  rel("devin-4", "devin", 4, "2026-09-28T15:26:39.000Z"),
  rel("devin-2", "devin", 2, "2026-10-03T01:02:04.000Z", null),
  rel("grok-3", "grok", 3, "2026-09-29T00:00:00.000Z"),
  rel("grok-2", "grok", 2, "2026-09-30T00:00:00.000Z"),
  rel("codex-late", "codex", 2, "2026-10-05T03:00:00.000Z"),
];

describe("frameAt", () => {
  const replay = buildReplay(WEEK_RELEASES, WEEK);

  test("nothing has shipped at t=0", () => {
    const f = frameAt(replay, 0);
    expect(f.shipped).toEqual([]);
    expect(f.caption).toBeNull();
    expect(f.products.every((p) => p.impact === 0)).toBe(true);
  });

  test("shipped count never decreases as t grows", () => {
    let last = -1;
    for (let t = 0; t <= REPLAY_DAYS; t += 0.05) {
      const n = frameAt(replay, t).shipped.length;
      expect(n).toBeGreaterThanOrEqual(last);
      last = n;
    }
    expect(last).toBe(WEEK_RELEASES.length);
  });

  test("tile order stays fixed to the final ranking", () => {
    const keys = replay.lanes.map((l) => l.key);
    for (const t of [0.6, 1.5, 3, 5.5, REPLAY_DAYS]) {
      expect(frameAt(replay, t).products.map((p) => p.key)).toEqual(keys);
    }
  });

  test("the final frame equals buildGlance over the whole week", () => {
    const f = frameAt(replay, REPLAY_DAYS);
    const card = buildGlance(WEEK_RELEASES);
    expect(f.ended).toBe(true);
    expect(f.products).toEqual(card.products);
    expect(f.top).toEqual(card.ranked.slice(0, GLANCE_TOP_N));
    expect(f.caption).toBeNull();
  });

  test("lists the top three while playing", () => {
    expect(frameAt(replay, 6.5).top).toHaveLength(LIVE_TOP_N);
  });

  test("clamps t outside the week", () => {
    expect(frameAt(replay, -3).shipped).toEqual([]);
    expect(frameAt(replay, 99).ended).toBe(true);
  });
});

describe("caption", () => {
  const replay = buildReplay(WEEK_RELEASES, WEEK);
  const capAt = (t: number) => {
    const c = frameAt(replay, t).caption;
    return c && { id: c.item.release.id, kicker: c.kicker, more: c.moreCount };
  };

  test("is the day's biggest release so far, and only changes for a bigger one", () => {
    // Monday: devin-4 (15:26) lands first, then claude-4 (18:02) — same
    // importance, so the caption only moves if claude-4 has more impact.
    const mon = replay.items.filter((it) => it.day === 0);
    expect(capAt(mon[0].at)).toEqual({ id: "devin-4", kicker: "Major release", more: 0 });
    const second = capAt(mon[1].at)!;
    const devinImpact = mon.find((it) => it.release.id === "devin-4")!.finalImpact;
    const claudeImpact = mon.find((it) => it.release.id === "claude-4")!.finalImpact;
    expect(second.id).toBe(claudeImpact > devinImpact ? "claude-4" : "devin-4");

    // Tuesday: the landmark wins as soon as it lands and holds the day.
    const tue = replay.items.filter((it) => it.day === 1);
    const landmarkAt = tue.find((it) => it.release.id === "codex-5")!.at;
    expect(capAt(landmarkAt)).toMatchObject({ id: "codex-5", kicker: "Landmark" });
    expect(capAt(1.99)).toMatchObject({ id: "codex-5", kicker: "Landmark", more: 1 });
  });

  test("a minor release on the current day reads Today; a quiet day keeps the last caption as Latest", () => {
    const wed = replay.items.find((it) => it.day === 2)!;
    expect(capAt(wed.at)).toMatchObject({ id: "grok-2", kicker: "Today" });
    // Thursday has nothing: Wednesday's caption holds.
    expect(capAt(3.5)).toMatchObject({ id: "grok-2", kicker: "Latest" });
  });
});

describe("day stepping", () => {
  test("steps to day ends", () => {
    expect(nextDayStop(0)).toBe(1);
    expect(nextDayStop(1)).toBe(2);
    expect(nextDayStop(2.4)).toBe(3);
    expect(nextDayStop(7)).toBe(7);
    expect(prevDayStop(3)).toBe(2);
    expect(prevDayStop(2.4)).toBe(2);
    expect(prevDayStop(0.5)).toBe(0);
    expect(prevDayStop(0)).toBe(0);
  });
});
