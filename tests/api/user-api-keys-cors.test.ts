import { describe, it, expect } from "bun:test";
import { Hono } from "hono";
import { apiCorsMiddleware, isTrustedCorsOrigin } from "../../workers/api/src/auth/index.js";

// Mirrors index.ts: one origin-based CORS middleware on every path.
function makeApp() {
  const app = new Hono();
  app.use("*", apiCorsMiddleware());
  app.get("/v1/api-keys", (c) => c.json({ apiKeys: [] }));
  app.post("/v1/me/avatar", (c) => c.json({ avatarUrl: "https://media.test/u.png" }));
  app.post("/v1/workspaces/:workspaceId/avatar", (c) =>
    c.json({ avatarUrl: "https://media.test/w.png" }),
  );
  app.post("/v1/listing/claim", (c) => c.json({ id: "clm_test" }));
  app.post("/v1/listing/claim/verify", (c) => c.json({ verified: true }));
  app.get("/v1/listing/claims", (c) => c.json({ claims: [] }));
  app.post("/v1/listing/promote", (c) => c.json({ promoted: true }));
  app.post("/v1/listing/validate", (c) => c.json({ ok: true }));
  app.get("/v1/orgs", (c) => c.json({ ok: true }));
  app.get("/api/auth/ok", (c) => c.text("ok"));
  return app;
}

describe("origin-based API CORS", () => {
  it("reflects a first-party origin with credentials on session surfaces", async () => {
    for (const path of [
      "/api/auth/ok",
      "/v1/api-keys",
      "/v1/me/avatar",
      "/v1/workspaces/org_abc/avatar",
      "/v1/listing/claim",
      "/v1/listing/claims",
      "/v1/listing/promote",
    ]) {
      const res = await makeApp().request(
        path,
        {
          method:
            path === "/v1/listing/claims" || path === "/api/auth/ok" || path === "/v1/api-keys"
              ? "GET"
              : "POST",
          headers: { Origin: "https://releases.sh" },
        },
        { ENVIRONMENT: "production" } as never,
      );
      expect(res.headers.get("access-control-allow-origin")).toBe("https://releases.sh");
      expect(res.headers.get("access-control-allow-credentials")).toBe("true");
    }
  });

  it("also credentials-reflects first-party origins on public routes (no path carve-out)", async () => {
    const res = await makeApp().request(
      "/v1/orgs",
      { headers: { Origin: "https://releases.sh" } },
      { ENVIRONMENT: "production" } as never,
    );
    expect(res.headers.get("access-control-allow-origin")).toBe("https://releases.sh");
    expect(res.headers.get("access-control-allow-credentials")).toBe("true");
  });

  it("uses wildcard CORS (no credentials) for untrusted origins on any path", async () => {
    for (const path of ["/v1/orgs", "/v1/listing/validate", "/v1/api-keys", "/api/auth/ok"]) {
      const res = await makeApp().request(path, { headers: { Origin: "https://evil.example" } }, {
        ENVIRONMENT: "production",
      } as never);
      expect(res.headers.get("access-control-allow-origin")).toBe("*");
      expect(res.headers.get("access-control-allow-credentials")).toBeNull();
    }
  });

  it("allows multipart avatar preflights (content-type) from a first-party origin", async () => {
    const res = await makeApp().request(
      "/v1/workspaces/org_abc/avatar",
      {
        method: "OPTIONS",
        headers: {
          Origin: "https://releases.sh",
          "Access-Control-Request-Method": "POST",
          "Access-Control-Request-Headers": "content-type",
        },
      },
      { ENVIRONMENT: "production" } as never,
    );
    expect(res.status).toBe(204);
    expect(res.headers.get("access-control-allow-origin")).toBe("https://releases.sh");
    expect(res.headers.get("access-control-allow-credentials")).toBe("true");
    expect(res.headers.get("access-control-allow-headers")?.toLowerCase()).toContain(
      "content-type",
    );
  });

  it("allows DELETE on api-key revoke preflight", async () => {
    const res = await makeApp().request(
      "/v1/api-keys/ak_1",
      {
        method: "OPTIONS",
        headers: {
          Origin: "https://releases.sh",
          "Access-Control-Request-Method": "DELETE",
        },
      },
      { ENVIRONMENT: "production" } as never,
    );
    expect(res.headers.get("access-control-allow-methods")?.toUpperCase()).toContain("DELETE");
  });

  it("allows listing claim preflight with content-type", async () => {
    const res = await makeApp().request(
      "/v1/listing/claim",
      {
        method: "OPTIONS",
        headers: {
          Origin: "https://releases.sh",
          "Access-Control-Request-Method": "POST",
          "Access-Control-Request-Headers": "content-type",
        },
      },
      { ENVIRONMENT: "production" } as never,
    );
    expect(res.headers.get("access-control-allow-origin")).toBe("https://releases.sh");
    expect(res.headers.get("access-control-allow-credentials")).toBe("true");
  });

  it("untrusted preflight gets * without credentials (credentialed browser mode fails closed)", async () => {
    const res = await makeApp().request(
      "/v1/listing/claim",
      {
        method: "OPTIONS",
        headers: {
          Origin: "https://evil.example",
          "Access-Control-Request-Method": "POST",
          "Access-Control-Request-Headers": "content-type",
        },
      },
      { ENVIRONMENT: "production" } as never,
    );
    expect(res.headers.get("access-control-allow-origin")).toBe("*");
    expect(res.headers.get("access-control-allow-credentials")).toBeNull();
  });
});

describe("isTrustedCorsOrigin", () => {
  it("trusts the releases.sh family in production", () => {
    expect(isTrustedCorsOrigin("https://releases.sh", { ENVIRONMENT: "production" })).toBe(true);
    expect(isTrustedCorsOrigin("https://app.releases.sh", { ENVIRONMENT: "production" })).toBe(
      true,
    );
  });

  it("rejects loopback in production and allows it off-prod", () => {
    expect(isTrustedCorsOrigin("http://localhost:3000", { ENVIRONMENT: "production" })).toBe(false);
    expect(isTrustedCorsOrigin("http://localhost:3000", { ENVIRONMENT: "development" })).toBe(true);
  });

  it("honors BETTER_AUTH_TRUSTED_ORIGINS extras", () => {
    expect(
      isTrustedCorsOrigin("https://feat.vercel.app", {
        ENVIRONMENT: "production",
        BETTER_AUTH_TRUSTED_ORIGINS: "https://feat.vercel.app",
      }),
    ).toBe(true);
    expect(
      isTrustedCorsOrigin("https://a.dev.example", {
        ENVIRONMENT: "development",
        BETTER_AUTH_TRUSTED_ORIGINS: "*.dev.example",
      }),
    ).toBe(true);
  });

  it("rejects unknown origins", () => {
    expect(isTrustedCorsOrigin("https://evil.example", { ENVIRONMENT: "production" })).toBe(false);
    expect(isTrustedCorsOrigin("https://evil.example", { ENVIRONMENT: "development" })).toBe(false);
  });
});
