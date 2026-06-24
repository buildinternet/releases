/**
 * Browser client for self-serve webhook subscriptions (`/v1/me/webhooks` on the
 * API worker). Uses `credentials: "include"` so the cross-subdomain session
 * cookie rides along.
 */

import type {
  CreateUserWebhookResponse,
  RotateUserWebhookSecretResponse,
  TestUserWebhookResponse,
  UserWebhookFormat,
  UserWebhookListItem,
  UserWebhookListResponse,
  UserWebhookReleaseTypeFilter,
  UserWebhookScope,
} from "@buildinternet/releases-api-types";
import { apiBase, errorMessage } from "./user-api";

export type {
  CreateUserWebhookResponse,
  RotateUserWebhookSecretResponse,
  TestUserWebhookResponse,
  UserWebhookFormat,
  UserWebhookListItem,
  UserWebhookScope,
};

export async function listWebhooks(): Promise<UserWebhookListItem[]> {
  const res = await fetch(`${apiBase()}/v1/me/webhooks`, { credentials: "include" });
  if (!res.ok) throw new Error(await errorMessage(res, `Failed to load webhooks (${res.status})`));
  return ((await res.json()) as UserWebhookListResponse).subscriptions;
}

export async function createWebhook(input: {
  url: string;
  scope?: UserWebhookScope;
  orgSlug?: string;
  productSlug?: string;
  sourceSlug?: string;
  releaseType?: UserWebhookReleaseTypeFilter;
  format?: UserWebhookFormat;
  description?: string;
}): Promise<CreateUserWebhookResponse> {
  const res = await fetch(`${apiBase()}/v1/me/webhooks`, {
    method: "POST",
    credentials: "include",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input),
  });
  if (!res.ok) throw new Error(await errorMessage(res, `Failed to create webhook (${res.status})`));
  return (await res.json()) as CreateUserWebhookResponse;
}

export async function updateWebhook(
  id: string,
  patch: { url?: string; description?: string | null; enabled?: boolean },
): Promise<UserWebhookListItem> {
  const res = await fetch(`${apiBase()}/v1/me/webhooks/${encodeURIComponent(id)}`, {
    method: "PATCH",
    credentials: "include",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(patch),
  });
  if (!res.ok) throw new Error(await errorMessage(res, `Failed to update webhook (${res.status})`));
  return (await res.json()) as UserWebhookListItem;
}

export async function deleteWebhook(id: string): Promise<void> {
  const res = await fetch(`${apiBase()}/v1/me/webhooks/${encodeURIComponent(id)}`, {
    method: "DELETE",
    credentials: "include",
  });
  if (!res.ok) throw new Error(await errorMessage(res, `Failed to delete webhook (${res.status})`));
}

export async function rotateWebhookSecret(id: string): Promise<RotateUserWebhookSecretResponse> {
  const res = await fetch(`${apiBase()}/v1/me/webhooks/${encodeURIComponent(id)}/rotate-secret`, {
    method: "POST",
    credentials: "include",
  });
  if (!res.ok)
    throw new Error(await errorMessage(res, `Failed to rotate signing key (${res.status})`));
  return (await res.json()) as RotateUserWebhookSecretResponse;
}

export async function testWebhook(id: string): Promise<TestUserWebhookResponse> {
  const res = await fetch(`${apiBase()}/v1/me/webhooks/${encodeURIComponent(id)}/test`, {
    method: "POST",
    credentials: "include",
  });
  if (!res.ok) throw new Error(await errorMessage(res, `Failed to send test (${res.status})`));
  return (await res.json()) as TestUserWebhookResponse;
}

/** One Analytics Engine delivery-attempt row from `GET /v1/me/webhooks/:id/deliveries`. */
export interface WebhookDeliveryRow {
  timestamp?: string;
  event_id?: string;
  error_message?: string | null;
  error_code?: string | null;
  outcome?: string;
  http_status?: number;
  latency_ms?: number;
  attempt?: number;
}

/** Returns `null` when delivery history is unavailable (501). */
export async function listWebhookDeliveries(
  id: string,
  opts?: { failed?: boolean; limit?: number },
): Promise<WebhookDeliveryRow[] | null> {
  const params = new URLSearchParams();
  if (opts?.failed) params.set("failed", "true");
  if (opts?.limit !== undefined) params.set("limit", String(opts.limit));
  const qs = params.toString();
  const res = await fetch(
    `${apiBase()}/v1/me/webhooks/${encodeURIComponent(id)}/deliveries${qs ? `?${qs}` : ""}`,
    { credentials: "include" },
  );
  if (res.status === 501) return null;
  if (!res.ok)
    throw new Error(await errorMessage(res, `Failed to load deliveries (${res.status})`));
  const body = (await res.json()) as { data?: WebhookDeliveryRow[] };
  return body.data ?? [];
}
