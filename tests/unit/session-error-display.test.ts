import { describe, it, expect } from "bun:test";
import {
  formatSessionError,
  groupProviderIncidents,
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

  it("treats unknown errorSource as our-side", () => {
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

function s(startedAt: number, errorType?: string): ClassifiedSession {
  return {
    status: "error",
    startedAt,
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
    const groups = groupProviderIncidents([
      s(t, "unknown_error"),
      s(t + 1_000, "unknown_error"),
      s(t + 30_000, "unknown_error"),
    ]);
    expect(groups).toHaveLength(1);
    expect(groups[0]).toEqual({
      errorType: "unknown_error",
      count: 3,
      startedAt: t,
      endedAt: t + 30_000,
    });
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
