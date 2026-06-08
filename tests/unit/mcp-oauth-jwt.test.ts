/**
 * OAuth-JWT lane for the MCP worker (#1483 + the OAuth discovery surface). The
 * verifier is unit-tested in @releases/lib; here we prove the wiring: a verified
 * "Sign in with Releases" JWT resolves to a scoped token identity, a
 * presented-but-invalid JWT is challenged with a 401 + WWW-Authenticate (so a
 * compliant client can re-auth) rather than silently downgraded, and a JWT
 * identity does NOT bypass the staging access gate. The `jwtKeyResolver` opts
 * seam avoids a real JWKS fetch.
 */
import { describe, it, expect, beforeAll } from "bun:test";
import {
  generateKeyPair,
  exportJWK,
  SignJWT,
  createLocalJWKSet,
  type JWTVerifyGetKey,
  type CryptoKey,
} from "jose";
import { resolveMcpAuth, machineTokenIdForUsage } from "../../workers/mcp/src/auth.js";
import type { Env } from "../../workers/mcp/src/mcp-agent.js";

// The AS's canonical issuer = Better Auth base URL incl. the /api/auth basePath
// (matches token `iss` + DEFAULT_OAUTH_ISSUER in workers/mcp/src/auth.ts).
const ISSUER = "https://api.releases.sh/api/auth";
const AUDIENCE = "https://mcp.releases.sh";

const mockSecret = (v: string) => ({ get: () => Promise.resolve(v) });

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

async function jwt(scope: string, opts: { aud?: string } = {}): Promise<string> {
  return new SignJWT({ scope })
    .setProtectedHeader({ alg: "RS256", kid: "k1" })
    .setIssuer(ISSUER)
    .setAudience(opts.aud ?? AUDIENCE)
    .setSubject("user_42")
    .setIssuedAt()
    .setExpirationTime("5m")
    .sign(privateKey);
}

function env(overrides: Partial<Env> = {}): Env {
  return {
    DB: {} as never,
    RELEASES_API_KEY: mockSecret("root-secret"),
    ...overrides,
  } as unknown as Env;
}

function req(headers: Record<string, string>): Request {
  return new Request("https://mcp.releases.sh/mcp", { method: "POST", headers });
}

describe("MCP OAuth-JWT lane", () => {
  it("resolves a verified JWT to a scoped token identity (token: null)", async () => {
    const r = await resolveMcpAuth(
      req({ Authorization: `Bearer ${await jwt("read write")}` }),
      env(),
      {
        jwtKeyResolver: keyResolver,
      },
    );
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.identity.kind).toBe("token");
      expect(r.identity.scopes).toEqual(["read", "write"]);
      expect(r.identity.token).toBeNull();
      if (r.identity.kind === "token") expect(r.identity.tokenId.startsWith("oauth_")).toBe(true);
    }
  });

  it("maps a read-only JWT to read scope", async () => {
    const r = await resolveMcpAuth(
      req({ Authorization: `Bearer ${await jwt("openid read")}` }),
      env(),
      {
        jwtKeyResolver: keyResolver,
      },
    );
    expect(r.ok && r.identity.scopes).toEqual(["read"]);
  });

  // A presented-but-invalid OAuth JWT (wrong audience, tampered, expired) is
  // challenged with a 401 + WWW-Authenticate so a compliant MCP client can
  // discover the resource metadata and re-authenticate. This is the OAuth lane
  // ONLY — a no-credential request and the relk_/relu_ lanes still fall open to
  // anonymous read (see mcp-auth.test.ts), so public read is never gated.
  const EXPECTED_CHALLENGE =
    'Bearer error="invalid_token", ' +
    'resource_metadata="https://mcp.releases.sh/.well-known/oauth-protected-resource"';

  it("challenges a wrong-audience JWT with 401 + WWW-Authenticate", async () => {
    const token = await jwt("admin", { aud: "https://elsewhere.example.com" });
    const r = await resolveMcpAuth(req({ Authorization: `Bearer ${token}` }), env(), {
      jwtKeyResolver: keyResolver,
    });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.response.status).toBe(401);
      expect(r.response.headers.get("WWW-Authenticate")).toBe(EXPECTED_CHALLENGE);
    }
  });

  it("challenges a tampered JWT with 401 + WWW-Authenticate", async () => {
    const good = await jwt("admin");
    const tampered = good.slice(0, -3) + (good.endsWith("AAA") ? "BBB" : "AAA");
    const r = await resolveMcpAuth(req({ Authorization: `Bearer ${tampered}` }), env(), {
      jwtKeyResolver: keyResolver,
    });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.response.status).toBe(401);
      expect(r.response.headers.get("WWW-Authenticate")).toBe(EXPECTED_CHALLENGE);
    }
  });

  it("a JWT verifying with zero API scopes is challenged, not silently anonymous", async () => {
    // openid/profile only → no read/write/admin → not a usable API principal.
    const r = await resolveMcpAuth(
      req({ Authorization: `Bearer ${await jwt("openid profile")}` }),
      env(),
      {
        jwtKeyResolver: keyResolver,
      },
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.response.status).toBe(401);
  });

  it("does not record machine-lane usage for an oauth_ principal", async () => {
    const r = await resolveMcpAuth(req({ Authorization: `Bearer ${await jwt("read")}` }), env(), {
      jwtKeyResolver: keyResolver,
    });
    expect(r.ok).toBe(true);
    if (r.ok) expect(machineTokenIdForUsage(r.identity)).toBeNull();
  });

  it("a JWT identity does NOT bypass the staging access gate", async () => {
    const stagingEnv = env({ STAGING_ACCESS_KEY: mockSecret("stage-key") as never });
    const token = await jwt("admin");
    // No staging key header → gate rejects despite a valid JWT.
    const blocked = await resolveMcpAuth(req({ Authorization: `Bearer ${token}` }), stagingEnv, {
      jwtKeyResolver: keyResolver,
    });
    expect(blocked.ok).toBe(false);
    // With the staging key header → passes.
    const allowed = await resolveMcpAuth(
      req({ Authorization: `Bearer ${token}`, "X-Releases-Staging-Key": "stage-key" }),
      stagingEnv,
      { jwtKeyResolver: keyResolver },
    );
    expect(allowed.ok).toBe(true);
  });
});
