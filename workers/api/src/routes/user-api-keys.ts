import { Hono, type Context } from "hono";
import { and, eq } from "drizzle-orm";
import { createDb } from "../db.js";
import { apikey } from "../db/schema-auth.js";
import { createAuth } from "../auth/index.js";
import { scopeToPermissions, apiScopesFromPermissions } from "../auth/api-key-scope.js";
import { type ApiScope } from "@buildinternet/releases-core/api-token";
import { requireSession } from "../middleware/auth.js";
import { logEvent } from "@releases/lib/log-event";
import type { Env } from "../index.js";

const SELF_SERVE_SCOPES = ["read", "write"] as const;
function isSelfServeScope(s: unknown): s is "read" | "write" {
  return typeof s === "string" && (SELF_SERVE_SCOPES as readonly string[]).includes(s);
}

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

export function execWaitUntil(c: Context<Env>): ((p: Promise<unknown>) => void) | undefined {
  try {
    return c.executionCtx.waitUntil.bind(c.executionCtx);
  } catch {
    return undefined;
  }
}

/**
 * Self-serve user API key handlers — defined WITHOUT auth so unit tests can mount
 * them behind an injected session. Production composes them under `requireSession`
 * via `userApiKeyRoutes` below. Owner is always `session.user.id`.
 */
export const userApiKeyHandlers = new Hono<Env>();

userApiKeyHandlers.post("/api-keys", async (c) => {
  const session = c.get("session");
  if (!session) return c.json({ error: "unauthorized", message: "Sign in required" }, 401);

  const body = await parseJsonBody(c);
  if (!body) return c.json({ error: "bad_request", message: "Invalid JSON body" }, 400);

  const name = typeof body.name === "string" ? body.name.trim() : "";
  if (!name) return c.json({ error: "bad_request", message: "name is required" }, 400);

  // The server-side scope ceiling: self-serve mints read/write only, never admin.
  if (!isSelfServeScope(body.scope)) {
    return c.json({ error: "bad_request", message: "scope must be 'read' or 'write'" }, 400);
  }

  let expiresIn: number | undefined;
  if (body.expiresInDays !== undefined) {
    const d = body.expiresInDays;
    if (typeof d !== "number" || !Number.isInteger(d) || d < 1 || d > 365) {
      return c.json(
        { error: "bad_request", message: "expiresInDays must be an integer between 1 and 365" },
        400,
      );
    }
    expiresIn = d * 24 * 60 * 60;
  }

  const auth = await createAuth(c.env, execWaitUntil(c));
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

  const created = await api.createApiKey({
    body: {
      name,
      userId: session.user.id,
      permissions: scopeToPermissions(body.scope),
      metadata: { plan: "default" },
      ...(expiresIn ? { expiresIn } : {}),
    },
  });

  logEvent("info", {
    component: "user-api-keys",
    event: "created",
    keyId: created.id,
    scope: body.scope,
  });

  // The full key is returned exactly once and is never retrievable again.
  return c.json(
    {
      key: created.key,
      id: created.id,
      name: created.name,
      start: created.start,
      scope: scopeLabel(scopeToPermissions(body.scope)),
      remaining: created.remaining,
      expiresAt: created.expiresAt ? new Date(created.expiresAt).toISOString() : null,
      createdAt: new Date(created.createdAt).toISOString(),
    },
    201,
  );
});

/** Production composition: requireSession then the handlers. */
export const userApiKeyRoutes = new Hono<Env>();
userApiKeyRoutes.use("/api-keys", requireSession);
userApiKeyRoutes.use("/api-keys/*", requireSession);
userApiKeyRoutes.route("/", userApiKeyHandlers);
