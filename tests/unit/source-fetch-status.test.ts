import { describe, it, expect } from "bun:test";
import {
  evaluateFetchPending,
  STUCK_AFTER_MS,
} from "../../web/src/app/admin/status/source-fetch-status";

/**
 * Covers the badge logic for the /status Sources tab. The pre-#STUCK behavior
 * was `Boolean(changeDetectedAt)` which produced false positives any time
 * a discovery fetch errored before reaching `updateSourceAfterFetch` —
 * the flag would linger and the UI would advertise the source as queued
 * to fetch when the fetch had already happened (and failed).
 */

const NOW = new Date("2026-05-10T12:00:00.000Z").getTime();
const HOUR = 3600_000;

describe("evaluateFetchPending", () => {
  it("hides the badge for non-scrape/agent types", () => {
    expect(
      evaluateFetchPending(
        { type: "github", changeDetectedAt: new Date(NOW - HOUR).toISOString() },
        NOW,
      ).tone,
    ).toBeNull();
    expect(
      evaluateFetchPending(
        { type: "feed", changeDetectedAt: new Date(NOW - HOUR).toISOString() },
        NOW,
      ).tone,
    ).toBeNull();
  });

  it("hides the badge when no flag is set", () => {
    expect(
      evaluateFetchPending({ type: "scrape", changeDetectedAt: null, lastFetchedAt: null }, NOW)
        .tone,
    ).toBeNull();
  });

  it("hides stale flags — fetched after the change was detected", () => {
    // This is the exact scenario that motivated the rewrite: a fetch ran but
    // didn't clear the flag (e.g. errored before `updateSourceAfterFetch`).
    // The OLD logic would have advertised this as pending; the new logic
    // suppresses it so operators don't chase a non-issue.
    const result = evaluateFetchPending(
      {
        type: "scrape",
        changeDetectedAt: new Date(NOW - 2 * HOUR).toISOString(),
        lastFetchedAt: new Date(NOW - 1 * HOUR).toISOString(),
      },
      NOW,
    );
    expect(result.tone).toBeNull();
  });

  it("treats fetched=null as never-fetched (legitimately pending first drain)", () => {
    // Brand-new scrape source: its poll set the flag and the OrgActor drain
    // hasn't run yet. Display it as pending so operators can see first-fetch
    // latency.
    const result = evaluateFetchPending(
      {
        type: "scrape",
        changeDetectedAt: new Date(NOW - 2 * HOUR).toISOString(),
        lastFetchedAt: null,
      },
      NOW,
    );
    expect(result.tone).toBe("pending");
    if (result.tone) expect(result.label).toBe("Pending fetch");
  });

  it("renders 'Pending fetch' when flag is fresh and post-dates the last fetch", () => {
    const result = evaluateFetchPending(
      {
        type: "scrape",
        changeDetectedAt: new Date(NOW - 4 * HOUR).toISOString(),
        lastFetchedAt: new Date(NOW - 25 * HOUR).toISOString(),
      },
      NOW,
    );
    expect(result.tone).toBe("pending");
    if (result.tone) {
      expect(result.label).toBe("Pending fetch");
      expect(result.tooltip).toContain("4h");
    }
  });

  it("renders 'Stuck' once the flag has outlived a sweep cycle", () => {
    const result = evaluateFetchPending(
      {
        type: "scrape",
        changeDetectedAt: new Date(NOW - 48 * HOUR).toISOString(),
        lastFetchedAt: new Date(NOW - 72 * HOUR).toISOString(),
      },
      NOW,
    );
    expect(result.tone).toBe("stuck");
    if (result.tone) {
      expect(result.label).toBe("Stuck");
      expect(result.tooltip).toContain("Fetch Log");
    }
  });

  it("flips at the exact STUCK_AFTER_MS boundary", () => {
    const fetched = new Date(NOW - 100 * HOUR).toISOString();
    const justUnder = evaluateFetchPending(
      {
        type: "scrape",
        changeDetectedAt: new Date(NOW - STUCK_AFTER_MS).toISOString(),
        lastFetchedAt: fetched,
      },
      NOW,
    );
    expect(justUnder.tone).toBe("pending");
    const justOver = evaluateFetchPending(
      {
        type: "scrape",
        changeDetectedAt: new Date(NOW - STUCK_AFTER_MS - 1).toISOString(),
        lastFetchedAt: fetched,
      },
      NOW,
    );
    expect(justOver.tone).toBe("stuck");
  });

  it("treats agent-type sources the same as scrape", () => {
    const result = evaluateFetchPending(
      {
        type: "agent",
        changeDetectedAt: new Date(NOW - 2 * HOUR).toISOString(),
        lastFetchedAt: new Date(NOW - 25 * HOUR).toISOString(),
      },
      NOW,
    );
    expect(result.tone).toBe("pending");
  });

  it("hides the badge when changeDetectedAt is unparseable", () => {
    expect(
      evaluateFetchPending(
        { type: "scrape", changeDetectedAt: "not-a-date", lastFetchedAt: null },
        NOW,
      ).tone,
    ).toBeNull();
  });
});
