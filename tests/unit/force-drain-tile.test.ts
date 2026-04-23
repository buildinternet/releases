import { describe, it, expect } from "bun:test";
import {
  parseStrandedTotal,
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

describe("summarizeForceDrain", () => {
  const NOW = new Date("2026-04-23T12:00:00.000Z").getTime();

  it("returns 'never run' tone when no row exists", () => {
    const out = summarizeForceDrain(null, NOW);
    expect(out.tone).toBe("never");
    expect(out.label).toBe("never run");
    expect(out.stranded).toBe(0);
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
    expect(out.tone).toBe("healthy");
    expect(out.stranded).toBe(0);
    expect(out.label).toBe("0 stranded · 4h ago");
  });

  it("reports stranded when stranded_total > 0", () => {
    const out = summarizeForceDrain(
      {
        startedAt: new Date(NOW - 8 * 3600_000).toISOString(),
        status: "done",
        notes: "forced=3 (unreliable=1, stale=2) stranded_total=7",
      },
      NOW,
    );
    expect(out.tone).toBe("stranded");
    expect(out.stranded).toBe(7);
    expect(out.label).toBe("7 stranded · 8h ago");
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
    expect(out.tone).toBe("failed");
    expect(out.label).toBe("last run failed (2h ago)");
  });
});
