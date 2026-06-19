import { describe, expect, it } from "bun:test";
import {
  autoDisableReason,
  computeWebhookDeliveryHealth,
  shouldAutoDisableWebhook,
  USER_AUTO_DISABLE_STREAK_MS,
} from "./webhook-resilience.js";

const base = {
  enabled: true,
  userId: "u1",
  consecutiveFailures: 0,
  disabledReason: null,
  lastSuccessAt: null,
  lastErrorAt: null,
  failureStreakStartedAt: null,
  createdAt: "2026-01-01T00:00:00.000Z",
};

describe("shouldAutoDisableWebhook", () => {
  it("admin subs use the high threshold", () => {
    expect(shouldAutoDisableWebhook({ ...base, userId: null, consecutiveFailures: 49 })).toBe(
      false,
    );
    expect(shouldAutoDisableWebhook({ ...base, userId: null, consecutiveFailures: 50 })).toBe(true);
  });

  it("user subs disable at 10 consecutive failures", () => {
    expect(shouldAutoDisableWebhook({ ...base, consecutiveFailures: 9 })).toBe(false);
    expect(shouldAutoDisableWebhook({ ...base, consecutiveFailures: 10 })).toBe(true);
  });

  it("user subs disable after 3 failures spanning 48h", () => {
    const now = Date.parse("2026-06-20T12:00:00.000Z");
    const streakStart = new Date(now - USER_AUTO_DISABLE_STREAK_MS - 1000).toISOString();
    expect(
      shouldAutoDisableWebhook(
        { ...base, consecutiveFailures: 3, failureStreakStartedAt: streakStart },
        50,
        now,
      ),
    ).toBe(true);
  });
});

describe("computeWebhookDeliveryHealth", () => {
  it("reports auto_paused", () => {
    const view = computeWebhookDeliveryHealth({
      ...base,
      enabled: false,
      disabledReason: "auto-disabled after 10 consecutive delivery failures",
    });
    expect(view.health).toBe("auto_paused");
  });

  it("reports degraded for a small failure streak", () => {
    const view = computeWebhookDeliveryHealth({
      ...base,
      consecutiveFailures: 2,
      lastErrorAt: "2026-06-19T00:00:00.000Z",
      failureStreakStartedAt: "2026-06-19T00:00:00.000Z",
    });
    expect(view.health).toBe("degraded");
  });

  it("reports failing when near auto-pause", () => {
    const view = computeWebhookDeliveryHealth({
      ...base,
      consecutiveFailures: 8,
      lastErrorAt: "2026-06-19T00:00:00.000Z",
      failureStreakStartedAt: "2026-06-19T00:00:00.000Z",
    });
    expect(view.health).toBe("failing");
  });
});

describe("autoDisableReason", () => {
  it("mentions the streak duration for time-based pauses", () => {
    const now = Date.parse("2026-06-20T12:00:00.000Z");
    const streakStart = new Date(now - USER_AUTO_DISABLE_STREAK_MS).toISOString();
    const reason = autoDisableReason(
      { userId: "u1", consecutiveFailures: 4, failureStreakStartedAt: streakStart },
      now,
    );
    expect(reason).toContain("over 48h");
  });
});
