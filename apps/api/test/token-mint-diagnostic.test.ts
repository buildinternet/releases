import { describe, it, expect } from "bun:test";
import { eq } from "drizzle-orm";
import { createAuth } from "../src/auth/index.js";
import { createTestDb } from "./setup";
import { user as userTable } from "../src/db/schema-auth.js";
import { verifyOAuthJwt, localKeyResolver } from "../../../packages/lib/src/oauth-jwt.js";

const env = {
  BETTER_AUTH_URL: "https://api.releases.localhost",
  BETTER_AUTH_SECRET: "test-secret-do-not-use-in-prod-0123456789",
  WEB_BASE_URL: "https://releases.localhost",
} as never;

function cookieFromResponse(res: Response): string {
  const all = res.headers.getSetCookie?.() ?? [];
  return all.map((c) => c.split(";")[0]).join("; ");
}

/**
 * End-to-end coverage of the admin per-user JWT path AND the in-process JWKS
 * verification the API worker uses (it is the AS, so it must verify its OWN
 * tokens with locally-read keys via {@link localKeyResolver} — not a remote
 * self-fetch of its own /api/auth/jwks, which fails on Cloudflare and was the
 * cause of admin actions 401ing with a correctly-minted token).
 */
describe("admin /token JWT verifies via in-process JWKS (localKeyResolver)", () => {
  it("mints an admin-scoped JWT and verifies it with local keys", async () => {
    const db = createTestDb();
    const auth = await createAuth(env, undefined, { db, sendEmail: () => {} });
    const email = "diag@example.com";
    const password = "password-1234-aaaa";

    await auth.handler(
      new Request("https://api.releases.localhost/api/auth/sign-up/email", {
        method: "POST",
        headers: { "content-type": "application/json", origin: "https://releases.localhost" },
        body: JSON.stringify({ email, password, name: "Diag" }),
      }),
    );
    await db
      .update(userTable)
      .set({ role: "admin", emailVerified: true })
      .where(eq(userTable.email, email));

    const signIn = await auth.handler(
      new Request("https://api.releases.localhost/api/auth/sign-in/email", {
        method: "POST",
        headers: { "content-type": "application/json", origin: "https://releases.localhost" },
        body: JSON.stringify({ email, password }),
      }),
    );
    const cookie = cookieFromResponse(signIn);
    expect(cookie).toBeTruthy();

    // Mint the per-user JWT exactly as the web admin actions do.
    const tokenRes = await auth.handler(
      new Request("https://api.releases.localhost/api/auth/token", {
        method: "GET",
        headers: { cookie, origin: "https://releases.localhost" },
      }),
    );
    expect(tokenRes.status).toBe(200);
    const { token } = (await tokenRes.json()) as { token: string };
    expect(typeof token).toBe("string");

    // Read the worker's own JWKS in-process (no network self-fetch) and build the
    // production key resolver from it — the path verifyPresentedJwt takes in prod.
    const jwksRes = await auth.handler(
      new Request("https://api.releases.localhost/api/auth/jwks", { method: "GET" }),
    );
    const resolver = localKeyResolver(await jwksRes.json());

    const verified = await verifyOAuthJwt(token, {
      issuer: "https://api.releases.localhost/api/auth",
      audience: "https://api.releases.localhost",
      keyResolver: resolver,
    });

    expect(verified).not.toBeNull();
    expect(verified?.role).toBe("admin");
    expect(verified?.scopes).toEqual(["read", "write", "admin"]);
  });
});
