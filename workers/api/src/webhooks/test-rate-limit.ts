/** Mirrors workers/api/wrangler.jsonc `simple` quotas for webhook test sends. */
export const WEBHOOK_TEST_SUB_QUOTA = 5;
export const WEBHOOK_TEST_USER_QUOTA = 20;
export const WEBHOOK_TEST_RATE_WINDOW_SECONDS = 60;

type RateLimiter = { limit(options: { key: string }): Promise<{ success: boolean }> };

export interface WebhookTestRateLimiters {
  sub?: RateLimiter;
  user?: RateLimiter;
}

export type WebhookTestRateLimitResult = "ok" | "sub" | "user";

/**
 * Enforce per-subscription and per-user caps on synthetic test deliveries.
 * No-ops when bindings are absent (local dev / staging without unsafe block).
 */
export async function checkWebhookTestRateLimit(
  limiters: WebhookTestRateLimiters,
  userId: string,
  subscriptionId: string,
): Promise<WebhookTestRateLimitResult> {
  if (limiters.sub) {
    const sub = await limiters.sub.limit({ key: `whk_test_sub:${subscriptionId}` });
    if (!sub.success) return "sub";
  }
  if (limiters.user) {
    const user = await limiters.user.limit({ key: `whk_test_user:${userId}` });
    if (!user.success) return "user";
  }
  return "ok";
}

export function webhookTestRateLimitResponse(kind: Exclude<WebhookTestRateLimitResult, "ok">): {
  status: 429;
  body: { error: string; message: string };
  retryAfter: number;
} {
  const message =
    kind === "sub"
      ? `Webhook test limit exceeded for this subscription (${WEBHOOK_TEST_SUB_QUOTA} per minute)`
      : `Webhook test limit exceeded for your account (${WEBHOOK_TEST_USER_QUOTA} per minute)`;
  return {
    status: 429,
    body: { error: "rate_limited", message },
    retryAfter: WEBHOOK_TEST_RATE_WINDOW_SECONDS,
  };
}
