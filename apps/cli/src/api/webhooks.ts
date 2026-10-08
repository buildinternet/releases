import type { WebhookDeliveryRow } from "@buildinternet/releases-api-types";
import { apiFetch } from "./core.js";

export type { WebhookDeliveryRow };

/**
 * A webhook subscription as returned by the read paths. Defined locally rather
 * than re-exported from `@buildinternet/releases-api-types` because the wire
 * shape is worker-internal (admin-only) and not part of the published types.
 */
export interface WebhookSubscription {
  id: string;
  orgId: string;
  url: string;
  sourceId: string | null;
  enabled: boolean;
  description: string | null;
  secretVersion: number;
  createdAt: string;
  lastSuccessAt: string | null;
  lastErrorAt: string | null;
  lastErrorMsg: string | null;
  consecutiveFailures: number;
  disabledReason: string | null;
}

/** Create + rotate-secret carry the derived signing key exactly once. */
export interface WebhookSubscriptionWithKey extends WebhookSubscription {
  signingKey: string;
}

/** Fields accepted by `POST /v1/webhooks`. `orgId`/`sourceId` are resolved ids, not slugs. */
export interface CreateWebhookSubscriptionInput {
  orgId: string;
  url: string;
  sourceId?: string | null;
  description?: string | null;
}

/** Register a webhook subscription. The `signingKey` is shown once and never again. */
export async function createWebhookSubscription(
  input: CreateWebhookSubscriptionInput,
): Promise<WebhookSubscriptionWithKey> {
  return apiFetch<WebhookSubscriptionWithKey>(`/v1/webhooks`, {
    method: "POST",
    body: JSON.stringify(input),
  });
}

/** List an org's webhook subscriptions. Requires an org id (no cross-org route exists). */
export async function listWebhookSubscriptions(
  orgId: string,
  opts?: { enabled?: boolean },
): Promise<WebhookSubscription[]> {
  const params = new URLSearchParams({ org: orgId });
  if (opts?.enabled !== undefined) params.set("enabled", String(opts.enabled));
  const res = await apiFetch<{ subscriptions: WebhookSubscription[] } | null>(
    `/v1/webhooks?${params.toString()}`,
  );
  if (!res) {
    throw new Error(
      "listWebhookSubscriptions: 404 from /v1/webhooks — is the webhooks route deployed?",
    );
  }
  return res.subscriptions ?? [];
}

/** Read one subscription by id. Returns null when no such subscription exists (404). */
export async function getWebhookSubscription(id: string): Promise<WebhookSubscription | null> {
  return apiFetch<WebhookSubscription | null>(`/v1/webhooks/${encodeURIComponent(id)}`);
}

/** Update url / description / enabled on a subscription. Does NOT rotate the signing key. */
export async function updateWebhookSubscription(
  id: string,
  fields: { url?: string; description?: string | null; enabled?: boolean },
): Promise<WebhookSubscription> {
  return apiFetch<WebhookSubscription>(`/v1/webhooks/${encodeURIComponent(id)}`, {
    method: "PATCH",
    body: JSON.stringify(fields),
  });
}

/** Hard-delete a subscription (delivery history is Analytics-Engine-only, untouched). */
export async function deleteWebhookSubscription(id: string): Promise<void> {
  await apiFetch<void>(`/v1/webhooks/${encodeURIComponent(id)}`, { method: "DELETE" });
}

/** Bump the secret version, invalidating the old key. Returns the new key once. */
export async function rotateWebhookSecret(
  id: string,
): Promise<{ secretVersion: number; signingKey: string }> {
  return apiFetch<{ secretVersion: number; signingKey: string }>(
    `/v1/webhooks/${encodeURIComponent(id)}/rotate-secret`,
    { method: "POST" },
  );
}

/** Enqueue a synthetic `release.created` event to the subscription's URL. */
export async function testWebhookSubscription(
  id: string,
): Promise<{ enqueued: boolean; eventId: string }> {
  return apiFetch<{ enqueued: boolean; eventId: string }>(
    `/v1/webhooks/${encodeURIComponent(id)}/test`,
    { method: "POST" },
  );
}

/**
 * Fetch recent delivery attempts from Analytics Engine. The route supports
 * `failed` + `limit`; `--since` filtering is applied client-side by the command
 * (the AE-backed route has no time-range param yet).
 */
export async function getWebhookDeliveries(
  id: string,
  opts?: { failed?: boolean; limit?: number },
): Promise<WebhookDeliveryRow[]> {
  const params = new URLSearchParams();
  if (opts?.failed) params.set("failed", "true");
  if (opts?.limit !== undefined) params.set("limit", String(opts.limit));
  const qs = params.toString();
  const res = await apiFetch<{ data?: WebhookDeliveryRow[] } | null>(
    `/v1/webhooks/${encodeURIComponent(id)}/deliveries${qs ? `?${qs}` : ""}`,
  );
  return res?.data ?? [];
}
