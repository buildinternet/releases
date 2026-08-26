/**
 * DCR `grant_types` rewrite for generic MCP clients.
 *
 * `@better-auth/oauth-provider` 1.6's `/oauth2/register` schema is a closed
 * enum (`authorization_code` | `refresh_token` | `client_credentials`). CIMD
 * `grant_types` (and leftover DCR bodies) is a capability advertisement, not
 * a demand that we implement every listed grant: MCPJam includes
 * `urn:ietf:params:oauth:grant-type:device_code` and claude.ai includes
 * `urn:ietf:params:oauth:grant-type:jwt-bearer` on a normal
 * authorization_code + PKCE authorize URL. Intersect advertised grants with
 * the grants this AS's token endpoint issues. Leave the document untouched
 * if `authorization_code` would not remain: ingest still rejects a
 * device-code-only client.
 *
 * RFC 8628 is implemented for the seeded `releases-cli` device client
 * (`deviceAuthorization()`), but oauth-provider's DCR ingest validator does
 * not treat that plugin's grant as supported. Do not add `device_code` (or
 * `jwt-bearer`) here without shipping that grant through oauth-provider.
 *
 * This stack is better-auth 1.6: there is no `@better-auth/cimd` plugin, so
 * the rewrite runs only on DCR `POST /oauth2/register` via `hooks.before`.
 */

export const AS_SUPPORTED_GRANT_TYPES = [
  "authorization_code",
  "refresh_token",
  "client_credentials",
] as const;

const AS_SUPPORTED_GRANT_TYPE_SET: ReadonlySet<string> = new Set(AS_SUPPORTED_GRANT_TYPES);

/**
 * Intersect advertised CIMD/DCR `grant_types` with {@link AS_SUPPORTED_GRANT_TYPES}.
 *
 * Returns the supported subset (order preserved, duplicates dropped) when
 * `authorization_code` remains. Returns `undefined` when the value is
 * missing, malformed, or has no usable grant, so the caller leaves the
 * document alone and the plugin still rejects an unsupported-only list.
 */
export function intersectAdvertisedGrantTypes(grantTypes: unknown): string[] | undefined {
  if (!Array.isArray(grantTypes)) return undefined;
  const supported: string[] = [];
  const seen = new Set<string>();
  for (const grant of grantTypes) {
    if (typeof grant !== "string" || !AS_SUPPORTED_GRANT_TYPE_SET.has(grant) || seen.has(grant)) {
      continue;
    }
    seen.add(grant);
    supported.push(grant);
  }
  if (!supported.includes("authorization_code")) return undefined;
  return supported;
}

function grantTypesUnchanged(advertised: unknown, next: string[]): boolean {
  return (
    Array.isArray(advertised) &&
    advertised.length === next.length &&
    advertised.every((grant, i) => grant === next[i])
  );
}

/**
 * Drop unsupported `grant_types` from a parsed DCR body.
 * `undefined` means leave the document as posted.
 */
export function rewriteClientMetadataGrantTypes(
  metadata: Record<string, unknown>,
): Record<string, unknown> | undefined {
  const next = intersectAdvertisedGrantTypes(metadata.grant_types);
  if (next === undefined || grantTypesUnchanged(metadata.grant_types, next)) {
    return undefined;
  }
  return { ...metadata, grant_types: next };
}
