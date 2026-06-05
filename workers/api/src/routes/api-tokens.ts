import { Hono, type Context } from "hono";
import { eq } from "drizzle-orm";
import { createDb } from "../db.js";
import { apiTokens } from "@buildinternet/releases-core/schema";
import {
  API_SCOPES,
  generateApiToken,
  hashSecret,
  isApiScope,
  isUserApiKeyShaped,
  parseStoredScopes,
  PRINCIPAL_TYPES,
  ROOT_SCOPE,
  USER_API_KEY_PREFIX,
  type PrincipalType,
} from "@buildinternet/releases-core/api-token";
import { apikey } from "../db/schema-auth.js";
import type { TokenIdentity } from "@buildinternet/releases-api-types";
import { newApiTokenId } from "@buildinternet/releases-core/id";
import { logEvent } from "@releases/lib/log-event";
import type { Env } from "../index.js";

export const apiTokenRoutes = new Hono<Env>();

const SCOPES_HINT = `scopes must be a non-empty subset of: ${API_SCOPES.join(", ")}`;

/** Parse a JSON request body, or null if the body isn't valid JSON. */
async function parseJsonBody(c: Context<Env>): Promise<Record<string, unknown> | null> {
  try {
    return (await c.req.json()) as Record<string, unknown>;
  } catch {
    return null;
  }
}

/** Validate a raw `scopes` value → array of known scopes, or null if absent/empty/invalid. */
function validateScopes(raw: unknown): string[] | null {
  if (!Array.isArray(raw) || raw.length === 0) return null;
  return raw.every((s): s is string => typeof s === "string" && isApiScope(s))
    ? (raw as string[])
    : null;
}

/** Public projection — never exposes token_hash or the secret. */
function toPublicRow(row: typeof apiTokens.$inferSelect) {
  return {
    id: row.id,
    lookupId: row.lookupId,
    name: row.name,
    scopes: parseStoredScopes(row.scopes),
    principalType: row.principalType,
    principalId: row.principalId,
    active: row.active,
    revokedAt: row.revokedAt,
    expiresAt: row.expiresAt,
    lastUsedAt: row.lastUsedAt,
    createdAt: row.createdAt,
    createdBy: row.createdBy,
  };
}

apiTokenRoutes.post("/tokens", async (c) => {
  const body = await parseJsonBody(c);
  if (!body) return c.json({ error: "bad_request", message: "Invalid JSON body" }, 400);

  const name = typeof body.name === "string" ? body.name.trim() : "";
  if (!name) return c.json({ error: "bad_request", message: "name is required" }, 400);

  const scopes = validateScopes(body.scopes);
  if (!scopes) return c.json({ error: "bad_request", message: SCOPES_HINT }, 400);

  const principalType = typeof body.principalType === "string" ? body.principalType : "internal";
  if (!(PRINCIPAL_TYPES as readonly string[]).includes(principalType)) {
    return c.json({ error: "bad_request", message: "invalid principalType" }, 400);
  }
  const principalId = typeof body.principalId === "string" ? body.principalId : null;

  const expiresAt = typeof body.expiresAt === "string" ? body.expiresAt : null;
  if (expiresAt && Number.isNaN(Date.parse(expiresAt))) {
    return c.json({ error: "bad_request", message: "expiresAt must be ISO-8601" }, 400);
  }

  const { token, lookupId, secret } = generateApiToken();
  const tokenHash = await hashSecret(secret);
  const auth = c.get("auth");
  const createdBy = auth?.kind === "token" ? auth.tokenId : "static-key";

  const db = createDb(c.env.DB);
  const [row] = await db
    .insert(apiTokens)
    .values({
      id: newApiTokenId(),
      lookupId,
      tokenHash,
      name,
      scopes: JSON.stringify(scopes),
      principalType: principalType as PrincipalType,
      principalId,
      expiresAt,
      createdBy,
    })
    .returning();

  logEvent("info", {
    component: "api-tokens",
    event: "minted",
    tokenId: row!.id,
    scopes,
    principalType,
  });

  // The full token is returned exactly once and is never retrievable again.
  return c.json({ token, ...toPublicRow(row!) }, 201);
});

apiTokenRoutes.get("/tokens", async (c) => {
  const db = createDb(c.env.DB);
  const rows = await db.select().from(apiTokens).all();
  return c.json({ tokens: rows.map(toPublicRow) });
});

apiTokenRoutes.get("/tokens/me", async (c) => {
  const auth = c.get("auth");
  // Local dev: no RELEASES_API_KEY secret bound → the auth middleware skips and
  // attaches no identity. Treat as the implicit local root so login works
  // against a local worker.
  if (!auth) {
    return c.json({
      kind: "root",
      name: "local-dev",
      scopes: [ROOT_SCOPE],
      principalType: "internal",
      principalId: null,
      expiresAt: null,
      lastUsedAt: null,
    } satisfies TokenIdentity);
  }
  if (auth.kind === "root") {
    return c.json({
      kind: "root",
      name: "root",
      scopes: auth.scopes,
      principalType: "internal",
      principalId: null,
      expiresAt: null,
      lastUsedAt: null,
    } satisfies TokenIdentity);
  }
  // User API keys (relu_) live in Better Auth's `apikey` table. The middleware
  // already verified + metered the key; enrich with the row's name + owning
  // userId. Timestamps are Date columns → ISO. A missing row (revoked between
  // verify and this read) falls back to the minimal identity rather than 500ing.
  if (auth.kind === "token" && isUserApiKeyShaped(auth.tokenId)) {
    const keyId = auth.tokenId.slice(USER_API_KEY_PREFIX.length);
    const db = createDb(c.env.DB);
    const row = await db
      .select({
        name: apikey.name,
        referenceId: apikey.referenceId,
        expiresAt: apikey.expiresAt,
        lastRequest: apikey.lastRequest,
      })
      .from(apikey)
      .where(eq(apikey.id, keyId))
      .get();
    return c.json({
      kind: "token",
      name: row?.name ?? "user-api-key",
      scopes: auth.scopes,
      principalType: "user",
      principalId: row?.referenceId ?? null,
      expiresAt: row?.expiresAt ? row.expiresAt.toISOString() : null,
      lastUsedAt: row?.lastRequest ? row.lastRequest.toISOString() : null,
    } satisfies TokenIdentity);
  }
  const db = createDb(c.env.DB);
  const row = await db.select().from(apiTokens).where(eq(apiTokens.id, auth.tokenId)).get();
  // Auth resolved a token id but its row is gone (revoked/deleted mid-request).
  // A credential was presented, so this is "invalid", never "missing".
  if (!row) return c.json({ error: "unauthorized", message: "Invalid API key" }, 401);
  return c.json({
    kind: "token",
    name: row.name,
    scopes: parseStoredScopes(row.scopes),
    principalType: row.principalType,
    principalId: row.principalId,
    expiresAt: row.expiresAt,
    lastUsedAt: row.lastUsedAt,
  } satisfies TokenIdentity);
});

apiTokenRoutes.get("/tokens/:id", async (c) => {
  const db = createDb(c.env.DB);
  const row = await db
    .select()
    .from(apiTokens)
    .where(eq(apiTokens.id, c.req.param("id")))
    .get();
  if (!row) return c.json({ error: "not_found", message: "token not found" }, 404);
  return c.json(toPublicRow(row));
});

apiTokenRoutes.patch("/tokens/:id", async (c) => {
  const db = createDb(c.env.DB);
  const id = c.req.param("id");
  const existing = await db.select().from(apiTokens).where(eq(apiTokens.id, id)).get();
  if (!existing) return c.json({ error: "not_found", message: "token not found" }, 404);

  const body = await parseJsonBody(c);
  if (!body) return c.json({ error: "bad_request", message: "Invalid JSON body" }, 400);

  const patch: Partial<typeof apiTokens.$inferInsert> = {};
  if (typeof body.name === "string") {
    if (!body.name.trim())
      return c.json({ error: "bad_request", message: "name cannot be empty" }, 400);
    patch.name = body.name.trim();
  }
  if (body.scopes !== undefined) {
    const scopes = validateScopes(body.scopes);
    if (!scopes) return c.json({ error: "bad_request", message: SCOPES_HINT }, 400);
    patch.scopes = JSON.stringify(scopes);
  }
  if (body.expiresAt === null) {
    patch.expiresAt = null;
  } else if (typeof body.expiresAt === "string") {
    if (Number.isNaN(Date.parse(body.expiresAt))) {
      return c.json({ error: "bad_request", message: "expiresAt must be ISO-8601" }, 400);
    }
    patch.expiresAt = body.expiresAt;
  }
  if (Object.keys(patch).length === 0) {
    return c.json({ error: "bad_request", message: "no editable fields provided" }, 400);
  }

  const [updated] = await db.update(apiTokens).set(patch).where(eq(apiTokens.id, id)).returning();
  if (!updated) return c.json({ error: "not_found", message: "token not found" }, 404);
  return c.json(toPublicRow(updated));
});

apiTokenRoutes.post("/tokens/:id/revoke", async (c) => {
  const db = createDb(c.env.DB);
  const id = c.req.param("id");
  const [updated] = await db
    .update(apiTokens)
    .set({ active: false, revokedAt: new Date().toISOString() })
    .where(eq(apiTokens.id, id))
    .returning();
  if (!updated) return c.json({ error: "not_found", message: "token not found" }, 404);
  logEvent("info", { component: "api-tokens", event: "revoked", tokenId: id });
  return c.json(toPublicRow(updated));
});
