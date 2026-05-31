import { describe, it, expect } from "bun:test";
import type { Source } from "@buildinternet/releases-core/schema";
import {
  describeFetchPlan,
  computeFetchState,
  computeSweepHealth,
  SWEEP_STARVED_THRESHOLD_HOURS,
  TIER_INTERVALS,
  FIRECRAWL_DEFAULT_SCHEDULE,
} from "./fetch-plan.js";

// Build a Source row with sane defaults; override per test. The resolver only
// reads type / metadata / fetchPriority / lastPolledAt / nextFetchAfter, so the
// cast covers any schema columns not spelled out here.
function mkSource(
  over: Omit<Partial<Source>, "metadata"> & { metadata?: Record<string, unknown> | null },
): Source {
  const { metadata, ...rest } = over;
  return {
    id: "src_x",
    orgId: "org_x",
    slug: "x",
    name: "X",
    url: "https://x.test",
    type: "scrape",
    fetchPriority: "normal",
    nextFetchAfter: null,
    lastPolledAt: null,
    lastFetchedAt: null,
    ...rest,
    metadata: metadata === undefined || metadata === null ? null : JSON.stringify(metadata),
  } as unknown as Source;
}

describe("describeFetchPlan — strategy", () => {
  it("github type → GitHub API", () => {
    expect(describeFetchPlan(mkSource({ type: "github" })).strategy).toBe("github");
    expect(describeFetchPlan(mkSource({ type: "github" })).strategyLabel).toBe("GitHub API");
  });

  it("scrape with githubUrl override → github", () => {
    const s = mkSource({ type: "scrape", metadata: { githubUrl: "https://github.com/a/b" } });
    expect(describeFetchPlan(s).strategy).toBe("github");
  });

  it("appstore type → App Store", () => {
    expect(describeFetchPlan(mkSource({ type: "appstore" })).strategyLabel).toBe("App Store");
  });

  it("video type → Video feed", () => {
    expect(describeFetchPlan(mkSource({ type: "video" })).strategyLabel).toBe("Video feed");
  });

  it("feedUrl present → feed label refines by feedType", () => {
    expect(
      describeFetchPlan(mkSource({ type: "feed", metadata: { feedUrl: "u", feedType: "rss" } }))
        .strategyLabel,
    ).toBe("RSS feed");
    expect(
      describeFetchPlan(mkSource({ type: "feed", metadata: { feedUrl: "u", feedType: "atom" } }))
        .strategyLabel,
    ).toBe("Atom feed");
    expect(
      describeFetchPlan(
        mkSource({ type: "feed", metadata: { feedUrl: "u", feedType: "jsonfeed" } }),
      ).strategyLabel,
    ).toBe("JSON Feed");
  });

  it("scrape with crawlEnabled → Multi-page crawl", () => {
    expect(
      describeFetchPlan(mkSource({ type: "scrape", metadata: { crawlEnabled: true } }))
        .strategyLabel,
    ).toBe("Multi-page crawl");
  });

  it("agent type with no feed → Agent extraction", () => {
    expect(describeFetchPlan(mkSource({ type: "agent" })).strategyLabel).toBe("Agent extraction");
  });

  it("plain scrape → Browser scrape", () => {
    expect(describeFetchPlan(mkSource({ type: "scrape" })).strategyLabel).toBe("Browser scrape");
  });

  it("firecrawl.enabled wins over type and uses its schedule + webhook cadence", () => {
    const s = mkSource({
      type: "scrape",
      metadata: { firecrawl: { enabled: true, schedule: "every 12 hours" } },
    });
    const plan = describeFetchPlan(s);
    expect(plan.strategy).toBe("firecrawl");
    expect(plan.cadence).toBe("firecrawl-webhook");
    expect(plan.intervalHours).toBeNull();
    expect(plan.intervalLabel).toBe("every 12 hours");
    expect(plan.firecrawlSchedule).toBe("every 12 hours");
  });

  it("firecrawl without an explicit schedule falls back to the default", () => {
    const s = mkSource({ type: "scrape", metadata: { firecrawl: { enabled: true } } });
    expect(describeFetchPlan(s).intervalLabel).toBe(FIRECRAWL_DEFAULT_SCHEDULE);
  });
});

describe("describeFetchPlan — interval", () => {
  it("normal → every 4 hours", () => {
    const plan = describeFetchPlan(mkSource({ fetchPriority: "normal" }));
    expect(plan.intervalHours).toBe(TIER_INTERVALS.normal);
    expect(plan.intervalLabel).toBe("every 4 hours");
  });

  it("low → every 24 hours", () => {
    const plan = describeFetchPlan(mkSource({ fetchPriority: "low" }));
    expect(plan.intervalHours).toBe(24);
    expect(plan.intervalLabel).toBe("every 24 hours");
  });

  it("paused → null interval, paused label, paused flag", () => {
    const plan = describeFetchPlan(mkSource({ fetchPriority: "paused" }));
    expect(plan.intervalHours).toBeNull();
    expect(plan.intervalLabel).toBe("paused");
    expect(plan.paused).toBe(true);
  });
});

describe("computeFetchState", () => {
  const now = new Date("2026-01-02T00:00:00.000Z");

  it("paused source has no next-due", () => {
    const s = mkSource({ fetchPriority: "paused", lastPolledAt: "2026-01-01T00:00:00.000Z" });
    const state = computeFetchState(s, describeFetchPlan(s), now);
    expect(state.nextDueAt).toBeNull();
    expect(state.paused).toBe(true);
  });

  it("firecrawl source has no local next-due", () => {
    const s = mkSource({ metadata: { firecrawl: { enabled: true } } });
    const state = computeFetchState(s, describeFetchPlan(s), now);
    expect(state.nextDueAt).toBeNull();
    expect(state.backedOff).toBe(false);
  });

  it("normal source next-due = lastPolledAt + 4h", () => {
    const s = mkSource({ fetchPriority: "normal", lastPolledAt: "2026-01-01T20:00:00.000Z" });
    const state = computeFetchState(s, describeFetchPlan(s), now);
    expect(state.nextDueAt).toBe("2026-01-02T00:00:00.000Z");
    expect(state.backedOff).toBe(false);
  });

  it("backoff (nextFetchAfter beyond the tier interval) sets backedOff and pushes next-due out", () => {
    const s = mkSource({
      fetchPriority: "normal",
      lastPolledAt: "2026-01-01T20:00:00.000Z", // tier-due at 2026-01-02T00:00
      nextFetchAfter: "2026-01-02T06:00:00.000Z", // backed off later
    });
    const state = computeFetchState(s, describeFetchPlan(s), now);
    expect(state.backedOff).toBe(true);
    expect(state.nextDueAt).toBe("2026-01-02T06:00:00.000Z");
  });

  it("malformed timestamps fall back to due-now instead of throwing", () => {
    const s = mkSource({ fetchPriority: "normal", lastPolledAt: "not-a-date" });
    let state: ReturnType<typeof computeFetchState> | undefined;
    expect(() => {
      state = computeFetchState(s, describeFetchPlan(s), now);
    }).not.toThrow();
    // Invalid lastPolledAt → treated as never-polled (due now + 4h tier).
    expect(state!.nextDueAt).toBe("2026-01-02T04:00:00.000Z");
    expect(state!.backedOff).toBe(false);
  });
});

describe("computeSweepHealth", () => {
  const NOW = new Date("2026-05-31T12:00:00.000Z");
  const hoursAgo = (h: number) => new Date(NOW.getTime() - h * 3_600_000).toISOString();
  const planFor = (s: Source) => describeFetchPlan(s);
  const health = (s: Source) => computeSweepHealth(s, planFor(s), NOW);

  it("flags a queued scrape source not fetched within the threshold as starved", () => {
    const s = mkSource({
      type: "scrape",
      changeDetectedAt: hoursAgo(1), // flag re-stamped recently (flapping validator)
      lastFetchedAt: hoursAgo(SWEEP_STARVED_THRESHOLD_HOURS + 24),
    });
    const h = health(s);
    expect(h.sweepDriven).toBe(true);
    expect(h.starved).toBe(true);
    expect(h.flaggedAt).toBe(hoursAgo(1));
  });

  it("does not flag a queued source fetched recently", () => {
    const s = mkSource({
      type: "scrape",
      changeDetectedAt: hoursAgo(1),
      lastFetchedAt: hoursAgo(2),
    });
    expect(health(s).starved).toBe(false);
  });

  it("does not flag a stale source that isn't queued for the sweep", () => {
    const s = mkSource({
      type: "scrape",
      changeDetectedAt: null,
      lastFetchedAt: hoursAgo(SWEEP_STARVED_THRESHOLD_HOURS + 24),
    });
    const h = health(s);
    expect(h.starved).toBe(false);
    expect(h.flaggedAt).toBeNull();
  });

  it("includes agent-type sources", () => {
    const s = mkSource({
      type: "agent",
      changeDetectedAt: hoursAgo(1),
      lastFetchedAt: hoursAgo(SWEEP_STARVED_THRESHOLD_HOURS + 1),
    });
    const h = health(s);
    expect(h.sweepDriven).toBe(true);
    expect(h.starved).toBe(true);
  });

  it("never starves a Firecrawl-owned source (not sweep-driven)", () => {
    const s = mkSource({
      type: "scrape",
      metadata: { firecrawl: { enabled: true, schedule: "every 24 hours" } },
      changeDetectedAt: hoursAgo(1),
      lastFetchedAt: hoursAgo(SWEEP_STARVED_THRESHOLD_HOURS + 100),
    });
    const h = health(s);
    expect(h.sweepDriven).toBe(false);
    expect(h.starved).toBe(false);
  });

  it("never starves a paused source", () => {
    const s = mkSource({
      type: "scrape",
      fetchPriority: "paused",
      changeDetectedAt: hoursAgo(1),
      lastFetchedAt: hoursAgo(SWEEP_STARVED_THRESHOLD_HOURS + 100),
    });
    expect(health(s).starved).toBe(false);
  });

  it("uses createdAt as the clock for a never-fetched source", () => {
    const freshlyCreated = mkSource({
      type: "scrape",
      changeDetectedAt: hoursAgo(1),
      lastFetchedAt: null,
      createdAt: hoursAgo(1),
    });
    // Just created and flagged → not starved yet.
    expect(health(freshlyCreated).starved).toBe(false);

    const longStranded = mkSource({
      type: "scrape",
      changeDetectedAt: hoursAgo(1),
      lastFetchedAt: null,
      createdAt: hoursAgo(SWEEP_STARVED_THRESHOLD_HOURS + 100),
    });
    expect(health(longStranded).starved).toBe(true);
  });
});
