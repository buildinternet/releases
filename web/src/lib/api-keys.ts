/**
 * Browser client for the self-serve user API key surface (`/v1/api-keys` on the
 * API worker). Uses `credentials: "include"` so the cross-subdomain
 * (`.releases.sh`) Better Auth session cookie rides along. NOT the Better Auth
 * apiKeyClient() — the server wraps create to set permissions/userId, so we talk
 * to our own endpoints for one consistent surface.
 */

import type {
  UserApiKey,
  CreatedUserApiKey,
  ListUserApiKeysResponse,
} from "@buildinternet/releases-api-types";
export type { UserApiKey, CreatedUserApiKey, ListUserApiKeysResponse };

function apiBase(): string {
  const url = process.env.NEXT_PUBLIC_BETTER_AUTH_URL;
  if (!url) throw new Error("NEXT_PUBLIC_BETTER_AUTH_URL is not set");
  return url.replace(/\/$/, "");
}

async function errorMessage(res: Response, fallback: string): Promise<string> {
  try {
    const body = (await res.json()) as { message?: string };
    return body.message || fallback;
  } catch {
    return fallback;
  }
}

export async function listApiKeys(): Promise<UserApiKey[]> {
  const res = await fetch(`${apiBase()}/v1/api-keys`, { credentials: "include" });
  if (!res.ok) throw new Error(await errorMessage(res, `Failed to load API keys (${res.status})`));
  const data = (await res.json()) as ListUserApiKeysResponse;
  return data.apiKeys;
}

// Self-serve user keys are read-only; the server caps the scope and an omitted
// scope defaults to read. The ApiScope type admits write/admin so an out-of-band
// key renders correctly in the list.
export async function createApiKey(input: {
  name: string;
  scope?: "read";
  expiresInDays?: number;
}): Promise<CreatedUserApiKey> {
  const res = await fetch(`${apiBase()}/v1/api-keys`, {
    method: "POST",
    credentials: "include",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input),
  });
  if (!res.ok) throw new Error(await errorMessage(res, `Failed to create API key (${res.status})`));
  return (await res.json()) as CreatedUserApiKey;
}

export async function revokeApiKey(id: string): Promise<void> {
  const res = await fetch(`${apiBase()}/v1/api-keys/${encodeURIComponent(id)}`, {
    method: "DELETE",
    credentials: "include",
  });
  if (!res.ok) throw new Error(await errorMessage(res, `Failed to revoke API key (${res.status})`));
}
