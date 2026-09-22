/**
 * Browser client for semantic alerts (`/v1/me/semantic-alerts`).
 * Preferences only — matched releases are delivered by email and webhook, not listed here.
 *
 * Types and caps live here, not via `@buildinternet/releases-api-types`. That
 * barrel is a server/type import; a Client Component value-import pulls every
 * re-export and Next fails to resolve `./schemas/*.js`. Keep these in sync
 * with the wire constants in `packages/api-types/src/api-types.ts`.
 */

import { apiBase, errorMessage } from "./user-api";

/** Hard cap on saved semantic alerts per account. Enforced on create. */
export const SEMANTIC_ALERT_MAX_PER_USER = 5;

/** Freeform interest text, after trim. */
export const SEMANTIC_ALERT_QUERY_MAX_CHARS = 500;

/** Default selected-choice probability. */
export const SEMANTIC_ALERT_THRESHOLD_DEFAULT = 0.8;

export const SEMANTIC_ALERT_THRESHOLD_MIN = 0.5;
export const SEMANTIC_ALERT_THRESHOLD_MAX = 1;

/** One saved semantic alert. Query text is returned only to the owning user. */
export interface SemanticAlert {
  id: string;
  query: string;
  enabled: boolean;
  threshold: number;
  deliverEmail: boolean;
  deliverWebhook: boolean;
  webhookSubscriptionId: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface SemanticAlertListResponse {
  alerts: SemanticAlert[];
  candidatePool: "follows";
  maxAlerts: number;
}

/** Fields the Notifications picker reads off a webhook subscription row. */
export interface SemanticAlertWebhookOption {
  id: string;
  description?: string | null;
  scope?: string;
  orgName?: string | null;
  orgSlug?: string | null;
}

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
