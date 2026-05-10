import { describe, it, expect } from "bun:test";
import {
  formatSessionError,
  groupProviderIncidents,
  isIncidentResolved,
  INCIDENT_RESOLVED_AFTER_MS,
  type ClassifiedSession,
} from "../../web/src/app/status/session-error-display";

const baseError: ClassifiedSession = {
  status: "error",
  startedAt: 1_700_000_000_000,
  error: "An internal service error occurred.",
};

describe("formatSessionError", () => {
  it("returns null for non-error status", () => {
    expect(formatSessionError({ ...baseError, status: "running" })).toBeNull();
    expect(formatSessionError({ ...baseError, status: "complete" })).toBeNull();
    expect(formatSessionError({ ...baseError, status: "cancelled" })).toBeNull();
  });

  it("renders our-side errors in red with the raw message", () => {
    const display = formatSessionError({ ...baseError, error: "Agent completed without tools" });
    expect(display).toEqual({
      label: "Agent completed without tools",
      tooltip: "Agent completed without tools",
      tone: "red",
    });
  });

  it("treats sessions with no errorSource as our-side (legacy / pre-#591 sessions)", () => {
    const { errorSource: _ignored, ...withoutSource } = {
      ...baseError,
      error: "Session timed out",
    };
    const display = formatSessionError(withoutSource);
    expect(display?.tone).toBe("red");
    expect(display?.label).toBe("Session timed out");
  });

  it("treats explicit errorSource: 'us' as our-side", () => {
    const display = formatSessionError({
      ...baseError,
      errorSource: "us",
      error: "Session timed out",
    });
    expect(display?.tone).toBe("red");
  });

  it("renders provider errors in amber with managed-agents framing", () => {
    const display = formatSessionError({
      ...baseError,
      errorSource: "provider",
      errorType: "unknown_error",
    });
    expect(display).toEqual({
      label: "managed-agents · unknown_error",
      tooltip: "managed-agents · unknown_error\nAn internal service error occurred.",
      tone: "amber",
    });
  });

  it("calls out retries_exhausted with the retry count in the tooltip", () => {
    const display = formatSessionError({
      ...baseError,
      errorSource: "provider",
      errorType: "unknown_error",
      stopReason: "retries_exhausted",
      retryCount: 6,
    });
    expect(display?.label).toBe("managed-agents · retries exhausted · unknown_error");
    expect(display?.tooltip).toContain("6 retries");
    expect(display?.tone).toBe("amber");
  });
});

let nextId = 0;
function s(startedAt: number, errorType?: string, errorAt?: number): ClassifiedSession {
  return {
    sessionId: `sess_${nextId++}`,
    status: "error",
    startedAt,
    ...(errorAt !== undefined ? { errorAt } : {}),
    ...(errorType ? { errorSource: "provider" as const, errorType } : {}),
  };
}

describe("groupProviderIncidents", () => {
  const t = 1_700_000_000_000;

  it("returns no groups when fewer than 3 errors", () => {
    expect(groupProviderIncidents([s(t, "unknown_error"), s(t + 1000, "unknown_error")])).toEqual(
      [],
    );
  });

  it("groups 3+ provider errors of the same type within 60s", () => {
    const sessions = [
      s(t, "unknown_error"),
      s(t + 1_000, "unknown_error"),
      s(t + 30_000, "unknown_error"),
    ];
    const groups = groupProviderIncidents(sessions);
    expect(groups).toHaveLength(1);
    expect(groups[0]).toMatchObject({
      errorType: "unknown_error",
      count: 3,
      startedAt: t,
      endedAt: t + 30_000,
    });
    expect(groups[0].sessionIds).toEqual(sessions.map((x) => x.sessionId!));
  });

  it("buckets by errorAt (terminal time) when present, not startedAt", () => {
    // Sessions started 10 minutes apart but failed within seconds of each other —
    // upstream incident, should still group.
    const groups = groupProviderIncidents([
      s(t, "unknown_error", t + 600_000),
      s(t + 60_000, "unknown_error", t + 600_500),
      s(t + 120_000, "unknown_error", t + 601_000),
    ]);
    expect(groups).toHaveLength(1);
    expect(groups[0]).toMatchObject({ count: 3, startedAt: t + 600_000, endedAt: t + 601_000 });
  });

  it("starts a new group across a 60s gap", () => {
    const groups = groupProviderIncidents([
      s(t, "unknown_error"),
      s(t + 10_000, "unknown_error"),
      s(t + 20_000, "unknown_error"),
      s(t + 200_000, "unknown_error"),
      s(t + 210_000, "unknown_error"),
      s(t + 220_000, "unknown_error"),
    ]);
    expect(groups).toHaveLength(2);
    expect(groups.map((g) => g.count)).toEqual([3, 3]);
  });

  it("uses a trailing-edge window — chains stay one incident as long as gaps stay <=60s", () => {
    // A continuing burst is still the same incident; the window resets each
    // time a new error lands within 60s of the previous one.
    const groups = groupProviderIncidents([
      s(t, "unknown_error"),
      s(t + 50_000, "unknown_error"),
      s(t + 100_000, "unknown_error"),
      s(t + 150_000, "unknown_error"),
    ]);
    expect(groups).toHaveLength(1);
    expect(groups[0]).toMatchObject({ count: 4, startedAt: t, endedAt: t + 150_000 });
  });

  it("does not merge across error types", () => {
    const groups = groupProviderIncidents([
      s(t, "unknown_error"),
      s(t + 1_000, "model_overloaded_error"),
      s(t + 2_000, "unknown_error"),
      s(t + 3_000, "model_overloaded_error"),
      s(t + 4_000, "unknown_error"),
      s(t + 5_000, "model_overloaded_error"),
    ]);
    expect(groups).toHaveLength(2);
    expect(new Set(groups.map((g) => g.errorType))).toEqual(
      new Set(["unknown_error", "model_overloaded_error"]),
    );
  });

  it("ignores our-side errors and provider errors without errorType", () => {
    const groups = groupProviderIncidents([
      s(t, "unknown_error"),
      s(t + 1_000), // our-side error, no errorType
      { status: "error", startedAt: t + 2_000, errorSource: "provider" }, // provider but no errorType
      s(t + 3_000, "unknown_error"),
      s(t + 4_000, "unknown_error"),
    ]);
    expect(groups).toHaveLength(1);
    expect(groups[0].count).toBe(3);
  });
});

describe("isIncidentResolved", () => {
  const t = 1_700_000_000_000;
  const baseGroup = {
    errorType: "mcp_connection_failed_error",
    count: 5,
    startedAt: t,
    sessionIds: ["a", "b", "c", "d", "e"],
  };

  it("treats a fresh cluster (last error within window) as active", () => {
    const now = t + INCIDENT_RESOLVED_AFTER_MS - 1_000;
    expect(isIncidentResolved({ ...baseGroup, endedAt: t + 60_000 }, now)).toBe(false);
  });

  it("treats a quiet cluster (last error past window) as resolved", () => {
    // 24h gap since the last error in the cluster — this is what was making
    // yesterday's incident look like it was happening right now.
    const now = t + 24 * 60 * 60_000;
    expect(isIncidentResolved({ ...baseGroup, endedAt: t + 60_000 }, now)).toBe(true);
  });

  it("flips at the exact threshold boundary", () => {
    const endedAt = t + 60_000;
    // ms < threshold → still active
    expect(
      isIncidentResolved({ ...baseGroup, endedAt }, endedAt + INCIDENT_RESOLVED_AFTER_MS),
    ).toBe(false);
    // ms > threshold → resolved
    expect(
      isIncidentResolved({ ...baseGroup, endedAt }, endedAt + INCIDENT_RESOLVED_AFTER_MS + 1),
    ).toBe(true);
  });
});
