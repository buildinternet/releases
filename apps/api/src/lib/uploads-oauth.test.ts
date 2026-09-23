import { describe, expect, it } from "bun:test";
import { accessTokenNeedsRefresh } from "./uploads-oauth-tokens.js";
import {
  DEFAULT_UPLOADS_OAUTH,
  UPLOADS_OAUTH_REGISTERED_REDIRECT_URIS,
  buildUploadsAuthorizeUrl,
  exchangeAuthorizationCode,
  refreshUploadsAccessToken,
  resolveUploadsOAuthConfig,
  revokeUploadsToken,
  uploadsOAuthRedirectUri,
  uploadsWorkspaceFromAccessToken,
} from "./uploads-oauth.js";

function encodeJwtSegment(value: unknown): string {
  const json = JSON.stringify(value);
  const bytes = new TextEncoder().encode(json);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function unsignedJwt(payload: Record<string, unknown>): string {
  return `${encodeJwtSegment({ alg: "none", typ: "JWT" })}.${encodeJwtSegment(payload)}.sig`;
}

const KEY = "AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8=";

describe("uploads-oauth config", () => {
  it("is unconfigured without an encryption key", async () => {
    expect(await resolveUploadsOAuthConfig({})).toBeNull();
  });

  it("defaults public client id and discovery endpoints when the encryption key resolves", async () => {
    const cfg = await resolveUploadsOAuthConfig({
      IDEMPOTENCY_ENCRYPTION_KEY: KEY,
    });
    expect(cfg).toMatchObject({
      clientId: "releases-sh",
      authorizeUrl: DEFAULT_UPLOADS_OAUTH.authorizeUrl,
      tokenUrl: DEFAULT_UPLOADS_OAUTH.tokenUrl,
      revokeUrl: DEFAULT_UPLOADS_OAUTH.revokeUrl,
      scopes: "files:read offline_access",
    });
    expect(cfg).not.toHaveProperty("clientSecret");
  });

  it("prefers a trusted request Origin for the redirect URI", () => {
    const local = { ENVIRONMENT: "development" };
    expect(uploadsOAuthRedirectUri(local, "http://localhost:3000")).toBe(
      "http://localhost:3000/integrations/uploads/callback",
    );
    expect(uploadsOAuthRedirectUri(local, "http://127.0.0.1:3000")).toBe(
      "http://127.0.0.1:3000/integrations/uploads/callback",
    );
    expect(uploadsOAuthRedirectUri(local, "https://releases.localhost")).toBe(
      "https://releases.localhost/integrations/uploads/callback",
    );
    expect(
      uploadsOAuthRedirectUri({ WEB_BASE_URL: "https://releases.sh" }, "https://evil.example"),
    ).toBe("https://releases.sh/integrations/uploads/callback");
  });

  it("does not use MCP preview :8788 as a redirect origin", () => {
    const env = { ENVIRONMENT: "development", WEB_BASE_URL: "https://releases.sh" };
    expect(uploadsOAuthRedirectUri(env, "http://localhost:8788")).toBe(
      "https://releases.sh/integrations/uploads/callback",
    );
    expect(uploadsOAuthRedirectUri(env, "http://127.0.0.1:8788")).toBe(
      "https://releases.sh/integrations/uploads/callback",
    );
  });

  it("lists the four registered web-origin callbacks", () => {
    expect([...UPLOADS_OAUTH_REGISTERED_REDIRECT_URIS]).toEqual([
      "https://releases.sh/integrations/uploads/callback",
      "http://localhost:3000/integrations/uploads/callback",
      "http://127.0.0.1:3000/integrations/uploads/callback",
      "https://releases.localhost/integrations/uploads/callback",
    ]);
  });

  it("honors an explicit redirect override", () => {
    expect(
      uploadsOAuthRedirectUri(
        { UPLOADS_OAUTH_REDIRECT_URI: "https://releases.localhost/integrations/uploads/callback" },
        "https://releases.sh",
      ),
    ).toBe("https://releases.localhost/integrations/uploads/callback");
  });

  it("builds an authorize URL with PKCE S256", () => {
    const url = new URL(
      buildUploadsAuthorizeUrl({
        authorizeUrl: DEFAULT_UPLOADS_OAUTH.authorizeUrl,
        clientId: "releases-sh",
        redirectUri: "https://releases.sh/integrations/uploads/callback",
        scopes: "files:read offline_access",
        state: "st",
        codeChallenge: "ch",
      }),
    );
    expect(url.origin + url.pathname).toBe("https://uploads.sh/api/auth/oauth2/authorize");
    expect(url.searchParams.get("response_type")).toBe("code");
    expect(url.searchParams.get("code_challenge_method")).toBe("S256");
    expect(url.searchParams.get("scope")).toBe("files:read offline_access");
    expect(url.searchParams.get("client_id")).toBe("releases-sh");
  });

  const publicCfg = {
    clientId: "releases-sh",
    authorizeUrl: DEFAULT_UPLOADS_OAUTH.authorizeUrl,
    tokenUrl: DEFAULT_UPLOADS_OAUTH.tokenUrl,
    revokeUrl: DEFAULT_UPLOADS_OAUTH.revokeUrl,
    scopes: DEFAULT_UPLOADS_OAUTH.scopes,
    encryptionKey: KEY,
  };

  it("exchanges an authorization code against the token endpoint without a client secret", async () => {
    const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
      expect(String(input)).toBe(DEFAULT_UPLOADS_OAUTH.tokenUrl);
      expect(init?.method).toBe("POST");
      const body = new URLSearchParams(String(init?.body));
      expect(body.get("grant_type")).toBe("authorization_code");
      expect(body.get("client_id")).toBe("releases-sh");
      expect(body.get("client_secret")).toBeNull();
      expect(body.get("code_verifier")).toBe("ver");
      return new Response(
        JSON.stringify({
          access_token: "at",
          refresh_token: "rt",
          token_type: "Bearer",
          scope: "files:read offline_access",
          expires_in: 3600,
        }),
        { status: 200 },
      );
    }) as typeof fetch;

    const tokens = await exchangeAuthorizationCode(
      publicCfg,
      {
        code: "c",
        codeVerifier: "ver",
        redirectUri: "https://releases.sh/integrations/uploads/callback",
      },
      fetchImpl,
    );
    expect(tokens.accessToken).toBe("at");
    expect(tokens.refreshToken).toBe("rt");
    expect(tokens.expiresAt).toBeGreaterThan(Date.now());
  });

  it("refreshes via the refresh_token grant without a client secret", async () => {
    const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
      expect(String(input)).toBe(DEFAULT_UPLOADS_OAUTH.tokenUrl);
      const body = new URLSearchParams(String(init?.body));
      expect(body.get("grant_type")).toBe("refresh_token");
      expect(body.get("refresh_token")).toBe("rt");
      expect(body.get("client_id")).toBe("releases-sh");
      expect(body.get("client_secret")).toBeNull();
      return new Response(
        JSON.stringify({
          access_token: "at2",
          refresh_token: "rt2",
          token_type: "Bearer",
          scope: "files:read offline_access",
          expires_in: 3600,
        }),
        { status: 200 },
      );
    }) as typeof fetch;

    const tokens = await refreshUploadsAccessToken(publicCfg, "rt", fetchImpl);
    expect(tokens.accessToken).toBe("at2");
    expect(tokens.refreshToken).toBe("rt2");
  });

  it("revokes without a client secret", async () => {
    const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
      expect(String(input)).toBe(DEFAULT_UPLOADS_OAUTH.revokeUrl);
      const body = new URLSearchParams(String(init?.body));
      expect(body.get("token")).toBe("rt");
      expect(body.get("token_type_hint")).toBe("refresh_token");
      expect(body.get("client_id")).toBe("releases-sh");
      expect(body.get("client_secret")).toBeNull();
      return new Response(null, { status: 200 });
    }) as typeof fetch;

    await revokeUploadsToken(publicCfg, "rt", "refresh_token", fetchImpl);
  });
});

describe("uploadsWorkspaceFromAccessToken", () => {
  it("reads the primary workspace claim", () => {
    expect(uploadsWorkspaceFromAccessToken(unsignedJwt({ workspace: "acme" }))).toBe("acme");
  });

  it("falls back to the first workspaces[] slug", () => {
    expect(uploadsWorkspaceFromAccessToken(unsignedJwt({ workspaces: ["alpha", "beta"] }))).toBe(
      "alpha",
    );
    expect(
      uploadsWorkspaceFromAccessToken(unsignedJwt({ workspaces: [{ slug: "from-object" }] })),
    ).toBe("from-object");
  });

  it("prefers workspace over workspaces[]", () => {
    expect(
      uploadsWorkspaceFromAccessToken(unsignedJwt({ workspace: "primary", workspaces: ["other"] })),
    ).toBe("primary");
  });

  it("returns null for opaque or claimless tokens", () => {
    expect(uploadsWorkspaceFromAccessToken("not-a-jwt")).toBeNull();
    expect(uploadsWorkspaceFromAccessToken(unsignedJwt({ sub: "user_1" }))).toBeNull();
    expect(uploadsWorkspaceFromAccessToken(unsignedJwt({ workspace: "  " }))).toBeNull();
  });
});

describe("accessTokenNeedsRefresh", () => {
  it("is false when expiry is unknown or comfortably in the future", () => {
    expect(accessTokenNeedsRefresh(null)).toBe(false);
    expect(accessTokenNeedsRefresh(Date.now() + 10 * 60_000)).toBe(false);
  });

  it("is true at or inside the 60s skew window", () => {
    const now = 1_000_000;
    expect(accessTokenNeedsRefresh(now + 60_000, now)).toBe(true);
    expect(accessTokenNeedsRefresh(now - 1, now)).toBe(true);
  });
});
