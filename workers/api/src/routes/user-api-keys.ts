import { Hono, type Context } from "hono";
import { and, eq } from "drizzle-orm";
import { createDb } from "../db.js";
import { apikey } from "../db/schema-auth.js";
import { APIError } from "better-auth/api";
import { createAuth } from "../auth/index.js";
import {
  scopeToPermissions,
  apiScopesFromPermissions,
  isWithinUserKeyCeiling,
  USER_API_KEY_MAX_SCOPE,
} from "../auth/api-key-scope.js";
import {
  USER_API_KEY_MAX_ACTIVE,
  API_KEY_LIMIT_CODE,
  API_KEY_LIMIT_MESSAGE,
  countActiveUserKeys,
} from "../auth/api-key-limit.js";
import { makeAuthAudit } from "../auth/audit.js";
import { type ApiScope } from "@buildinternet/releases-core/api-token";
import type { UserApiKey } from "@buildinternet/releases-api-types";
import { requireSession } from "../middleware/auth.js";
import type { Env } from "../index.js";
import { respondError } from "../lib/error-response.js";
import {
  UnauthorizedError,
  ValidationError,
  ConflictError,
  NotFoundError,
} from "@releases/lib/releases-error";

/** Parse a JSON body, or null if it isn't valid JSON. */
export async function parseJsonBody(c: Context<Env>): Promise<Record<string, unknown> | null> {
  try {
    return (await c.req.json()) as Record<string, unknown>;
  } catch {
    return null;
  }
}

/** Parse a stored permissions JSON string into a permission map (null on failure). */
export function parsePermissions(raw: string | null): Record<string, string[]> | null {
  if (!raw) return null;
  try {
    return JSON.parse(raw) as Record<string, string[]>;
  } catch {
    return null;
  }
}

/** Top ladder label from a permissions map (cumulative actions on `api`). */
export function scopeLabel(permissions: Record<string, string[]> | null): ApiScope | null {
  const scopes = apiScopesFromPermissions(permissions);
  if (scopes.includes("admin")) return "admin";
  if (scopes.includes("write")) return "write";
  if (scopes.includes("read")) return "read";
  return null;
}

/**
 * Self-serve user API key handlers — defined WITHOUT auth so unit tests can mount
 * them behind an injected session. Production composes them under `requireSession`
 * via `userApiKeyRoutes` below. Owner is always `session.user.id`.
 */
export const userApiKeyHandlers = new Hono<Env>();

userApiKeyHandlers.post("/api-keys", async (c) => {
  const session = c.get("session");
  if (!session) return respondError(c, new UnauthorizedError("Sign in required"));

  const body = await parseJsonBody(c);
  if (!body)
    return respondError(c, new ValidationError("Invalid JSON body", { code: "invalid_json" }));

  const name = typeof body.name === "string" ? body.name.trim() : "";
  if (!name)
    return respondError(c, new ValidationError("name is required", { code: "bad_request" }));

  // The server-side scope ceiling: self-serve keys are capped at
  // USER_API_KEY_MAX_SCOPE (read today). A missing scope defaults to the
  // ceiling; anything above it is refused rather than silently downgraded so a
  // caller asking for write gets an explicit error. Ceiling-aware, matching the
  // auth-time clamp, so this stays correct if the ceiling is ever raised.
  const requestedScope = body.scope === undefined ? USER_API_KEY_MAX_SCOPE : body.scope;
  if (!isWithinUserKeyCeiling(requestedScope)) {
    return respondError(
      c,
      new ValidationError(`scope must be '${USER_API_KEY_MAX_SCOPE}'`, { code: "bad_request" }),
    );
  }

  let expiresIn: number | undefined;
  if (body.expiresInDays !== undefined) {
    const d = body.expiresInDays;
    if (typeof d !== "number" || !Number.isInteger(d) || d < 1 || d > 365) {
      return respondError(
        c,
        new ValidationError("expiresInDays must be an integer between 1 and 365", {
          code: "bad_request",
        }),
      );
    }
    expiresIn = d * 24 * 60 * 60;
  }

  // Enforce the per-user active-key cap up front so the happy path returns a
  // clean 409 instead of catching the create-hook's throw. The Better Auth
  // `/api-key/create` before-hook re-checks this as the authoritative backstop
  // (it also covers the native endpoint and a concurrent create-create race), so
  // this is the friendly pre-check, not the only gate.
  const activeCount = await countActiveUserKeys(createDb(c.env.DB), session.user.id);
  if (activeCount >= USER_API_KEY_MAX_ACTIVE) {
    return respondError(c, new ConflictError(API_KEY_LIMIT_MESSAGE, { code: "api_key_limit" }));
  }

  const auth = await createAuth(c.env);
  // apiKey() is flag-gated, so betterAuth's inferred api type omits createApiKey;
  // assert its shape with a precise (non-any) structural cast.
  const api = auth.api as typeof auth.api & {
    createApiKey: (a: {
      body: {
        name: string;
        userId: string;
        permissions: Record<string, string[]>;
        metadata?: Record<string, unknown>;
        expiresIn?: number;
      };
    }) => Promise<{
      id: string;
      key: string;
      name: string | null;
      start: string | null;
      remaining: number | null;
      // Better Auth may return these as Date, epoch ms, or ISO string depending
      // on version — coerce via `new Date(...)` below rather than assuming Date.
      expiresAt: Date | number | string | null;
      createdAt: Date | number | string;
    }>;
  };

  // `requestedScope` is validated to be within the user-key ceiling, which is
  // exactly the ladder label scopeLabel(scopeToPermissions(scope)) round-trips.
  // The create's audit (`api-key-created`, with the owning userId) is emitted by
  // the `/api-key/create` after-hook in auth/index.ts — one chokepoint for both
  // this route and the native endpoint — so it isn't logged again here.
  let created;
  try {
    created = await api.createApiKey({
      body: {
        name,
        userId: session.user.id,
        permissions: scopeToPermissions(requestedScope),
        metadata: { plan: "default" },
        ...(expiresIn ? { expiresIn } : {}),
      },
    });
  } catch (err) {
    // The before-hook cap backstop throws this when a concurrent create slipped
    // past the pre-check above — surface the same clean 409, not a 500.
    if (err instanceof APIError && err.body?.code === API_KEY_LIMIT_CODE) {
      return respondError(c, new ConflictError(API_KEY_LIMIT_MESSAGE, { code: "api_key_limit" }));
    }
    throw err;
  }

  // The full key is returned exactly once and is never retrievable again.
  return c.json(
    {
      key: created.key,
      id: created.id,
      name: created.name,
      start: created.start,
      scope: requestedScope,
      remaining: created.remaining,
      expiresAt: created.expiresAt ? new Date(created.expiresAt).toISOString() : null,
      createdAt: new Date(created.createdAt).toISOString(),
    },
    201,
  );
});

/** List the caller's self-serve API keys (shared by GET /api-keys and settings bootstrap). */
export async function listUserApiKeys(
  db: ReturnType<typeof createDb>,
  userId: string,
): Promise<UserApiKey[]> {
  const rows = await db.select().from(apikey).where(eq(apikey.referenceId, userId)).all();
  return rows.map((r) => ({
    id: r.id,
    name: r.name,
    start: r.start,
    scope: scopeLabel(parsePermissions(r.permissions)),
    enabled: r.enabled,
    remaining: r.remaining,
    lastRequest: r.lastRequest ? r.lastRequest.toISOString() : null,
    createdAt: r.createdAt.toISOString(),
    expiresAt: r.expiresAt ? r.expiresAt.toISOString() : null,
  }));
}

userApiKeyHandlers.get("/api-keys", async (c) => {
  const session = c.get("session");
  if (!session) return respondError(c, new UnauthorizedError("Sign in required"));
  const db = createDb(c.env.DB);
  return c.json({ apiKeys: await listUserApiKeys(db, session.user.id) });
});

userApiKeyHandlers.delete("/api-keys/:id", async (c) => {
  const session = c.get("session");
  if (!session) return respondError(c, new UnauthorizedError("Sign in required"));
  const id = c.req.param("id");
  const db = createDb(c.env.DB);
  // The referenceId clause IS the ownership check — a non-owned/absent id deletes
  // zero rows and returns one indistinct 404 (no cross-user existence oracle).
  const deleted = await db
    .delete(apikey)
    .where(and(eq(apikey.id, id), eq(apikey.referenceId, session.user.id)))
    .returning();
  if (deleted.length === 0) return respondError(c, new NotFoundError("API key not found"));
  // Revoke audit on the shared `component: "auth"` stream, with the owning
  // userId — same event the native-delete after-hook emits (this route deletes
  // via Drizzle, not auth.api.deleteApiKey, so it audits its own path).
  makeAuthAudit(c.env)("info", {
    event: "api-key-revoked",
    userId: session.user.id,
    keyId: id,
  });
  return c.json({ success: true });
});

/** Production composition: requireSession then the handlers. */
export const userApiKeyRoutes = new Hono<Env>();
userApiKeyRoutes.use("/api-keys", requireSession);
userApiKeyRoutes.use("/api-keys/*", requireSession);
userApiKeyRoutes.route("/", userApiKeyHandlers);
