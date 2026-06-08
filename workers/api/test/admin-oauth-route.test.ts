import { describe, it, expect } from "bun:test";
import { Hono } from "hono";
import { createTestDb } from "./setup";
import { createAuth } from "../src/auth/index.js";
import { adminOauthRoutes } from "../src/routes/admin-oauth.js";

const baseEnv = {
  BETTER_AUTH_URL: "https://api.releases.localhost",
  BETTER_AUTH_SECRET: "test-secret-do-not-use-in-prod-0123456789",
} as never;

async function makeApp() {
  const auth = await createAuth(baseEnv, undefined, { db: createTestDb(), sendEmail: () => {} });
  // Blank Hono + `(c as any).set` is the repo's known-good route-test pattern
  // (see tests/api/admin-search-queries.test.ts) — avoids strict-Variables
  // friction while still mounting the Hono<Env> route module.
  const app = new Hono();
  app.use("/admin/oauth/*", (c, next) => {
    (c as any).set("betterAuth", auth);
    return next();
  });
  app.route("/", adminOauthRoutes);
  return app;
}

const json = (body: unknown) => ({
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify(body),
});

describe("admin oauth client routes", () => {
  it("POST creates a client and returns the secret once", async () => {
    const app = await makeApp();
    const res = await app.request(
      "/admin/oauth/clients",
      json({ name: "App", redirectUris: ["https://app.example.com/cb"], scopes: ["read"] }),
    );
    expect(res.status).toBe(201);
    const body = (await res.json()) as { clientId: string; clientSecret: string; trusted: boolean };
    expect(body.clientId).toBeTruthy();
    expect(body.clientSecret).toMatch(/^reloc_/);
    expect(body.trusted).toBe(false);
  });

  it("POST --trusted creates a skip_consent client", async () => {
    const app = await makeApp();
    const res = await app.request(
      "/admin/oauth/clients",
      json({ redirectUris: ["https://a/cb"], scopes: ["read", "write"], trusted: true }),
    );
    const body = (await res.json()) as { trusted: boolean };
    expect(body.trusted).toBe(true);
  });

  it("POST rejects a missing redirectUris with 400", async () => {
    const app = await makeApp();
    const res = await app.request("/admin/oauth/clients", json({ scopes: ["read"] }));
    expect(res.status).toBe(400);
  });

  it("POST rejects invalid optional enums/grants with 400 instead of coercing", async () => {
    const app = await makeApp();
    const base = { redirectUris: ["https://a/cb"], scopes: ["read"] };
    const badAuthMethod = await app.request(
      "/admin/oauth/clients",
      json({ ...base, tokenEndpointAuthMethod: "basic" }),
    );
    expect(badAuthMethod.status).toBe(400);
    const badType = await app.request("/admin/oauth/clients", json({ ...base, type: "spa" }));
    expect(badType.status).toBe(400);
    const badGrant = await app.request(
      "/admin/oauth/clients",
      json({ ...base, grantTypes: ["password"] }),
    );
    expect(badGrant.status).toBe(400);
  });

  it("GET list never includes the secret", async () => {
    const app = await makeApp();
    await app.request(
      "/admin/oauth/clients",
      json({ redirectUris: ["https://a/cb"], scopes: ["read"] }),
    );
    const res = await app.request("/admin/oauth/clients");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { clients: Array<Record<string, unknown>> };
    expect(body.clients.length).toBeGreaterThan(0);
    expect(body.clients[0]).not.toHaveProperty("clientSecret");
  });

  it("PATCH disables, rotate returns a new secret, DELETE removes", async () => {
    const app = await makeApp();
    const created = (await (
      await app.request(
        "/admin/oauth/clients",
        json({ redirectUris: ["https://a/cb"], scopes: ["read"] }),
      )
    ).json()) as { clientId: string; clientSecret: string };
    const id = created.clientId;

    const patch = await app.request(`/admin/oauth/clients/${id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ disabled: true }),
    });
    expect(patch.status).toBe(200);
    expect(((await patch.json()) as { disabled: boolean }).disabled).toBe(true);

    const rot = await app.request(`/admin/oauth/clients/${id}/rotate-secret`, { method: "POST" });
    expect(rot.status).toBe(200);
    const rotBody = (await rot.json()) as { clientSecret: string };
    expect(rotBody.clientSecret).toMatch(/^reloc_/);
    expect(rotBody.clientSecret).not.toBe(created.clientSecret);

    const del = await app.request(`/admin/oauth/clients/${id}`, { method: "DELETE" });
    expect(del.status).toBe(200);
    const get = await app.request(`/admin/oauth/clients/${id}`);
    expect(get.status).toBe(404);
  });

  it("rotate on a missing client is 404", async () => {
    const app = await makeApp();
    const res = await app.request("/admin/oauth/clients/missing/rotate-secret", { method: "POST" });
    expect(res.status).toBe(404);
  });

  it("rejects a javascript: redirect_uri with 400", async () => {
    const app = await makeApp();
    const res = await app.request(
      "/admin/oauth/clients",
      json({ redirectUris: ["javascript:alert(1)"], scopes: ["read"] }),
    );
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toBe("invalid_redirect_uri");
  });

  it("rejects a non-loopback http: redirect_uri with 400", async () => {
    const app = await makeApp();
    const res = await app.request(
      "/admin/oauth/clients",
      json({ redirectUris: ["http://evil.example.com/cb"], scopes: ["read"] }),
    );
    expect(res.status).toBe(400);
  });

  it("allows a loopback http: redirect_uri (native/public client)", async () => {
    const app = await makeApp();
    const res = await app.request(
      "/admin/oauth/clients",
      json({
        redirectUris: ["http://127.0.0.1:8976/cb"],
        scopes: ["read"],
        tokenEndpointAuthMethod: "none",
      }),
    );
    expect(res.status).toBe(201);
  });
});
