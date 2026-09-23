import { describe, it, expect } from "bun:test";
import { applySessionFilters } from "../src/status-hub.js";

const NOW = 1_735_000_000_000; // arbitrary fixed "now" for cutoff math

function session(overrides: Partial<Parameters<typeof applySessionFilters>[0][number]>) {
  return {
    sessionId: "sesn_default",
    company: "Default",
    type: "onboard" as const,
    status: "running" as const,
    startedAt: NOW - 60_000,
    lastUpdatedAt: NOW - 60_000,
    ...overrides,
  };
}

describe("applySessionFilters", () => {
  it("returns all sessions when no filters are set", () => {
    const sessions = [session({ sessionId: "a" }), session({ sessionId: "b" })];
    const out = applySessionFilters(sessions, new URLSearchParams(), NOW);
    expect(out).toHaveLength(2);
  });

  it("filters by status", () => {
    const sessions = [
      session({ sessionId: "a", status: "running" }),
      session({ sessionId: "b", status: "complete" }),
    ];
    const out = applySessionFilters(sessions, new URLSearchParams("status=running"), NOW);
    expect(out.map((s) => s.sessionId)).toEqual(["a"]);
  });

  it("filters by type", () => {
    const sessions = [
      session({ sessionId: "a", type: "onboard" }),
      session({ sessionId: "b", type: "update" }),
    ];
    const out = applySessionFilters(sessions, new URLSearchParams("type=onboard"), NOW);
    expect(out.map((s) => s.sessionId)).toEqual(["a"]);
  });

  describe("recent_minutes — the dedup window (#656)", () => {
    it("includes running sessions even when last update is older than the window", () => {
      const sessions = [
        session({
          sessionId: "still-running",
          status: "running",
          lastUpdatedAt: NOW - 30 * 60 * 1000, // 30 minutes ago
        }),
      ];
      const out = applySessionFilters(sessions, new URLSearchParams("recent_minutes=10"), NOW);
      expect(out.map((s) => s.sessionId)).toEqual(["still-running"]);
    });

    it("includes finished sessions within the window — the May 1 retry case", () => {
      const sessions = [
        session({
          sessionId: "just-finished",
          status: "complete",
          lastUpdatedAt: NOW - 5 * 60 * 1000, // 5 minutes ago — within 10m window
        }),
        session({
          sessionId: "errored-recently",
          status: "error",
          lastUpdatedAt: NOW - 9 * 60 * 1000, // 9 minutes ago — within 10m window
        }),
      ];
      const out = applySessionFilters(sessions, new URLSearchParams("recent_minutes=10"), NOW);
      expect(out.map((s) => s.sessionId).toSorted()).toEqual(["errored-recently", "just-finished"]);
    });

    it("excludes finished sessions older than the window", () => {
      const sessions = [
        session({
          sessionId: "old-complete",
          status: "complete",
          lastUpdatedAt: NOW - 20 * 60 * 1000, // 20 minutes ago — outside 10m window
        }),
      ];
      const out = applySessionFilters(sessions, new URLSearchParams("recent_minutes=10"), NOW);
      expect(out).toHaveLength(0);
    });

    it("falls back to startedAt when lastUpdatedAt is missing", () => {
      const sessions = [
        session({
          sessionId: "no-update",
          status: "complete",
          startedAt: NOW - 5 * 60 * 1000,
          lastUpdatedAt: undefined as unknown as number,
        }),
      ];
      const out = applySessionFilters(sessions, new URLSearchParams("recent_minutes=10"), NOW);
      expect(out.map((s) => s.sessionId)).toEqual(["no-update"]);
    });

    it("ignores invalid recent_minutes values", () => {
      const sessions = [
        session({
          sessionId: "old",
          status: "complete",
          lastUpdatedAt: NOW - 60 * 60 * 1000,
        }),
      ];
      expect(
        applySessionFilters(sessions, new URLSearchParams("recent_minutes=abc"), NOW),
      ).toHaveLength(1);
      expect(
        applySessionFilters(sessions, new URLSearchParams("recent_minutes=0"), NOW),
      ).toHaveLength(1);
      expect(
        applySessionFilters(sessions, new URLSearchParams("recent_minutes=-5"), NOW),
      ).toHaveLength(1);
    });

    it("composes with type filter — the discovery worker's actual query", () => {
      const sessions = [
        session({
          sessionId: "a",
          type: "onboard",
          status: "complete",
          lastUpdatedAt: NOW - 5 * 60 * 1000,
        }),
        session({
          sessionId: "b",
          type: "update",
          status: "complete",
          lastUpdatedAt: NOW - 5 * 60 * 1000,
        }),
        session({
          sessionId: "c",
          type: "onboard",
          status: "complete",
          lastUpdatedAt: NOW - 30 * 60 * 1000,
        }),
      ];
      const out = applySessionFilters(
        sessions,
        new URLSearchParams("type=onboard&recent_minutes=10"),
        NOW,
      );
      expect(out.map((s) => s.sessionId)).toEqual(["a"]);
    });
  });
});
