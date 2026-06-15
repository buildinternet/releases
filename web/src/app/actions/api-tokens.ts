"use server";

import { webApiHeaders } from "@/lib/api";
import { isApiScope, type ApiScope } from "@buildinternet/releases-core/api-token";
import { PRIMARY_OWNER } from "@/lib/api-tokens-admin-flag";
import { adminActionEnv } from "@/lib/admin-action";

const REQUEST_TIMEOUT_MS = 10_000;

export interface PublicTokenRow {
  id: string;
  lookupId: string;
  name: string;
  scopes: string[];
  principalType: string | null;
  principalId: string | null;
  active: boolean;
  revokedAt: string | null;
  expiresAt: string | null;
  lastUsedAt: string | null;
  createdAt: string;
  createdBy: string | null;
}

export interface MintedTokenRow extends PublicTokenRow {
  token: string;
}

/**
 * Admin fetch that parses the JSON body. The credential is resolved by
 * `adminActionEnv()` — the root key in local dev, or the caller's role-clamped
 * per-user JWT in production (the API enforces `admin` scope). Every failure
 * mode — no admin credential, network error, timeout, non-2xx, or malformed
 * body — is normalized to an `{ ok: false; error }` result so callers never throw.
 */
async function adminFetch<T>(
  path: string,
  init?: RequestInit,
): Promise<{ ok: true; data: T } | { ok: false; error: string }> {
  const env = await adminActionEnv();
  if ("error" in env) return { ok: false, error: env.error };
  let res: Response;
  try {
    res = await fetch(`${env.apiUrl}${path}`, {
      cache: "no-store",
      ...init,
      headers: webApiHeaders({
        Authorization: `Bearer ${env.apiSecret}`,
        "Content-Type": "application/json",
      }),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch (err) {
    if (err instanceof Error && (err.name === "TimeoutError" || err.name === "AbortError")) {
      return { ok: false, error: `Request timed out after ${REQUEST_TIMEOUT_MS / 1000}s.` };
    }
    return { ok: false, error: err instanceof Error ? err.message : "Network error" };
  }
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    return { ok: false, error: `API ${res.status}: ${text || res.statusText}` };
  }
  try {
    return { ok: true, data: (await res.json()) as T };
  } catch {
    return { ok: false, error: `API ${res.status}: malformed response body` };
  }
}

/** A token belongs to this surface only if it matches the full primary-owner identity. */
function isPrimaryOwner(t: Pick<PublicTokenRow, "principalType" | "principalId">): boolean {
  return (
    t.principalType === PRIMARY_OWNER.principalType && t.principalId === PRIMARY_OWNER.principalId
  );
}

export async function listMyTokensAction(): Promise<
  { ok: true; tokens: PublicTokenRow[] } | { ok: false; error: string }
> {
  const r = await adminFetch<{ tokens?: PublicTokenRow[] }>("/v1/tokens");
  if (!r.ok) return r;
  const tokens = (r.data.tokens ?? []).filter(isPrimaryOwner);
  return { ok: true, tokens };
}

export async function mintTokenAction(input: {
  name: string;
  scopes: string[];
  expiresAt?: string;
}): Promise<{ ok: true; token: MintedTokenRow } | { ok: false; error: string }> {
  const name = input.name.trim();
  if (!name) return { ok: false, error: "Token name is required." };

  const scopes: ApiScope[] = input.scopes.filter(isApiScope);
  if (scopes.length === 0) {
    return { ok: false, error: "At least one scope (read, write, or admin) is required." };
  }

  const body: Record<string, unknown> = {
    name,
    scopes,
    principalType: PRIMARY_OWNER.principalType,
    principalId: PRIMARY_OWNER.principalId,
  };
  if (input.expiresAt) body.expiresAt = input.expiresAt;

  const r = await adminFetch<MintedTokenRow>("/v1/tokens", {
    method: "POST",
    body: JSON.stringify(body),
  });
  if (!r.ok) return r;
  return { ok: true, token: r.data };
}

export async function revokeTokenAction(
  id: string,
): Promise<{ ok: true; token: PublicTokenRow } | { ok: false; error: string }> {
  if (!id) return { ok: false, error: "Token ID is required." };

  // Enforce the owner boundary on the write path too: resolve the token first
  // and only revoke it if it belongs to the primary owner this surface manages,
  // never an arbitrary id.
  const lookup = await adminFetch<PublicTokenRow>(`/v1/tokens/${encodeURIComponent(id)}`);
  if (!lookup.ok) return lookup;
  if (!isPrimaryOwner(lookup.data)) {
    return { ok: false, error: "This token is not managed by this page." };
  }

  const r = await adminFetch<PublicTokenRow>(`/v1/tokens/${encodeURIComponent(id)}/revoke`, {
    method: "POST",
  });
  if (!r.ok) return r;
  return { ok: true, token: r.data };
}
