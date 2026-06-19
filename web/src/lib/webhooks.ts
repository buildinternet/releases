/**
 * Browser client for self-serve webhook subscriptions (`/v1/me/webhooks` on the
 * API worker). Uses `credentials: "include"` so the cross-subdomain session
 * cookie rides along.
 */

import type {
  CreateUserWebhookResponse,
  RotateUserWebhookSecretResponse,
  TestUserWebhookResponse,
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
