import { describe, it, expect, beforeAll } from "bun:test";
import {
  generateKeyPair,
  exportJWK,
  SignJWT,
  createLocalJWKSet,
  type JWTVerifyGetKey,
  type CryptoKey,
} from "jose";
import { isJwtShaped, extractApiScopes, verifyOAuthJwt, type OAuthJwtConfig } from "./oauth-jwt.js";

const ISSUER = "https://api.releases.sh";
const AUDIENCE = "https://mcp.releases.sh";

let privateKey: CryptoKey;
let keyResolver: JWTVerifyGetKey;

beforeAll(async () => {
  const kp = await generateKeyPair("RS256");
  privateKey = kp.privateKey;
  const publicJwk = await exportJWK(kp.publicKey);
  publicJwk.kid = "test-key";
  publicJwk.alg = "RS256";
  keyResolver = createLocalJWKSet({ keys: [publicJwk] });
});

/** Sign a token with the test key; overrides let each case bend one dimension. */
async function sign(opts: {
  scope?: string | string[];
  sub?: string;
  role?: string;
  issuer?: string;
  audience?: string;
  expiresIn?: string;
  expired?: boolean;
}): Promise<string> {
  const claims: Record<string, unknown> = {};
  if (opts.scope !== undefined) claims.scope = opts.scope;
  if (opts.role !== undefined) claims["https://releases.sh/role"] = opts.role;
  const jwt = new SignJWT(claims)
    .setProtectedHeader({ alg: "RS256", kid: "test-key" })
    .setIssuer(opts.issuer ?? ISSUER)
    .setAudience(opts.audience ?? AUDIENCE)
    .setSubject(opts.sub ?? "user_123")
    .setIssuedAt();
  if (opts.expired) jwt.setExpirationTime(Math.floor(Date.now() / 1000) - 60);
  else jwt.setExpirationTime(opts.expiresIn ?? "5m");
  return jwt.sign(privateKey);
}

const config = (): OAuthJwtConfig => ({ issuer: ISSUER, audience: AUDIENCE, keyResolver });

describe("isJwtShaped", () => {
  it("accepts a three-segment compact JWS", () => {
    expect(isJwtShaped("aGVhZGVy.cGF5bG9hZA.c2ln")).toBe(true);
  });
  it("rejects opaque tokens and the static-key shape", () => {
    expect(isJwtShaped("relk_abcdefghijkl_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA")).toBe(false);
    expect(isJwtShaped("relu_userkey")).toBe(false);
    expect(isJwtShaped("a-plain-static-root-key")).toBe(false);
    expect(isJwtShaped("only.two")).toBe(false);
    expect(isJwtShaped("three..segments")).toBe(false); // empty middle
  });
});

describe("extractApiScopes", () => {
  it("keeps only ladder scopes from a space-delimited claim", () => {
    expect(extractApiScopes({ scope: "openid profile email offline_access read write" })).toEqual([
      "read",
      "write",
    ]);
  });
  it("supports an array scope and dedupes", () => {
    expect(extractApiScopes({ scope: ["read", "read", "admin"] })).toEqual(["read", "admin"]);
  });
  it("returns [] for a missing or non-string scope", () => {
    expect(extractApiScopes({})).toEqual([]);
    expect(extractApiScopes({ scope: 42 as unknown as string })).toEqual([]);
  });
});

describe("verifyOAuthJwt", () => {
  it("verifies a well-formed token and projects scopes + role + subject", async () => {
    const token = await sign({
      scope: "openid read write",
      role: "curator",
      sub: "user_abc",
    });
    const res = await verifyOAuthJwt(token, config());
    expect(res).not.toBeNull();
    expect(res!.subject).toBe("user_abc");
    expect(res!.scopes).toEqual(["read", "write"]);
    expect(res!.role).toBe("curator");
  });

  it("returns null on a wrong issuer", async () => {
    const token = await sign({ scope: "read", issuer: "https://evil.example.com" });
    expect(await verifyOAuthJwt(token, config())).toBeNull();
  });

  it("returns null on a wrong audience", async () => {
    const token = await sign({ scope: "read", audience: "https://someone-else.example.com" });
    expect(await verifyOAuthJwt(token, config())).toBeNull();
  });

  it("returns null on an expired token", async () => {
    const token = await sign({ scope: "read", expired: true });
    expect(await verifyOAuthJwt(token, config())).toBeNull();
  });

  it("returns null on a tampered signature", async () => {
    const token = await sign({ scope: "admin" });
    const tampered = token.slice(0, -3) + (token.endsWith("AAA") ? "BBB" : "AAA");
    expect(await verifyOAuthJwt(tampered, config())).toBeNull();
  });

  it("returns null on garbage input (never throws)", async () => {
    expect(await verifyOAuthJwt("not.a.jwt", config())).toBeNull();
    expect(await verifyOAuthJwt("", config())).toBeNull();
  });

  it("verifies a token whose only API scope is read", async () => {
    const token = await sign({ scope: "openid profile read" });
    const res = await verifyOAuthJwt(token, config());
    expect(res!.scopes).toEqual(["read"]);
  });
});
