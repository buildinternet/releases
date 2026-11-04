import { describe, it, expect } from "bun:test";
import { Hono } from "hono";
import { sessionJwtOriginGuard, SESSION_JWT_PATH } from "../src/auth/session-jwt-origin-guard.js";
import { authTrustedOrigins } from "../src/auth/index.js";

const prod = { ENVIRONMENT: "production", WEB_BASE_URL: "https://releases.sh" } as never;

function app() {
  const a = new Hono();
  a.use(SESSION_JWT_PATH, sessionJwtOriginGuard());
  a.get(SESSION_JWT_PATH, (c) => c.json({ token: "jwt" }));
  return a;
}

describe("sessionJwtOriginGuard", () => {
  it("passes a server-to-server call with no Origin", async () => {
    const res = await app().request(SESSION_JWT_PATH, {}, prod);
    expect(res.status).toBe(200);
  });

  it("passes the exact web origin", async () => {
    const res = await app().request(
      SESSION_JWT_PATH,
      { headers: { Origin: "https://releases.sh" } },
      prod,
    );
    expect(res.status).toBe(200);
  });

  it("refuses sibling subdomains, other sites and opaque origins", async () => {
    for (const origin of [
      "https://evil.releases.sh",
      "https://media.releases.sh",
      "http://releases.sh",
      "https://attacker.example",
      "null",
    ]) {
      const res = await app().request(SESSION_JWT_PATH, { headers: { Origin: origin } }, prod);
      expect(res.status).toBe(403);
      const body = (await res.json()) as { error: { code: string } };
      expect(body.error.code).toBe("forbidden");
    }
  });
});

describe("authTrustedOrigins", () => {
  it("pins the public family to HTTPS and drops dev hosts in production", () => {
    const origins = authTrustedOrigins(prod);
    expect(origins).toContain("https://releases.sh");
    expect(origins).toContain("https://*.releases.sh");
    expect(origins).not.toContain("*.releases.sh");
    expect(origins.some((o) => o.includes("releases.localhost"))).toBe(false);
    expect(origins.some((o) => o.includes("localhost:"))).toBe(false);
  });

  it("keeps the dev hosts off-prod", () => {
    const origins = authTrustedOrigins({ ENVIRONMENT: "development" } as never);
    expect(origins).toContain("*.releases.localhost");
    expect(origins).toContain("http://localhost:*");
  });
});
