/**
 * Browser client for semantic alerts (`/v1/me/semantic-alerts`).
 * Phase 1 stores preferences only — nothing here fetches matched releases.
 */

import type { SemanticAlert, SemanticAlertListResponse } from "@buildinternet/releases-api-types";
import { apiBase, errorMessage } from "./user-api";

export type { SemanticAlert };

export interface SemanticAlertInput {
  query: string;
  enabled?: boolean;
  threshold?: number;
  deliverEmail?: boolean;
  deliverWebhook?: boolean;
  webhookSubscriptionId?: string | null;
}

export async function listSemanticAlerts(): Promise<SemanticAlertListResponse> {
  const res = await fetch(`${apiBase()}/v1/me/semantic-alerts`, { credentials: "include" });
  if (!res.ok)
    throw new Error(await errorMessage(res, `Failed to load interest alerts (${res.status})`));
  return (await res.json()) as SemanticAlertListResponse;
}

export async function createSemanticAlert(input: SemanticAlertInput): Promise<SemanticAlert> {
  const res = await fetch(`${apiBase()}/v1/me/semantic-alerts`, {
    method: "POST",
    credentials: "include",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input),
  });
  if (!res.ok)
    throw new Error(await errorMessage(res, `Failed to save interest alert (${res.status})`));
  return (await res.json()) as SemanticAlert;
}

export async function updateSemanticAlert(
  id: string,
  patch: Partial<SemanticAlertInput>,
): Promise<SemanticAlert> {
  const res = await fetch(`${apiBase()}/v1/me/semantic-alerts/${encodeURIComponent(id)}`, {
    method: "PATCH",
    credentials: "include",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(patch),
  });
  if (!res.ok)
    throw new Error(await errorMessage(res, `Failed to update interest alert (${res.status})`));
  return (await res.json()) as SemanticAlert;
}

export async function deleteSemanticAlert(id: string): Promise<void> {
  const res = await fetch(`${apiBase()}/v1/me/semantic-alerts/${encodeURIComponent(id)}`, {
    method: "DELETE",
    credentials: "include",
  });
  if (!res.ok)
    throw new Error(await errorMessage(res, `Failed to delete interest alert (${res.status})`));
}
