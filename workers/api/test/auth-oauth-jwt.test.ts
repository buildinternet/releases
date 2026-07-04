import { describe, it, expect, beforeAll } from "bun:test";
import { Hono } from "hono";
import {
  generateKeyPair,
  exportJWK,
  SignJWT,
  createLocalJWKSet,
  type JWTVerifyGetKey,
  type CryptoKey,
} from "jose";
import { authMiddleware, publicReadAuthMiddleware } from "../src/middleware/auth";

/**
 * End-to-end wiring of the OAuth-JWT lane (#1483) through the API auth
 * middleware. The verifier itself is unit-tested in @releases/lib; here we prove
 * a verified JWT maps to the scope ladder and gates routes exactly like a relk_
 * token, using the `oauthJwtKeyResolver` context seam so no JWKS is fetched.
 */

const ORIGIN = "https://api.releases.sh"; // the API worker's audience (the resource identifier)
const ISSUER = `${ORIGIN}/api/auth`; // the AS's canonical iss (Better Auth base URL incl. basePath)

let privateKey: CryptoKey;
let keyResolver: JWTVerifyGetKey;

beforeAll(async () => {
  const kp = await generateKeyPair("RS256");
  privateKey = kp.privateKey;
  const jwk = await exportJWK(kp.publicKey);
  jwk.kid = "k1";
  jwk.alg = "RS256";
  keyResolver = createLocalJWKSet({ keys: [jwk] });
});

async function jwt(scope: string, opts: { aud?: string; iss?: string } = {}): Promise<string> {
  return new SignJWT({ scope })
    .setProtectedHeader({ alg: "RS256", kid: "k1" })
    .setIssuer(opts.iss ?? ISSUER)
    .setAudience(opts.aud ?? ORIGIN)
    .setSubject("user_42")
    .setIssuedAt()
    .setExpirationTime("5m")
    .sign(privateKey);
}

function secretBinding(value: string) {
  return { get: async () => value };
}

/** Env with the static-root secret + BETTER_AUTH_URL (issuer/audience origin). */
function env() {
  return { RELEASES_API_KEY: secretBinding("root-secret"), BETTER_AUTH_URL: ORIGIN } as never;
}

/** App that injects the local key resolver, then applies the given middleware. */
function app(middleware: typeof authMiddleware) {
  const a = new Hono();
  a.use("*", async (c, next) => {
    // @ts-expect-error — test-only context seam, typed on the real Env.
    c.set("oauthJwtKeyResolver", keyResolver);
    await next();
  });
  a.use("*", middleware);
  a.get("/", (c) => c.json({ ok: true }));
  a.post("/", (c) => c.json({ ok: true }));
  return a;
}

const auth = (t: string) => ({ headers: { Authorization: `Bearer ${t}` } });

describe("OAuth-JWT lane — REST auth middleware", () => {
  it("admits an admin-scoped JWT to an admin-gated route", async () => {
    const res = await app(authMiddleware).request("/", auth(await jwt("read write admin")), env());
    expect(res.status).toBe(200);
  });

  it("rejects a read-only JWT on an admin-gated route with 403 insufficient_scope", async () => {
    const res = await app(authMiddleware).request("/", auth(await jwt("openid read")), env());
    expect(res.status).toBe(403);
    const body = (await res.json()) as { error: { code: string; type: string } };
    expect(body.error.code).toBe("insufficient_scope");
    expect(body.error.type).toBe("insufficient_scope");
  });

  it("admits a write-scoped JWT to a write-gated POST", async () => {
    const res = await app(publicReadAuthMiddleware).request(
      "/",
      { method: "POST", ...auth(await jwt("read write")) },
      env(),
    );
    expect(res.status).toBe(200);
  });

  it("rejects a read-only JWT on a write-gated POST with 403", async () => {
    const res = await app(publicReadAuthMiddleware).request(
      "/",
      { method: "POST", ...auth(await jwt("read")) },
      env(),
    );
    expect(res.status).toBe(403);
  });

  it("leaves a public GET open for a read-scoped JWT", async () => {
    const res = await app(publicReadAuthMiddleware).request("/", auth(await jwt("read")), env());
    expect(res.status).toBe(200);
  });

  it("treats a wrong-audience JWT as an invalid token (401) on an admin route", async () => {
    const res = await app(authMiddleware).request(
      "/",
      auth(await jwt("admin", { aud: "https://mcp.releases.sh" })),
      env(),
    );
    expect(res.status).toBe(401);
    expect(res.headers.get("WWW-Authenticate")).toContain('error="invalid_token"');
  });

  it("treats a wrong-issuer JWT as invalid (401) on an admin route", async () => {
    const res = await app(authMiddleware).request(
      "/",
      auth(await jwt("admin", { iss: "https://evil.example.com" })),
      env(),
    );
    expect(res.status).toBe(401);
  });

  it("does not let a JWT-shaped junk token authenticate as root", async () => {
    // Three base64url-ish segments but not signed by us → verify fails → 401.
    const res = await app(authMiddleware).request("/", auth("aaa.bbb.ccc"), env());
    expect(res.status).toBe(401);
  });
});
