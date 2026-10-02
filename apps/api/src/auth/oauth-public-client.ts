/**
 * Operator-verified ("official") OAuth clients on the consent page.
 *
 * Self-registered DCR and CIMD clients pick their own `client_name`,
 * `logo_uri`, and `client_uri`, so none of those say who the client really
 * is: a client can register as "Claude" with `client_uri: https://claude.ai`
 * and a redirect to its own server. The only identity signal a client cannot
 * set for itself is the operator's `metadata.official` flag, written by the
 * root-key-gated `admin/oauth` routes (and stripped from DCR bodies by
 * oauth-dcr.ts).
 *
 * An after-hook on the plugin's `/oauth2/public-client` (and `-prelogin`)
 * endpoints adds `official: boolean` so the web consent page can show a
 * verified badge or an unverified-client warning.
 */

import { eq } from "drizzle-orm";
import { oauthClient } from "../db/schema-auth.js";
import { logEvent } from "@releases/lib/log-event";
import type { AnyDb } from "../db.js";

export const OFFICIAL_METADATA_KEY = "official";

export const PUBLIC_CLIENT_PATHS: ReadonlySet<string> = new Set([
  "/oauth2/public-client",
  "/oauth2/public-client-prelogin",
]);

/**
 * `oauth_client.metadata` as an object. Drizzle reads (jsonCol) return the
 * parsed value; the Better Auth adapter may hand back the JSON string. Peels
 * up to two levels, like jsonCol, for legacy double-encoded rows.
 */
export function parseMetadata(metadata: unknown): Record<string, unknown> | null {
  let value = metadata;
  for (let i = 0; i < 2 && typeof value === "string"; i++) {
    try {
      value = JSON.parse(value);
    } catch {
      return null;
    }
  }
  return value != null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

/** True only when an operator set `metadata.official === true` on the row. */
export function isOfficialClientRow(row: { metadata?: unknown }): boolean {
  return parseMetadata(row.metadata)?.[OFFICIAL_METADATA_KEY] === true;
}

/** Return `metadata` with the official flag set or cleared (other keys kept). */
export function withOfficialFlag(
  metadata: unknown,
  official: boolean,
): Record<string, unknown> | null {
  const base = { ...parseMetadata(metadata) };
  if (official) base[OFFICIAL_METADATA_KEY] = true;
  else delete base[OFFICIAL_METADATA_KEY];
  return Object.keys(base).length > 0 ? base : null;
}

/**
 * Mutate a successful public-client result in place, setting
 * `official: boolean`. Leaves errors and non-objects alone. Fails closed: a
 * lookup error leaves `official: false`.
 */
export async function annotatePublicClientOfficial(db: AnyDb, returned: unknown): Promise<void> {
  if (returned == null || typeof returned !== "object") return;
  if (returned instanceof Error || returned instanceof Response) return;
  const record = returned as Record<string, unknown>;
  const clientId = record.client_id;
  if (typeof clientId !== "string" || clientId.length === 0) return;
  record.official = false;
  try {
    const [row] = await db
      .select({ metadata: oauthClient.metadata })
      .from(oauthClient)
      .where(eq(oauthClient.clientId, clientId))
      .limit(1);
    record.official = row ? isOfficialClientRow(row) : false;
  } catch (err) {
    logEvent("warn", {
      component: "auth",
      event: "oauth-public-client-official-lookup-failed",
      clientId,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}
