import { describe, it, expect } from "bun:test";
import {
  parseStrandedTotal,
  parseForceDrainCounts,
  formatForceDrainAge,
  summarizeForceDrain,
} from "../../web/src/app/status/force-drain-helpers";

/**
 * Covers the parsing + summarization the /status force-drain tile relies on.
 * Note formats come from `workers/api/src/cron/force-drain-sweep.ts`.
 */

describe("parseStrandedTotal", () => {
  it("returns 0 for the healthy-quiet note", () => {
    expect(parseStrandedTotal("no stale/unreliable sources")).toBe(0);
  });

  it("returns 0 for null or empty", () => {
    expect(parseStrandedTotal(null)).toBe(0);
    expect(parseStrandedTotal(undefined)).toBe(0);
    expect(parseStrandedTotal("")).toBe(0);
  });

  it("extracts stranded_total from the active-drain note", () => {
    expect(parseStrandedTotal("forced=3 (unreliable=1, stale=2) stranded_total=3")).toBe(3);
  });

  it("extracts stranded_total from the capped note", () => {
    // Capped case still carries the total — it's the authoritative count the
    // tile should display.
    expect(parseStrandedTotal("forced=2 (unreliable=0, stale=2) stranded_total=4")).toBe(4);
  });

  it("returns 0 for notes without the expected shape", () => {
    expect(parseStrandedTotal("preflight aborted: anthropic_auth")).toBe(0);
  });
});

describe("formatForceDrainAge", () => {
  const NOW = new Date("2026-04-23T12:00:00.000Z").getTime();

  it("renders minutes for sub-hour ages", () => {
    const iso = new Date(NOW - 15 * 60_000).toISOString();
    expect(formatForceDrainAge(iso, NOW)).toBe("15m ago");
  });

  it("renders hours for sub-2-day ages", () => {
    const iso = new Date(NOW - 6 * 3600_000).toISOString();
    expect(formatForceDrainAge(iso, NOW)).toBe("6h ago");
  });

  it("renders days for ages beyond 48h", () => {
    const iso = new Date(NOW - 72 * 3600_000).toISOString();
    expect(formatForceDrainAge(iso, NOW)).toBe("3d ago");
  });

  it("clamps negative durations to 0m", () => {
    // Guards against clock skew between worker and browser — don't render
    // nonsense like "-3m ago".
    const iso = new Date(NOW + 5 * 60_000).toISOString();
    expect(formatForceDrainAge(iso, NOW)).toBe("0m ago");
  });

  it("returns 'unknown' for invalid timestamps", () => {
    expect(formatForceDrainAge("not-a-date", NOW)).toBe("unknown");
  });
});

describe("parseForceDrainCounts", () => {
  it("returns zeros for null/empty notes", () => {
    expect(parseForceDrainCounts(null)).toEqual({ forced: 0, stranded: 0 });
    expect(parseForceDrainCounts("")).toEqual({ forced: 0, stranded: 0 });
  });

  it("returns zeros for the healthy-quiet note", () => {
    expect(parseForceDrainCounts("no stale/unreliable sources")).toEqual({
      forced: 0,
      stranded: 0,
    });
  });

  it("extracts both fields from the active-drain note", () => {
    expect(parseForceDrainCounts("forced=3 (unreliable=1, stale=2) stranded_total=3")).toEqual({
      forced: 3,
      stranded: 3,
    });
  });

  it("extracts both fields when the cap was hit", () => {
    expect(parseForceDrainCounts("forced=2 (unreliable=0, stale=2) stranded_total=4")).toEqual({
      forced: 2,
      stranded: 4,
    });
  });

  it("does not match suffixed lookalike keys", () => {
    // The word-boundary anchor on the regex means substrings like
    // "pre_forced=" or "_stranded_total=" don't accidentally satisfy the
    // match. Catches the case where a future note format embeds the key
    // name inside a longer identifier.
    expect(parseForceDrainCounts("pre_forced=9 _stranded_total=5")).toEqual({
      forced: 0,
      stranded: 0,
    });
  });
});

describe("summarizeForceDrain", () => {
  const NOW = new Date("2026-04-23T12:00:00.000Z").getTime();

  it("returns 'never run' tone when no row exists", () => {
    const out = summarizeForceDrain(null, NOW);
    expect(out).toMatchObject({
      tone: "never",
      label: "never run",
      stranded: 0,
      forced: 0,
      skipped: 0,
    });
  });

  it("reports healthy when stranded=0", () => {
    const out = summarizeForceDrain(
      {
        startedAt: new Date(NOW - 4 * 3600_000).toISOString(),
        status: "done",
        notes: "no stale/unreliable sources",
      },
      NOW,
    );
    expect(out).toMatchObject({
      tone: "healthy",
      stranded: 0,
      forced: 0,
      skipped: 0,
      label: "no stranded · 4h ago",
    });
  });

  it("reports healthy when the cron drained everything it found (forced == stranded)", () => {
    // The whole point of the safety net — found 2, drained 2, backlog is 0.
    // Coloring this amber would make routine background activity look like an
    // active problem.
    const out = summarizeForceDrain(
      {
        startedAt: new Date(NOW - 8 * 3600_000).toISOString(),
        status: "done",
        notes: "forced=2 (unreliable=0, stale=2) stranded_total=2",
      },
      NOW,
    );
    expect(out).toMatchObject({
      tone: "healthy",
      stranded: 2,
      forced: 2,
      skipped: 0,
      label: "drained 2 · 8h ago",
    });
  });

  it("reports stranded when the per-run cap was hit (skipped > 0)", () => {
    const out = summarizeForceDrain(
      {
        startedAt: new Date(NOW - 8 * 3600_000).toISOString(),
        status: "done",
        notes: "forced=3 (unreliable=1, stale=2) stranded_total=7",
      },
      NOW,
    );
    expect(out).toMatchObject({
      tone: "stranded",
      stranded: 7,
      forced: 3,
      skipped: 4,
      label: "4 backlog · drained 3 · 8h ago",
    });
  });

  it("reports failed tone for non-done statuses", () => {
    const out = summarizeForceDrain(
      {
        startedAt: new Date(NOW - 2 * 3600_000).toISOString(),
        status: "aborted",
        notes: null,
      },
      NOW,
    );
    expect(out).toMatchObject({
      tone: "failed",
      label: "last run failed (2h ago)",
      stranded: 0,
      forced: 0,
      skipped: 0,
    });
  });
});
