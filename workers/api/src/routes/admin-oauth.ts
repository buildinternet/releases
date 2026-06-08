/**
 * Admin-only OAuth client provisioning (#1482). Root-key gated via the
 * `admin/oauth` entry in route-namespaces.ts (authMiddleware). Mirrors
 * admin-users.ts: fail-closed input parsing + audited logEvents. All
 * oauth_client access goes through the Better Auth context adapter so JSON
 * encoding matches the plugin's read path; secret hashing lives in the
 * service layer. This is a sanctioned exception to the "no new /v1/admin/*
 * CRUD" rule (see docs/architecture/remote-mode.md).
 */
import { Hono } from "hono";
import type { Context } from "hono";
import { SafeUrlSchema } from "@better-auth/core/utils/redirect-uri";
import { logEvent } from "@releases/lib/log-event";
import { getOrCreateAuth } from "../middleware/auth.js";
import {
  createOAuthClient,
  listOAuthClients,
  getOAuthClient,
  updateClientFlags,
  rotateClientSecret,
  deleteOAuthClient,
  type CreateClientInput,
  type OAuthClientAdapter,
} from "../auth/oauth-clients.js";
import type { Env } from "../index.js";

export const adminOauthRoutes = new Hono<Env>();

async function getAdapter(c: Context<Env>): Promise<OAuthClientAdapter> {
  const auth = await getOrCreateAuth(c);
  return (await auth.$context).adapter as unknown as OAuthClientAdapter;
}

function asStringArray(v: unknown): string[] | null {
  if (!Array.isArray(v) || v.length === 0) return null;
  if (!v.every((x) => typeof x === "string" && x.length > 0)) return null;
  return v as string[];
}

adminOauthRoutes.post("/admin/oauth/clients", async (c) => {
  let raw: unknown;
  try {
    raw = await c.req.json();
  } catch {
    return c.json({ error: "invalid_json" }, 400);
  }
  if (typeof raw !== "object" || raw === null) return c.json({ error: "invalid_json" }, 400);
  const b = raw as Record<string, unknown>;

  const redirectUris = asStringArray(b.redirectUris);
  if (!redirectUris) return c.json({ error: "redirectUris must be a non-empty string array" }, 400);
  const scopes = asStringArray(b.scopes);
  if (!scopes) return c.json({ error: "scopes must be a non-empty string array" }, 400);

  for (const uri of redirectUris) {
    if (!SafeUrlSchema.safeParse(uri).success) {
      return c.json({ error: "invalid_redirect_uri", uri }, 400);
    }
  }

  // Reject invalid optional enums/arrays outright rather than silently coercing
  // them to a default — a typo'd auth method or grant type should surface, not
  // be quietly swapped for client_secret_basic.
  const AUTH_METHODS = ["none", "client_secret_basic", "client_secret_post"];
  const CLIENT_TYPES = ["web", "native", "user-agent-based"];
  const GRANT_TYPES = ["authorization_code", "client_credentials", "refresh_token"];

  if (
    b.tokenEndpointAuthMethod !== undefined &&
    !AUTH_METHODS.includes(b.tokenEndpointAuthMethod as string)
  ) {
    return c.json({ error: "invalid_tokenEndpointAuthMethod", allowed: AUTH_METHODS }, 400);
  }
  if (b.type !== undefined && !CLIENT_TYPES.includes(b.type as string)) {
    return c.json({ error: "invalid_type", allowed: CLIENT_TYPES }, 400);
  }
  let grantTypes: string[] | undefined;
  if (b.grantTypes !== undefined) {
    const g = asStringArray(b.grantTypes);
    if (!g || !g.every((x) => GRANT_TYPES.includes(x))) {
      return c.json({ error: "invalid_grantTypes", allowed: GRANT_TYPES }, 400);
    }
    grantTypes = g;
  }

  const input: CreateClientInput = {
    name: typeof b.name === "string" && b.name.length > 0 ? b.name : undefined,
    redirectUris,
    scopes,
    trusted: b.trusted === true,
    tokenEndpointAuthMethod:
      b.tokenEndpointAuthMethod as CreateClientInput["tokenEndpointAuthMethod"],
    type: b.type as CreateClientInput["type"],
    grantTypes,
    requirePKCE: typeof b.requirePKCE === "boolean" ? b.requirePKCE : undefined,
    clientUri: typeof b.clientUri === "string" ? b.clientUri : undefined,
    logoUri: typeof b.logoUri === "string" ? b.logoUri : undefined,
  };

  const adapter = await getAdapter(c);
  const { client, secret } = await createOAuthClient(adapter, input);

  logEvent("info", {
    component: "auth",
    event: "oauth-client-created",
    clientId: client.clientId,
    trusted: client.trusted,
    public: client.public,
    actor: "root-key",
  });

  return c.json({ ...client, clientSecret: secret ?? null }, 201);
});

adminOauthRoutes.get("/admin/oauth/clients", async (c) => {
  const adapter = await getAdapter(c);
  return c.json({ clients: await listOAuthClients(adapter) });
});

adminOauthRoutes.get("/admin/oauth/clients/:clientId", async (c) => {
  const adapter = await getAdapter(c);
  const client = await getOAuthClient(adapter, c.req.param("clientId"));
  if (!client) return c.json({ error: "client_not_found" }, 404);
  return c.json(client);
});

adminOauthRoutes.patch("/admin/oauth/clients/:clientId", async (c) => {
  const clientId = c.req.param("clientId");
  let raw: unknown;
  try {
    raw = await c.req.json();
  } catch {
    return c.json({ error: "invalid_json" }, 400);
  }
  if (typeof raw !== "object" || raw === null) return c.json({ error: "invalid_json" }, 400);
  const b = raw as Record<string, unknown>;
  if (typeof b.disabled !== "boolean" && typeof b.trusted !== "boolean") {
    return c.json({ error: "nothing to update: provide disabled and/or trusted (boolean)" }, 400);
  }

  const disabled = typeof b.disabled === "boolean" ? b.disabled : undefined;
  const trusted = typeof b.trusted === "boolean" ? b.trusted : undefined;

  const adapter = await getAdapter(c);
  const updated = await updateClientFlags(adapter, clientId, { disabled, trusted });
  if (!updated) return c.json({ error: "client_not_found" }, 404);

  logEvent("info", {
    component: "auth",
    event: "oauth-client-updated",
    clientId,
    disabled,
    trusted,
    actor: "root-key",
  });

  return c.json(updated);
});

adminOauthRoutes.post("/admin/oauth/clients/:clientId/rotate-secret", async (c) => {
  const clientId = c.req.param("clientId");
  const adapter = await getAdapter(c);
  const res = await rotateClientSecret(adapter, clientId);
  if (res.status === "not_found") return c.json({ error: "client_not_found" }, 404);
  if (res.status === "public_no_secret") return c.json({ error: "public_client_no_secret" }, 400);

  logEvent("warn", {
    component: "auth",
    event: "oauth-client-secret-rotated",
    clientId,
    actor: "root-key",
  });

  return c.json({ clientId, clientSecret: res.secret });
});

adminOauthRoutes.delete("/admin/oauth/clients/:clientId", async (c) => {
  const clientId = c.req.param("clientId");
  const adapter = await getAdapter(c);
  if (!(await deleteOAuthClient(adapter, clientId)))
    return c.json({ error: "client_not_found" }, 404);

  logEvent("warn", {
    component: "auth",
    event: "oauth-client-deleted",
    clientId,
    actor: "root-key",
  });

  return c.json({ clientId, deleted: true });
});
