/**
 * Combined `hooks.before` rewrite for generic MCP client OAuth:
 * DCR extra `grant_types`, kitchen-sink authorize/consent `scope=`.
 *
 * Authorization-code blob rewrite lives on `databaseHooks.verification.create`
 * (the value is not on the token-endpoint body). See auth/index.ts.
 */

import { rewriteClientMetadataGrantTypes } from "./oauth-grant-types.js";
import {
  oauthClientIdFromConsentBody,
  oauthClientIdFromQuery,
  restrictOAuthConsentBody,
  restrictOAuthQueryScopes,
} from "./oauth-grant-scopes.js";

export type AuthBeforeCtx = {
  path: string;
  query?: Record<string, unknown>;
  body?: unknown;
};

export async function applyOAuthClientInterop(
  ctx: AuthBeforeCtx,
  registeredScopesForClientId: (clientId: string | undefined) => Promise<readonly string[]>,
  role?: string | null,
): Promise<{
  context: { body?: Record<string, unknown>; query?: Record<string, unknown> };
} | void> {
  if (ctx.path === "/oauth2/register") {
    const body = ctx.body as Record<string, unknown> | null;
    const next = body ? rewriteClientMetadataGrantTypes(body) : undefined;
    if (next) return { context: { body: next } };
    return;
  }
  if (ctx.path === "/oauth2/authorize") {
    const query = ctx.query;
    const allowedScopes = await registeredScopesForClientId(oauthClientIdFromQuery(query));
    // Authorize runs before login: do not pass a role. Admin stays requestable
    // so a later admin login can grant it when the client is registered for it.
    const nextQuery = restrictOAuthQueryScopes(query, allowedScopes);
    if (nextQuery) return { context: { query: nextQuery } };
    return;
  }
  if (ctx.path === "/oauth2/consent") {
    const body = ctx.body as Record<string, unknown> | undefined;
    const allowedScopes = await registeredScopesForClientId(oauthClientIdFromConsentBody(body));
    const nextBody = restrictOAuthConsentBody(body, allowedScopes, role);
    if (nextBody) return { context: { body: nextBody } };
  }
}
