import { deriveSigningKey } from "@releases/core-internal/webhook-sign";
import { getSecret } from "@releases/lib/secrets";
import type { Context } from "hono";
import type { Env } from "../index.js";
import type { WebhookSubscriptionUpdates } from "./queries.js";

/** AE SQL doesn't support bound parameters; validates id before string interpolation. */
export const SUBSCRIPTION_ID_RE = /^whk_[a-zA-Z0-9_]+$/;

export function validateWebhookUrl(url: string): string | null {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return "url is invalid";
  }
  if (parsed.protocol !== "https:") {
    return "url must use HTTPS";
  }
  return null;
}

/** Returns the master HMAC key, or a 503 Response when the binding is missing. */
export async function requireMasterKey(c: Context<Env>): Promise<string | Response> {
  const masterKey = (await getSecret(c.env.WEBHOOK_HMAC_MASTER)) ?? undefined;
  if (!masterKey) {
    return c.json(
      { error: "webhook_unavailable", message: "WEBHOOK_HMAC_MASTER not configured" },
      503,
    );
  }
  return masterKey;
}

export async function signingKeyFor(
  masterKey: string,
  subscriptionId: string,
  secretVersion: number,
): Promise<string> {
  return deriveSigningKey(masterKey, subscriptionId, secretVersion);
}

export function buildWebhookPatchUpdates(
  body: Partial<{
    url: string;
    description: string | null;
    enabled: boolean;
    disabledReason: string | null;
  }>,
): WebhookSubscriptionUpdates | { error: string } {
  const updates: WebhookSubscriptionUpdates = {};
  if (body.url !== undefined) {
    const urlError = validateWebhookUrl(body.url);
    if (urlError) return { error: urlError };
    updates.url = body.url;
  }
  if (body.description !== undefined) updates.description = body.description;
  if (body.enabled !== undefined) {
    updates.enabled = body.enabled;
    if (body.enabled) {
      updates.consecutiveFailures = 0;
      updates.disabledReason = null;
      updates.failureStreakStartedAt = null;
    } else {
      updates.disabledReason = body.disabledReason ?? "manually disabled";
    }
  }
  if (Object.keys(updates).length === 0) {
    return { error: "no recognized fields to update" };
  }
  return updates;
}

/** Query Analytics Engine for recent delivery attempts (admin + self-serve). */
export async function fetchWebhookDeliveries(
  cfApiToken: string,
  cfAccountId: string,
  subscriptionId: string,
  opts: { failedOnly?: boolean; limit?: number },
): Promise<Response> {
  const limit = Math.min(100, Math.max(1, opts.limit ?? 20));
  const failedFilter = opts.failedOnly
    ? ` AND blob4 IN ('retry','perm_fail','dlq','auto_disabled')`
    : "";
  const sql =
    `SELECT timestamp, blob1 AS event_id, blob2 AS error_message, blob3 AS error_code, ` +
    `blob4 AS outcome, double1 AS http_status, double2 AS latency_ms, double3 AS attempt ` +
    `FROM webhook_deliveries ` +
    `WHERE index1 = '${subscriptionId}'${failedFilter} ` +
    `ORDER BY timestamp DESC LIMIT ${limit}`;

  return fetch(
    `https://api.cloudflare.com/client/v4/accounts/${cfAccountId}/analytics_engine/sql`,
    {
      method: "POST",
      headers: { Authorization: `Bearer ${cfApiToken}` },
      body: sql,
    },
  );
}
