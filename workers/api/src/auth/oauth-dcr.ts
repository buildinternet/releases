/**
 * Unauthenticated RFC 7591 Dynamic Client Registration (DCR) policy.
 *
 * Open DCR stays on so MCP Inspector / Claude / Cursor / opencode can
 * self-register a public PKCE client. That path must never mint a privileged
 * or confidential client: discovery still advertises the full AS scope list
 * (including `write` / `admin`) for first-party use, but a DCR row's stored
 * capability ceiling is {@link DCR_SCOPES} and the client is forced public.
 *
 * Applied in two places:
 *  - `hooks.before` on `/oauth2/register` ({@link sanitizeDcrRegistrationBody})
 *    so the plugin never sees privileged metadata;
 *  - after a successful register ({@link clampDcrClientRow}) so a plugin
 *    default or ignored field cannot persist `admin`, a secret, or skip_consent.
 *
 * Admin-provisioned clients (`POST /v1/admin/oauth/clients`) do not go through
 * this path and may still hold `write` / `admin` and a `reloc_` secret.
 */

import { DCR_SCOPES } from "./entitlement.js";

/** Privileged / first-party metadata a DCR body must never carry. */
const STRIP_REGISTRATION_FIELDS = [
  "skip_consent",
  "trusted",
  "require_pkce",
  "client_credentials_scopes",
  "client_secret",
  "jwks",
  "jwks_uri",
] as const;

const DCR_SCOPE_SET: ReadonlySet<string> = new Set(DCR_SCOPES);

/** Grants an open-DCR client may advertise. No `client_credentials` (M2M). */
export const DCR_GRANT_TYPES = ["authorization_code", "refresh_token"] as const;

const DCR_GRANT_SET: ReadonlySet<string> = new Set(DCR_GRANT_TYPES);

function scopesEqual(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((scope, i) => scope === b[i]);
}

/**
 * Parse a DCR `scope` (RFC 7591 space-delimited string) or `scope` array.
 * Unknown / privileged ids are dropped. Empty or malformed → the full
 * {@link DCR_SCOPES} default (never inherit `scopes_supported`).
 */
export function capDcrScopes(requested: unknown): string[] {
  let tokens: string[] = [];
  if (typeof requested === "string") {
    tokens = requested.split(/\s+/).filter(Boolean);
  } else if (Array.isArray(requested)) {
    tokens = requested.filter((s): s is string => typeof s === "string" && s.length > 0);
  }
  const permitted = tokens.filter((id) => DCR_SCOPE_SET.has(id));
  return permitted.length > 0 ? [...new Set(permitted)] : [...DCR_SCOPES];
}

function capDcrGrantTypes(grantTypes: unknown): string[] | undefined {
  if (!Array.isArray(grantTypes)) return undefined;
  const next: string[] = [];
  const seen = new Set<string>();
  for (const grant of grantTypes) {
    if (typeof grant !== "string" || !DCR_GRANT_SET.has(grant) || seen.has(grant)) continue;
    seen.add(grant);
    next.push(grant);
  }
  if (!next.includes("authorization_code")) return undefined;
  return next;
}

function grantTypesUnchanged(advertised: unknown, next: string[]): boolean {
  return (
    Array.isArray(advertised) &&
    advertised.length === next.length &&
    advertised.every((grant, i) => grant === next[i])
  );
}

/**
 * Force a DCR body onto the public-PKCE + {@link DCR_SCOPES} policy.
 * `undefined` means the document already matches and can be left as posted.
 */
export function sanitizeDcrRegistrationBody(
  body: Record<string, unknown>,
): Record<string, unknown> | undefined {
  let next: Record<string, unknown> = body;
  let changed = false;

  if (body.token_endpoint_auth_method !== "none") {
    next = { ...next, token_endpoint_auth_method: "none" };
    changed = true;
  }

  for (const field of STRIP_REGISTRATION_FIELDS) {
    if (field in next) {
      if (next === body) next = { ...next };
      delete next[field];
      changed = true;
    }
  }

  const nextGrants = capDcrGrantTypes(next.grant_types);
  if (nextGrants && !grantTypesUnchanged(next.grant_types, nextGrants)) {
    next = { ...next, grant_types: nextGrants };
    changed = true;
  }

  if (next.scope !== undefined) {
    const capped = capDcrScopes(next.scope);
    const current =
      typeof next.scope === "string"
        ? next.scope.split(/\s+/).filter(Boolean)
        : Array.isArray(next.scope)
          ? next.scope.filter((s): s is string => typeof s === "string")
          : [];
    if (!scopesEqual(current, capped)) {
      next = { ...next, scope: capped.join(" ") };
      changed = true;
    }
  }

  return changed ? next : undefined;
}

/** Persistable client-row fields the after-register clamp writes. */
export type DcrClientRowPatch = {
  scopes: string[];
  skipConsent: false;
  tokenEndpointAuthMethod: "none";
  public: true;
  requirePKCE: true;
  clientCredentialsScopes: null;
};

/**
 * Patch applied to a just-registered DCR row. Privileged scopes are dropped
 * (empty → {@link DCR_SCOPES}); first-party flags and M2M ceilings are cleared.
 */
export function dcrClientRowPatch(scopes: unknown): DcrClientRowPatch {
  return {
    scopes: capDcrScopes(scopes),
    skipConsent: false,
    tokenEndpointAuthMethod: "none",
    public: true,
    requirePKCE: true,
    clientCredentialsScopes: null,
  };
}

/** True when a registration JSON body still carries a privileged scope. */
export function registrationScopesIncludePrivileged(scopes: unknown): boolean {
  const list = Array.isArray(scopes)
    ? scopes
    : typeof scopes === "string"
      ? scopes.split(/\s+/).filter(Boolean)
      : [];
  return list.some((s) => s === "admin" || s === "write");
}

/**
 * Mutate a successful `/oauth2/register` JSON result so the 201 body cannot
 * leak a `client_secret` or privileged `scope`. Returns the `client_id` so
 * the caller can persist {@link dcrClientRowPatch} on the matching row.
 * Leaves `APIError` / `Response` / non-objects alone (`undefined`).
 */
export function clampDcrRegistrationResult(returned: unknown): string | undefined {
  if (returned == null || typeof returned !== "object") return undefined;
  // APIError extends Error; a raw Response is not client metadata.
  if (returned instanceof Error || returned instanceof Response) return undefined;
  const record = returned as Record<string, unknown>;
  const clientId = record.client_id;
  if (typeof clientId !== "string" || clientId.length === 0) return undefined;

  const patch = dcrClientRowPatch(record.scope ?? record.scopes);
  record.scope = patch.scopes.join(" ");
  record.token_endpoint_auth_method = "none";
  delete record.client_secret;
  delete record.client_secret_expires_at;
  return clientId;
}
