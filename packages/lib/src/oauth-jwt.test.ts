import { describe, it, expect, beforeAll } from "bun:test";
import {
  generateKeyPair,
  exportJWK,
  SignJWT,
  createLocalJWKSet,
  type JWTVerifyGetKey,
  type CryptoKey,
} from "jose";
import {
  isJwtShaped,
  extractApiScopes,
  verifyOAuthJwt,
  defaultJwksUrl,
  audienceVariants,
  type OAuthJwtConfig,
} from "./oauth-jwt.js";

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
  sub?: string | null;
  role?: string;
  azp?: unknown;
  client_id?: unknown;
  clientId?: unknown;
  issuer?: string;
  audience?: string;
  expiresIn?: string;
  expired?: boolean;
}): Promise<string> {
  const claims: Record<string, unknown> = {};
  if (opts.scope !== undefined) claims.scope = opts.scope;
  if (opts.role !== undefined) claims["https://releases.sh/role"] = opts.role;
  if (opts.azp !== undefined) claims.azp = opts.azp;
  if (opts.client_id !== undefined) claims.client_id = opts.client_id;
  if (opts.clientId !== undefined) claims.clientId = opts.clientId;
  const jwt = new SignJWT(claims)
    .setProtectedHeader({ alg: "RS256", kid: "test-key" })
    .setIssuer(opts.issuer ?? ISSUER)
    .setAudience(opts.audience ?? AUDIENCE);
  if (opts.sub !== null) jwt.setSubject(opts.sub ?? "user_123");
  jwt.setIssuedAt();
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

describe("defaultJwksUrl", () => {
  // The AS's canonical issuer carries the /api/auth basePath; the derivation
  // must stay origin-relative so it never doubles up to …/api/auth/api/auth/jwks
  // (the #1483 issuer-mismatch regression).
  it("derives ${origin}/api/auth/jwks from a suffixed issuer", () => {
    expect(defaultJwksUrl("https://api.releases.sh/api/auth")).toBe(
      "https://api.releases.sh/api/auth/jwks",
    );
    expect(defaultJwksUrl("https://api-staging.releases.sh/api/auth")).toBe(
      "https://api-staging.releases.sh/api/auth/jwks",
    );
  });
  it("derives the same URL from a bare origin (robust either way)", () => {
    expect(defaultJwksUrl("https://api.releases.sh")).toBe("https://api.releases.sh/api/auth/jwks");
  });
});

describe("verifyOAuthJwt", () => {
  // Regression for #1483: the AS stamps `iss = <base>/api/auth` (Better Auth's
  // baseURL includes the basePath). A resource server configured with the bare
  // origin used to reject every real token on jose's exact `iss` match. With the
  // issuer corrected to the suffixed form, a real-shaped token verifies.
  it("verifies a token issued with the AS's /api/auth issuer", async () => {
    const issuer = "https://api.releases.sh/api/auth";
    const token = await sign({ scope: "openid read", issuer });
    const res = await verifyOAuthJwt(token, { issuer, audience: AUDIENCE, keyResolver });
    expect(res).not.toBeNull();
    expect(res!.scopes).toEqual(["read"]);
  });

  it("rejects a token whose iss is the bare origin when the AS issuer is suffixed", async () => {
    const token = await sign({ scope: "read", issuer: "https://api.releases.sh" });
    const res = await verifyOAuthJwt(token, {
      issuer: "https://api.releases.sh/api/auth",
      audience: AUDIENCE,
      keyResolver,
    });
    expect(res).toBeNull();
  });

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

  it("projects the first non-empty signed OAuth client identity", async () => {
    const azp = await verifyOAuthJwt(
      await sign({ scope: "read", azp: "client-from-azp", client_id: "client-from-snake" }),
      config(),
    );
    const snake = await verifyOAuthJwt(
      await sign({
        scope: "read",
        azp: "",
        client_id: "client-from-snake",
        clientId: "client-from-camel",
      }),
      config(),
    );
    const camel = await verifyOAuthJwt(
      await sign({ scope: "read", clientId: "client-from-camel" }),
      config(),
    );

    expect(azp!.clientId).toBe("client-from-azp");
    expect(snake!.clientId).toBe("client-from-snake");
    expect(camel!.clientId).toBe("client-from-camel");
  });

  it("does not project missing or non-string OAuth client claims", async () => {
    const missing = await verifyOAuthJwt(await sign({ scope: "read", sub: null }), config());
    const nonString = await verifyOAuthJwt(
      await sign({ scope: "read", sub: null, azp: 42, client_id: {}, clientId: [] }),
      config(),
    );

    expect(missing!.clientId).toBeNull();
    expect(nonString!.clientId).toBeNull();
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

  // Trailing-slash tolerance: MCP clients derive their RFC 8707 `resource` via
  // WHATWG URL normalization, so a root-hosted resource server gets tokens whose
  // `aud` carries a trailing slash even when our configured audience omits it.
  // The verifier must accept the token in either direction.
  it("verifies a token whose aud has a trailing slash against a bare-origin config", async () => {
    const token = await sign({ scope: "read", audience: `${AUDIENCE}/` });
    const res = await verifyOAuthJwt(token, { issuer: ISSUER, audience: AUDIENCE, keyResolver });
    expect(res).not.toBeNull();
    expect(res!.scopes).toEqual(["read"]);
  });

  it("verifies a bare-origin aud against a trailing-slash config", async () => {
    const token = await sign({ scope: "read", audience: AUDIENCE });
    const res = await verifyOAuthJwt(token, {
      issuer: ISSUER,
      audience: `${AUDIENCE}/`,
      keyResolver,
    });
    expect(res).not.toBeNull();
  });

  it("still rejects an unrelated audience (slash tolerance is not a wildcard)", async () => {
    const token = await sign({ scope: "read", audience: "https://evil.example.com/" });
    expect(await verifyOAuthJwt(token, config())).toBeNull();
  });
});

describe("audienceVariants", () => {
  it("adds the trailing-slash form to a bare-origin audience", () => {
    expect(audienceVariants("https://mcp.releases.sh")).toEqual([
      "https://mcp.releases.sh",
      "https://mcp.releases.sh/",
    ]);
  });

  it("adds the bare form to a trailing-slash audience", () => {
    expect(audienceVariants("https://mcp.releases.sh/")).toEqual([
      "https://mcp.releases.sh/",
      "https://mcp.releases.sh",
    ]);
  });

  it("keeps the input first (stable order)", () => {
    expect(audienceVariants("https://a/")[0]).toBe("https://a/");
    expect(audienceVariants("https://a")[0]).toBe("https://a");
  });
});
