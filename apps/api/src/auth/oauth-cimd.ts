/**
 * Client ID Metadata Document (CIMD) lane for MCP clients (#2409).
 *
 * A CIMD client sends an HTTPS URL as its `client_id`; `@better-auth/cimd`
 * fetches the JSON document at that URL, validates it, and persists an
 * `oauth_client` row keyed by the URL (`client_discovery_id = "cimd"`). Claude's
 * "Use Claude's published identity" connector option uses this lane. DCR
 * (`/oauth2/register`) stays on for clients that don't support CIMD.
 *
 * Policy matches the DCR lane (see oauth-dcr.ts) and is mostly enforced by the
 * plugin itself: stored scopes come from `clientRegistrationDefaultScopes`
 * (= DCR_SCOPES); a document that declares a wider `scope`, carries a
 * server-owned field (`skip_consent`, `require_pkce`, `client_secret`, …), or
 * picks a shared-secret auth method is refused outright; PKCE stays required;
 * and extra advertised `grant_types` (claude.ai lists `jwt-bearer`) are
 * tolerated as long as one is supported.
 * {@link cimdClientRowPatch} re-asserts the ceiling when a row is first
 * created, mirroring `clampRegisteredDcrClient`. Hourly refreshes are left
 * alone: they re-derive scopes and keep operator flags (an admin `trusted`).
 */

import { validateClientIdUrl } from "@better-auth/cimd";
import type { ClientMetadataResourceFetch } from "@better-auth/oauth-provider";
import { capDcrScopes } from "./oauth-dcr.js";

/** Redirect statuses. 304 is excluded: the plugin sends conditional requests. */
const REDIRECT_STATUSES: ReadonlySet<number> = new Set([300, 301, 302, 303, 307, 308]);

/**
 * Metadata-document transport for the Workers runtime.
 *
 * The plugin asks for `redirect: "error"`, which workerd's fetch rejects, so
 * this sends `redirect: "manual"` and throws on any redirect status instead.
 *
 * SSRF: the plugin already rejects non-HTTPS URLs and IP-literal / localhost
 * hosts that aren't public-routable, and caps the body (5 KB) and time (5 s).
 * We re-run its `validateClientIdUrl` host check on every fetch.
 * The remaining gap its Node transport closes — a public hostname whose DNS
 * points at a private address — is closed by the platform here: Cloudflare
 * refuses to connect a Worker subrequest to a private/reserved address, so
 * there is no internal network for a rebinding answer to reach.
 */
export function createWorkersClientMetadataFetch(
  fetchImpl: typeof fetch = fetch,
): ClientMetadataResourceFetch {
  return async (input, init) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    if (url.protocol !== "https:") {
      throw new TypeError("CIMD metadata fetch requires an https URL");
    }
    const method = init?.method ?? "GET";
    if (method !== "GET" && method !== "HEAD") {
      throw new TypeError("CIMD metadata fetch supports only GET and HEAD");
    }
    // The plugin checks the client_id URL before calling us; re-checking here
    // also covers its follow-up fetches (a document's `jwks_uri`).
    const urlError = validateClientIdUrl(url.toString());
    if (urlError) throw new TypeError(`CIMD metadata URL rejected: ${urlError}`);
    const res = await fetchImpl(url.toString(), {
      method,
      headers: init?.headers,
      signal: init?.signal,
      redirect: "manual",
    });
    if (REDIRECT_STATUSES.has(res.status)) {
      await res.body?.cancel();
      throw new TypeError("CIMD metadata fetch must not follow redirects");
    }
    return res;
  };
}

/** Fields the post-persist clamp may write on a CIMD `oauth_client` row. */
export type CimdClientRowPatch = {
  scopes: string[];
  skipConsent: false;
  requirePKCE: true;
  clientCredentialsScopes: null;
};

type CimdClientRow = {
  scopes?: readonly string[] | null;
  skipConsent?: boolean | null;
  requirePKCE?: boolean | null;
  clientCredentialsScopes?: readonly string[] | null;
};

/**
 * The DCR ceiling for a just-created CIMD row, or `undefined` when the row
 * already sits inside it (the common case — skip the write). The token auth
 * method is left alone: the plugin only admits `none` or `private_key_jwt`,
 * and neither carries a shared secret.
 */
export function cimdClientRowPatch(client: CimdClientRow): CimdClientRowPatch | undefined {
  const scopes = capDcrScopes(client.scopes ?? []);
  const current = client.scopes ?? [];
  const scopesMatch =
    current.length === scopes.length && current.every((scope, i) => scope === scopes[i]);
  const inPolicy =
    scopesMatch &&
    client.skipConsent !== true &&
    client.requirePKCE !== false &&
    (client.clientCredentialsScopes ?? []).length === 0;
  if (inPolicy) return undefined;
  return { scopes, skipConsent: false, requirePKCE: true, clientCredentialsScopes: null };
}
