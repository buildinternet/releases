import { beforeAll, describe, expect, it } from "bun:test";
import { Hono } from "hono";
import {
  generateKeyPair,
  exportJWK,
  SignJWT,
  createLocalJWKSet,
  type JWTVerifyGetKey,
  type CryptoKey,
} from "jose";
import { requireFollowsPrincipal } from "../src/middleware/auth.js";

/**
 * The `/v1/me/*` principal gate resolves a user from EITHER a Better Auth
 * session OR a Bearer user credential (`relu_` key / OAuth JWT) so CLI + MCP
 * callers (Bearer, not cookie) can manage follows. These tests drive the gate in
 * isolation, echoing the attached `session.user.id` so we can assert which lane
 * resolved. The `betterAuth` + `oauthJwtKeyResolver` context vars are the test
 * seams (the same ones the OAuth-JWT middleware test uses) so nothing hits a
 * network or a real DB.
 */

const ORIGIN = "https://api.releases.sh"; // the API worker's audience
const ISSUER = `${ORIGIN}/api/auth`; // the AS's canonical iss

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

async function jwt(sub: string, scope = "openid read"): Promise<string> {
  return new SignJWT({ scope })
    .setProtectedHeader({ alg: "RS256", kid: "k1" })
    .setIssuer(ISSUER)
    .setAudience(ORIGIN)
    .setSubject(sub)
    .setIssuedAt()
    .setExpirationTime("5m")
    .sign(privateKey);
}

/**
 * Mount the principal gate with injected seams, echoing the resolved principal.
 * `env` defaults to one where the OAuth-JWT lane is live (BETTER_AUTH_URL set)
 * and the user-key flag is on.
 */
function app(opts: {
  sessionUser?: { id: string; email: string; name: string } | null;
  verifyApiKey?: (a: { body: { key: string } }) => Promise<unknown>;
  env?: Record<string, unknown>;
}) {
  const a = new Hono();
  const betterAuth = {
    api: {
      getSession: async () => (opts.sessionUser ? { user: opts.sessionUser } : null),
      ...(opts.verifyApiKey ? { verifyApiKey: opts.verifyApiKey } : {}),
    },
  };
  a.use("*", async (c, next) => {
    // @ts-expect-error — test-only context seams, typed on the real Env.
    c.set("betterAuth", betterAuth);
    // @ts-expect-error — test-only context seam.
    c.set("oauthJwtKeyResolver", keyResolver);
    await next();
  });
  a.use("/v1/me/*", requireFollowsPrincipal);
  a.get("/v1/me/follows", (c) => {
    // Plain Hono() app — context vars aren't typed here, so read `session` via a
    // cast (mirrors the OAuth-JWT middleware test's plain-Hono setup).
    const session = (c as unknown as { get(k: string): { user: { id: string } } | undefined }).get(
      "session",
    );
    return c.json({ userId: session?.user.id ?? null });
  });
  const env = opts.env ?? { BETTER_AUTH_URL: ORIGIN, USER_API_KEYS_ENABLED: "true" };
  return { app: a, env: env as unknown as Record<string, unknown> };
}

const bearer = (t: string) => ({ headers: { Authorization: `Bearer ${t}` } });

describe("requireFollowsPrincipal", () => {
  it("401s when there is no session and no Bearer credential", async () => {
    const { app: a, env } = app({ sessionUser: null });
    const res = await a.request("/v1/me/follows", {}, env);
    expect(res.status).toBe(401);
    const body = (await res.json()) as { error: { code: string; type: string; message: string } };
    expect(body.error.code).toBe("unauthorized");
    expect(body.error.type).toBe("unauthorized");
    expect(body.error.message).toBe("Sign in required");
  });

  it("admits a Better Auth session and attaches its user id", async () => {
    const { app: a, env } = app({ sessionUser: { id: "u_session", email: "s@e.com", name: "S" } });
    const res = await a.request("/v1/me/follows", {}, env);
    expect(res.status).toBe(200);
    expect(((await res.json()) as { userId: string }).userId).toBe("u_session");
  });

  it("admits an OAuth JWT and attaches its subject as the user id", async () => {
    const { app: a, env } = app({ sessionUser: null });
    const res = await a.request("/v1/me/follows", bearer(await jwt("u_oauth")), env);
    expect(res.status).toBe(200);
    expect(((await res.json()) as { userId: string }).userId).toBe("u_oauth");
  });

  it("admits a relu_ user key and attaches its owning user id", async () => {
    const { app: a, env } = app({
      sessionUser: null,
      verifyApiKey: async () => ({
        valid: true,
        key: { id: "ak_1", userId: "u_key", permissions: { api: ["read"] } },
      }),
    });
    const res = await a.request("/v1/me/follows", bearer("relu_abc.secret"), env);
    expect(res.status).toBe(200);
    expect(((await res.json()) as { userId: string }).userId).toBe("u_key");
  });

  it("401s (invalid_token) on a Bearer credential that maps to no user", async () => {
    const { app: a, env } = app({ sessionUser: null });
    const res = await a.request("/v1/me/follows", bearer("not-a-token"), env);
    expect(res.status).toBe(401);
    expect(res.headers.get("WWW-Authenticate")).toContain("invalid_token");
  });

  it("ignores a relu_ key when the user-key flag is off (401)", async () => {
    const { app: a, env } = app({
      sessionUser: null,
      verifyApiKey: async () => ({
        valid: true,
        key: { id: "ak_1", userId: "u_key", permissions: { api: ["read"] } },
      }),
      env: { BETTER_AUTH_URL: ORIGIN }, // USER_API_KEYS_ENABLED unset → flag off
    });
    const res = await a.request("/v1/me/follows", bearer("relu_abc.secret"), env);
    expect(res.status).toBe(401);
  });

  it("429s a rate-limited relu_ key (not 401), matching the catalog API", async () => {
    const { app: a, env } = app({
      sessionUser: null,
      verifyApiKey: async () => ({ valid: false, error: { code: "RATE_LIMITED" } }),
    });
    const res = await a.request("/v1/me/follows", bearer("relu_abc.secret"), env);
    expect(res.status).toBe(429);
    const body = (await res.json()) as { error: { code: string; type: string } };
    expect(body.error.code).toBe("rate_limited");
    expect(body.error.type).toBe("rate_limited");
  });
});
