"use server";

import { isApiScope, type ApiScope } from "@buildinternet/releases-core/api-token";
import { adminActionEnv, adminFetch } from "@/lib/admin-action";

/**
 * The fixed "primary owner" principal used for all tokens minted through this
 * admin page. The list view filters to only these tokens — not the full system
 * token table.
 */
const PRIMARY_OWNER = {
  principalType: "user",
  principalId: "usr_web_admin",
} as const;

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

  // Resolve the credential once and thread it through both calls below: in prod
  // each `adminActionEnv()` mints a fresh per-user JWT, so resolving per-call
  // would mint twice for a single revoke.
  const env = await adminActionEnv();
  if ("error" in env) return { ok: false, error: env.error };

  // Enforce the owner boundary on the write path too: resolve the token first
  // and only revoke it if it belongs to the primary owner this surface manages,
  // never an arbitrary id.
  const lookup = await adminFetch<PublicTokenRow>(
    `/v1/tokens/${encodeURIComponent(id)}`,
    undefined,
    env,
  );
  if (!lookup.ok) return lookup;
  if (!isPrimaryOwner(lookup.data)) {
    return { ok: false, error: "This token is not managed by this page." };
  }

  const r = await adminFetch<PublicTokenRow>(
    `/v1/tokens/${encodeURIComponent(id)}/revoke`,
    { method: "POST" },
    env,
  );
  if (!r.ok) return r;
  return { ok: true, token: r.data };
}
