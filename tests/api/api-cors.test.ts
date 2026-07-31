import { describe, it, expect } from "bun:test";
import { Hono } from "hono";
import { apiCorsMiddleware, isTrustedCorsOrigin } from "../../workers/api/src/auth/index.js";

/** Mirrors index.ts: one origin-based CORS middleware on every path. */
function makeApp() {
  const app = new Hono();
  app.use("*", apiCorsMiddleware());
  app.get("/v1/orgs", (c) => c.json({ ok: true }));
  app.post("/v1/listing/claim", (c) => c.json({ id: "clm_test" }));
  app.get("/api/auth/ok", (c) => c.text("ok"));
  return app;
}

const prod = { ENVIRONMENT: "production" } as never;

describe("apiCorsMiddleware", () => {
  it("reflects first-party origin with credentials on any path", async () => {
    for (const path of ["/api/auth/ok", "/v1/listing/claim", "/v1/orgs"]) {
      const res = await makeApp().request(
        path,
        {
          method: path === "/v1/listing/claim" ? "POST" : "GET",
          headers: { Origin: "https://releases.sh" },
        },
        prod,
      );
      expect(res.headers.get("access-control-allow-origin")).toBe("https://releases.sh");
      expect(res.headers.get("access-control-allow-credentials")).toBe("true");
    }
  });

  it("uses * without credentials for untrusted origins on any path", async () => {
    for (const path of ["/v1/orgs", "/v1/listing/claim", "/api/auth/ok"]) {
      const res = await makeApp().request(
        path,
        { headers: { Origin: "https://evil.example" } },
        prod,
      );
      expect(res.headers.get("access-control-allow-origin")).toBe("*");
      expect(res.headers.get("access-control-allow-credentials")).toBeNull();
    }
  });

  it("answers preflight with methods, max-age, and allow-headers", async () => {
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
      prod,
    );
    expect(res.status).toBe(204);
    expect(res.headers.get("access-control-allow-origin")).toBe("https://releases.sh");
    expect(res.headers.get("access-control-allow-credentials")).toBe("true");
    expect(res.headers.get("access-control-allow-methods")?.toUpperCase()).toContain("POST");
    expect(res.headers.get("access-control-allow-methods")?.toUpperCase()).toContain("DELETE");
    expect(res.headers.get("access-control-allow-headers")?.toLowerCase()).toContain(
      "content-type",
    );
    expect(res.headers.get("access-control-max-age")).toBe("600");
  });

  it("untrusted preflight gets * without credentials", async () => {
    const res = await makeApp().request(
      "/v1/listing/claim",
      {
        method: "OPTIONS",
        headers: {
          Origin: "https://evil.example",
          "Access-Control-Request-Method": "POST",
        },
      },
      prod,
    );
    expect(res.headers.get("access-control-allow-origin")).toBe("*");
    expect(res.headers.get("access-control-allow-credentials")).toBeNull();
  });
});

describe("isTrustedCorsOrigin", () => {
  it("trusts the releases family; rejects unknown", () => {
    expect(isTrustedCorsOrigin("https://releases.sh", { ENVIRONMENT: "production" })).toBe(true);
    expect(isTrustedCorsOrigin("https://app.releases.sh", { ENVIRONMENT: "production" })).toBe(
      true,
    );
    expect(isTrustedCorsOrigin("https://evil.example", { ENVIRONMENT: "production" })).toBe(false);
  });

  it("allows loopback only off-prod", () => {
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
});
