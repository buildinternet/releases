/**
 * DCR `application_type` defaulting/coercion for generic MCP clients.
 *
 * Ported from buildinternet/uploads PRs #885–#887, which fixed the same
 * generic-MCP-client OAuth interop for opencode and Cursor:
 *
 * - opencode registers a bare RFC 7591 body: a loopback `http://127.0.0.1:<port>/…`
 *   redirect URI and no `application_type` at all.
 * - Cursor registers an explicit `application_type: "web"` alongside a mixed
 *   redirect-URI set: a private-use-scheme `cursor://anysphere.cursor-mcp/oauth/callback`
 *   plus an `https://…` URI (see
 *   https://forum.cursor.com/t/cursor-does-not-send-application-type-native-when-registering-mcp-oauth-clients/136907).
 *
 * Better Auth 1.7's `@better-auth/oauth-provider` classifies a client without
 * `application_type` as `"web"` (better-auth/better-auth#10913) and rejects
 * loopback-http / private-use-scheme redirect URIs for web clients
 * (better-auth/better-auth#10946) — even though RFC 8252 §7 requires exactly
 * those URI shapes for a native client, and MCP's 2026-07-28 spec update
 * requires native clients to send `application_type: "native"` at
 * registration. Both opencode and Cursor fail `/oauth2/register` on 1.7
 * unless the registration body is corrected before the plugin validates it.
 *
 * This stack pins `@better-auth/oauth-provider@1.6.25`. Its register schema
 * has no `application_type` field at all, so zod strips the key and this
 * rewrite is behaviorally inert today — no client is rejected either way.
 * It exists for two reasons: (a) emit MCP-2026-07-28-spec-correct
 * registration bodies now, and (b) make a future upgrade to Better Auth 1.7
 * not regress opencode/Cursor-shaped clients. Uploads PR #886 also carried a
 * pnpm/bun dist patch for a 1.7-only native-client validator bug; that patch
 * is 1.7-only and has no target here, so it is deliberately not ported.
 *
 * All helpers here are pure: they never mutate the input body, and return
 * `undefined` to mean "no change" so callers can leave the document as
 * posted.
 */

function isString(value: unknown): value is string {
  return typeof value === "string";
}

function parseUri(uri: string): URL | undefined {
  try {
    return new URL(uri);
  } catch {
    return undefined;
  }
}

const LOOPBACK_HOSTNAMES = new Set(["localhost", "127.0.0.1", "[::1]", "::1"]);

/**
 * RFC 8252 §7.3: a native client's redirect URI may use the `http` scheme
 * only when it targets a loopback interface. Fails closed (`false`) on an
 * unparseable URI or a lookalike host such as `127.0.0.1.evil.com`.
 */
export function isLoopbackHttpRedirect(uri: string): boolean {
  const parsed = parseUri(uri);
  if (!parsed || parsed.protocol !== "http:") return false;
  return LOOPBACK_HOSTNAMES.has(parsed.hostname);
}

/**
 * A redirect URI whose scheme is neither `http` nor `https` — e.g.
 * `cursor://anysphere.cursor-mcp/oauth/callback` or `com.example.app:/callback`.
 * Fails closed (`false`) on an unparseable URI.
 */
export function isPrivateUseSchemeRedirect(uri: string): boolean {
  const parsed = parseUri(uri);
  if (!parsed) return false;
  return parsed.protocol !== "http:" && parsed.protocol !== "https:";
}

/**
 * RFC 8252 §7: a redirect URI shape valid for a native client — loopback
 * `http`, a private-use scheme, or `https` on a non-loopback host (a
 * claimed https URI, RFC 8252 §7.2). `https` on a loopback host is not a
 * valid-native shape on its own. Fails closed (`false`) on an unparseable URI.
 */
export function isValidNativeRedirect(uri: string): boolean {
  if (isLoopbackHttpRedirect(uri) || isPrivateUseSchemeRedirect(uri)) return true;
  const parsed = parseUri(uri);
  if (!parsed || parsed.protocol !== "https:") return false;
  return !LOOPBACK_HOSTNAMES.has(parsed.hostname);
}

function redirectUrisFrom(body: Record<string, unknown>): string[] | undefined {
  const uris = body.redirect_uris;
  if (!Array.isArray(uris) || uris.length === 0) return undefined;
  if (!uris.every(isString)) return undefined;
  return uris;
}

/**
 * Default a DCR body to `application_type: "native"` when it omits the
 * field (the opencode shape) and its `redirect_uris` are consistent with a
 * native client: every URI is loopback-http or private-use, or at least one
 * URI is private-use and every URI is a valid-native shape. `undefined`
 * means leave the document as posted.
 */
export function defaultRegistrationApplicationType(
  body: Record<string, unknown>,
): Record<string, unknown> | undefined {
  if (body.application_type !== undefined) return undefined;
  const uris = redirectUrisFrom(body);
  if (!uris) return undefined;

  const allLoopbackOrPrivate = uris.every(
    (uri) => isLoopbackHttpRedirect(uri) || isPrivateUseSchemeRedirect(uri),
  );
  const hasPrivateUse = uris.some(isPrivateUseSchemeRedirect);
  const allValidNative = uris.every(isValidNativeRedirect);

  if (allLoopbackOrPrivate || (hasPrivateUse && allValidNative)) {
    return { ...body, application_type: "native" };
  }
  return undefined;
}

/**
 * Coerce an explicit `application_type: "web"` DCR body to `"native"` when
 * the client mixes in a private-use-scheme redirect URI (the Cursor shape)
 * and every redirect URI is a valid-native shape. Leaves a web client with
 * loopback-http-only or pure-https redirect URIs untouched, and never
 * touches an already-`"native"` (or otherwise non-`"web"`) body. `undefined`
 * means leave the document as posted.
 */
export function coerceExplicitWebToNativeForPrivateUseScheme(
  body: Record<string, unknown>,
): Record<string, unknown> | undefined {
  if (body.application_type !== "web") return undefined;
  const uris = redirectUrisFrom(body);
  if (!uris) return undefined;

  const hasPrivateUse = uris.some(isPrivateUseSchemeRedirect);
  if (!hasPrivateUse) return undefined;
  if (!uris.every(isValidNativeRedirect)) return undefined;

  return { ...body, application_type: "native" };
}
