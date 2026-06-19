import type { WebhookSubscription } from "@buildinternet/releases-core/schema";

/** Admin-provisioned subs (no user_id) — higher threshold, event-volume driven. */
export const ADMIN_AUTO_DISABLE_FAILURES = 50;

/** User-owned subs: pause after this many consecutive delivery failures. */
export const USER_AUTO_DISABLE_FAILURES = 10;

/** User-owned subs: pause after this many failures spanning at least this long. */
export const USER_AUTO_DISABLE_MIN_FAILURES = 3;
export const USER_AUTO_DISABLE_STREAK_MS = 48 * 60 * 60 * 1000;

export type WebhookDeliveryHealth =
  | "never_delivered"
  | "healthy"
  | "degraded"
  | "failing"
  | "paused"
  | "auto_paused";

export interface WebhookDeliveryHealthView {
  health: WebhookDeliveryHealth;
  /** One-line status for UI lists. */
  summary: string;
}

type HealthInput = Pick<
  WebhookSubscription,
  | "enabled"
  | "userId"
  | "consecutiveFailures"
  | "disabledReason"
  | "lastSuccessAt"
  | "lastErrorAt"
  | "failureStreakStartedAt"
  | "createdAt"
>;

function isAutoPaused(disabledReason: string | null): boolean {
  return disabledReason != null && disabledReason.includes("auto-disabled");
}

function streakDurationMs(streakStartedAt: string | null, nowMs: number): number | null {
  if (!streakStartedAt) return null;
  const t = Date.parse(streakStartedAt);
  if (!Number.isFinite(t)) return null;
  return Math.max(0, nowMs - t);
}

/**
 * Whether a subscription should flip to disabled after the latest failure.
 * User-owned rows use a lower count threshold plus a time-based streak rule so
 * low-volume hooks don't hammer a dead endpoint for weeks.
 */
export function shouldAutoDisableWebhook(
  sub: Pick<
    WebhookSubscription,
    "enabled" | "userId" | "consecutiveFailures" | "failureStreakStartedAt"
  >,
  adminThreshold = ADMIN_AUTO_DISABLE_FAILURES,
  nowMs = Date.now(),
): boolean {
  if (!sub.enabled) return false;
  if (sub.userId) {
    if (sub.consecutiveFailures >= USER_AUTO_DISABLE_FAILURES) return true;
    if (sub.consecutiveFailures >= USER_AUTO_DISABLE_MIN_FAILURES) {
      const streakMs = streakDurationMs(sub.failureStreakStartedAt, nowMs);
      if (streakMs != null && streakMs >= USER_AUTO_DISABLE_STREAK_MS) return true;
    }
    return false;
  }
  return sub.consecutiveFailures >= adminThreshold;
}

export function autoDisableReason(
  sub: Pick<WebhookSubscription, "userId" | "consecutiveFailures" | "failureStreakStartedAt">,
  nowMs = Date.now(),
): string {
  if (sub.userId) {
    const streakMs = streakDurationMs(sub.failureStreakStartedAt, nowMs);
    if (
      sub.consecutiveFailures >= USER_AUTO_DISABLE_MIN_FAILURES &&
      streakMs != null &&
      streakMs >= USER_AUTO_DISABLE_STREAK_MS
    ) {
      const hours = Math.round(streakMs / (60 * 60 * 1000));
      return `auto-disabled after ${sub.consecutiveFailures} delivery failures over ${hours}h`;
    }
  }
  return `auto-disabled after ${sub.consecutiveFailures} consecutive delivery failures`;
}

/** High-level delivery posture from the D1 summary columns (no AE round-trip). */
export function computeWebhookDeliveryHealth(
  sub: HealthInput,
  nowMs = Date.now(),
): WebhookDeliveryHealthView {
  if (!sub.enabled) {
    if (isAutoPaused(sub.disabledReason)) {
      return {
        health: "auto_paused",
        summary: "Paused automatically after repeated delivery failures",
      };
    }
    return { health: "paused", summary: "Paused" };
  }

  if (!sub.lastSuccessAt && !sub.lastErrorAt) {
    return { health: "never_delivered", summary: "No deliveries yet" };
  }

  const failures = sub.consecutiveFailures;
  if (failures === 0) {
    return { health: "healthy", summary: "Deliveries succeeding" };
  }

  const streakMs = streakDurationMs(sub.failureStreakStartedAt, nowMs);
  const onUserLane = sub.userId != null;
  const nearAutoPause =
    onUserLane &&
    (failures >= USER_AUTO_DISABLE_FAILURES - 2 ||
      (failures >= USER_AUTO_DISABLE_MIN_FAILURES &&
        streakMs != null &&
        streakMs >= USER_AUTO_DISABLE_STREAK_MS * 0.75));

  if (nearAutoPause || failures >= 5) {
    return {
      health: "failing",
      summary: "Delivery failures — fix your endpoint or we'll pause this webhook soon",
    };
  }

  return {
    health: "degraded",
    summary: "Intermittent delivery failures — we're still retrying",
  };
}
