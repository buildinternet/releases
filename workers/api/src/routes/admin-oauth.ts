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
import { logEvent } from "@releases/lib/log-event";
import { createAuth } from "../auth/index.js";
import { execWaitUntil } from "../middleware/auth.js";
import {
  createOAuthClient,
  listOAuthClients,
  getOAuthClient,
  setClientDisabled,
  setClientTrusted,
  rotateClientSecret,
  deleteOAuthClient,
  type CreateClientInput,
  type OAuthClientAdapter,
} from "../auth/oauth-clients.js";
import type { Env } from "../index.js";

export const adminOauthRoutes = new Hono<Env>();

async function getAdapter(c: Context<Env>): Promise<OAuthClientAdapter> {
  const auth = c.get("betterAuth") ?? (await createAuth(c.env, execWaitUntil(c)));
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

  const tokenEndpointAuthMethod =
    b.tokenEndpointAuthMethod === "none" ||
    b.tokenEndpointAuthMethod === "client_secret_basic" ||
    b.tokenEndpointAuthMethod === "client_secret_post"
      ? b.tokenEndpointAuthMethod
      : undefined;
  const type =
    b.type === "web" || b.type === "native" || b.type === "user-agent-based" ? b.type : undefined;

  const input: CreateClientInput = {
    name: typeof b.name === "string" && b.name.length > 0 ? b.name : undefined,
    redirectUris,
    scopes,
    trusted: b.trusted === true,
    tokenEndpointAuthMethod,
    type,
    grantTypes: asStringArray(b.grantTypes) ?? undefined,
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

  const adapter = await getAdapter(c);
  let found = true;
  if (typeof b.disabled === "boolean")
    found = await setClientDisabled(adapter, clientId, b.disabled);
  if (found && typeof b.trusted === "boolean")
    found = await setClientTrusted(adapter, clientId, b.trusted);
  if (!found) return c.json({ error: "client_not_found" }, 404);

  logEvent("info", {
    component: "auth",
    event: "oauth-client-updated",
    clientId,
    disabled: typeof b.disabled === "boolean" ? b.disabled : undefined,
    trusted: typeof b.trusted === "boolean" ? b.trusted : undefined,
    actor: "root-key",
  });

  const updated = await getOAuthClient(adapter, clientId);
  if (!updated) return c.json({ error: "client_not_found" }, 404);
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
