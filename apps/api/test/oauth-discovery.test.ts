import { describe, it, expect } from "bun:test";
import { createTestDb } from "./setup";
import { createAuth } from "../src/auth/index.js";
import { DCR_GRANT_TYPES } from "../src/auth/oauth-dcr.js";
import {
  buildApiProtectedResourceMetadata,
  clampDiscoveryMetadata,
  forwardWellKnown,
} from "../src/oauth-discovery";

/**
 * RFC 9728 protected-resource metadata for the REST API worker (#1483 — the API
 * is itself an OAuth resource server). Derived from BETTER_AUTH_URL so staging is
 * automatically correct; falls back to the prod origin the auth path hard-codes.
 * Mirrors the MCP worker's well-known builder so the two surfaces never disagree.
 */
describe("buildApiProtectedResourceMetadata", () => {
  it("derives resource + authorization_servers from BETTER_AUTH_URL origin", () => {
    const doc = buildApiProtectedResourceMetadata({
      BETTER_AUTH_URL: "https://api.releasenotesindex.dev/api/auth",
    });
    expect(doc.resource).toBe("https://api.releasenotesindex.dev");
    expect(doc.authorization_servers).toEqual(["https://api.releasenotesindex.dev/api/auth"]);
    expect(doc.scopes_supported).toEqual(["read", "write", "admin"]);
    expect(doc.bearer_methods_supported).toEqual(["header"]);
  });

  it("falls back to the prod origin when BETTER_AUTH_URL is unset", () => {
    const doc = buildApiProtectedResourceMetadata({});
    expect(doc.resource).toBe("https://api.releases.sh");
    expect(doc.authorization_servers).toEqual(["https://api.releases.sh/api/auth"]);
  });

  it("falls back to the prod origin when BETTER_AUTH_URL is malformed", () => {
    const doc = buildApiProtectedResourceMetadata({ BETTER_AUTH_URL: "not a url" });
    expect(doc.resource).toBe("https://api.releases.sh");
  });

  it("uses only the origin, dropping any path on BETTER_AUTH_URL", () => {
    // BETTER_AUTH_URL carries the /api/auth basePath, but the resource identifier
    // (the verified `aud`) is the bare origin — the issuer alone gets the basePath.
    const doc = buildApiProtectedResourceMetadata({
      BETTER_AUTH_URL: "https://api.releases.sh/api/auth",
    });
    expect(doc.resource).toBe("https://api.releases.sh");
    expect(doc.authorization_servers).toEqual(["https://api.releases.sh/api/auth"]);
  });

  it("advertises a resource equal to the verifier's audience (origin)", () => {
    // The resource server's JWT config (middleware/auth.ts oauthJwtConfig) uses
    // the bare BETTER_AUTH_URL origin as `audience`. The advertised `resource`
    // must equal it or a round-tripped RFC 8707 token's aud won't verify.
    const doc = buildApiProtectedResourceMetadata({ BETTER_AUTH_URL: "https://api.releases.sh" });
    expect(doc.resource).toBe("https://api.releases.sh");
  });
});

const LIBRARY_TOKEN_AUTH_METHODS = [
  "none",
  "client_secret_basic",
  "client_secret_post",
  "private_key_jwt",
] as const;

const LIBRARY_ENDPOINT_AUTH_METHODS = [
  "client_secret_basic",
  "client_secret_post",
  "private_key_jwt",
] as const;

/** Better Auth's default `grant_types_supported`, including M2M. */
const LIBRARY_GRANT_TYPES = ["authorization_code", "client_credentials", "refresh_token"] as const;

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", "content-length": "1" },
  });
}

describe("clampDiscoveryMetadata", () => {
  it("collapses the library default to public DCR and leaves the other method lists", async () => {
    const upstream = jsonResponse({
      issuer: "https://api.releases.localhost/api/auth",
      token_endpoint_auth_methods_supported: [...LIBRARY_TOKEN_AUTH_METHODS],
      token_endpoint_auth_signing_alg_values_supported: ["RS256", "EdDSA"],
      grant_types_supported: [...LIBRARY_GRANT_TYPES],
      response_types_supported: ["code"],
      introspection_endpoint_auth_methods_supported: [...LIBRARY_ENDPOINT_AUTH_METHODS],
      revocation_endpoint_auth_methods_supported: [...LIBRARY_ENDPOINT_AUTH_METHODS],
    });
    const res = await clampDiscoveryMetadata(
      "https://api.releases.localhost/api/auth/.well-known/oauth-authorization-server",
      upstream,
    );
    expect(res).not.toBe(upstream);
    expect(res.headers.get("content-length")).toBeNull();
    const body = (await res.json()) as {
      issuer?: string;
      token_endpoint_auth_methods_supported?: string[];
      token_endpoint_auth_signing_alg_values_supported?: string[];
      grant_types_supported?: string[];
      response_types_supported?: string[];
      introspection_endpoint_auth_methods_supported?: string[];
      revocation_endpoint_auth_methods_supported?: string[];
    };
    expect(body.issuer).toBe("https://api.releases.localhost/api/auth");
    expect(body.token_endpoint_auth_methods_supported).toEqual(["none"]);
    expect(body.grant_types_supported).toEqual([...DCR_GRANT_TYPES]);
    expect(body.grant_types_supported).not.toContain("client_credentials");
    expect(body.response_types_supported).toEqual(["code"]);
    expect(body.token_endpoint_auth_signing_alg_values_supported).toEqual(["RS256", "EdDSA"]);
    expect(body.introspection_endpoint_auth_methods_supported).toEqual([
      ...LIBRARY_ENDPOINT_AUTH_METHODS,
    ]);
    expect(body.revocation_endpoint_auth_methods_supported).toEqual([
      ...LIBRARY_ENDPOINT_AUTH_METHODS,
    ]);
  });

  it("still drops client_credentials when the auth-method list is already public", async () => {
    const res = await clampDiscoveryMetadata(
      "https://api.releases.localhost/api/auth/.well-known/oauth-authorization-server",
      jsonResponse({
        token_endpoint_auth_methods_supported: ["none"],
        grant_types_supported: [...LIBRARY_GRANT_TYPES],
      }),
    );
    const body = (await res.json()) as {
      token_endpoint_auth_methods_supported?: string[];
      grant_types_supported?: string[];
    };
    expect(body.token_endpoint_auth_methods_supported).toEqual(["none"]);
    expect(body.grant_types_supported).toEqual([...DCR_GRANT_TYPES]);
  });

  it("fills omitted lists (RFC 8414 defaults are client_secret_basic and authorization_code)", async () => {
    const res = await clampDiscoveryMetadata(
      "https://api.releases.localhost/.well-known/openid-configuration/api/auth",
      jsonResponse({ issuer: "https://api.releases.localhost/api/auth" }),
    );
    const body = (await res.json()) as {
      token_endpoint_auth_methods_supported?: string[];
      grant_types_supported?: string[];
    };
    expect(body.token_endpoint_auth_methods_supported).toEqual(["none"]);
    expect(body.grant_types_supported).toEqual([...DCR_GRANT_TYPES]);
  });

  it("returns the same response when the document already matches open DCR", async () => {
    const upstream = jsonResponse({
      token_endpoint_auth_methods_supported: ["none"],
      grant_types_supported: [...DCR_GRANT_TYPES],
      introspection_endpoint_auth_methods_supported: [...LIBRARY_ENDPOINT_AUTH_METHODS],
    });
    const res = await clampDiscoveryMetadata(
      "https://api.releases.localhost/api/auth/.well-known/openid-configuration",
      upstream,
    );
    expect(res).toBe(upstream);
    expect(upstream.bodyUsed).toBe(false);
  });

  it("does not read a non-discovery or non-OK body", async () => {
    const session = jsonResponse({
      token_endpoint_auth_methods_supported: [...LIBRARY_TOKEN_AUTH_METHODS],
      grant_types_supported: [...LIBRARY_GRANT_TYPES],
    });
    const protectedResource = jsonResponse({
      token_endpoint_auth_methods_supported: [...LIBRARY_TOKEN_AUTH_METHODS],
      grant_types_supported: [...LIBRARY_GRANT_TYPES],
    });
    const missing = jsonResponse(
      {
        token_endpoint_auth_methods_supported: [...LIBRARY_TOKEN_AUTH_METHODS],
        grant_types_supported: [...LIBRARY_GRANT_TYPES],
      },
      404,
    );
    expect(
      await clampDiscoveryMetadata("https://api.releases.localhost/api/auth/get-session", session),
    ).toBe(session);
    expect(
      await clampDiscoveryMetadata(
        "https://api.releases.localhost/.well-known/oauth-protected-resource",
        protectedResource,
      ),
    ).toBe(protectedResource);
    expect(
      await clampDiscoveryMetadata(
        "https://api.releases.localhost/api/auth/.well-known/oauth-authorization-server",
        missing,
      ),
    ).toBe(missing);
    expect(session.bodyUsed).toBe(false);
    expect(protectedResource.bodyUsed).toBe(false);
    expect(missing.bodyUsed).toBe(false);
  });
});

describe("live OAuth discovery for open registration", () => {
  const baseEnv = {
    BETTER_AUTH_URL: "https://api.releases.localhost",
    BETTER_AUTH_SECRET: "test-secret-do-not-use-in-prod-0123456789",
  } as never;

  it("serves public DCR grants and auth methods on every discovery path", async () => {
    const auth = await createAuth(baseEnv, undefined, {
      db: createTestDb(),
      sendEmail: () => {},
    });
    const origin = "https://api.releases.localhost";
    const raw = await auth.handler(
      new Request(`${origin}/api/auth/.well-known/oauth-authorization-server`),
    );
    expect(raw.status).toBe(200);
    const rawMeta = (await raw.json()) as {
      token_endpoint_auth_methods_supported?: string[];
      grant_types_supported?: string[];
      introspection_endpoint_auth_methods_supported?: string[];
      revocation_endpoint_auth_methods_supported?: string[];
      token_endpoint_auth_signing_alg_values_supported?: string[];
      scopes_supported?: string[];
    };
    // The clamp is load-bearing: the plugin still advertises confidential methods and M2M.
    expect(rawMeta.token_endpoint_auth_methods_supported).toEqual(
      expect.arrayContaining([...LIBRARY_TOKEN_AUTH_METHODS]),
    );
    expect(rawMeta.grant_types_supported).toContain("client_credentials");

    const clamped = await clampDiscoveryMetadata(
      `${origin}/api/auth/.well-known/oauth-authorization-server`,
      await auth.handler(new Request(`${origin}/api/auth/.well-known/oauth-authorization-server`)),
    );
    const meta = (await clamped.json()) as typeof rawMeta;
    expect(meta.token_endpoint_auth_methods_supported).toEqual(["none"]);
    expect(meta.grant_types_supported).toEqual([...DCR_GRANT_TYPES]);
    expect(meta.introspection_endpoint_auth_methods_supported).toEqual(
      rawMeta.introspection_endpoint_auth_methods_supported,
    );
    expect(meta.revocation_endpoint_auth_methods_supported).toEqual(
      rawMeta.revocation_endpoint_auth_methods_supported,
    );
    expect(meta.token_endpoint_auth_signing_alg_values_supported).toEqual(
      rawMeta.token_endpoint_auth_signing_alg_values_supported,
    );
    expect(meta.scopes_supported).toEqual(expect.arrayContaining(["read", "write", "admin"]));

    const oidcRaw = await auth.handler(
      new Request(`${origin}/api/auth/.well-known/openid-configuration`),
    );
    expect(oidcRaw.status).toBe(200);
    const oidcClamped = await clampDiscoveryMetadata(
      `${origin}/api/auth/.well-known/openid-configuration`,
      await auth.handler(new Request(`${origin}/api/auth/.well-known/openid-configuration`)),
    );
    const oidc = (await oidcClamped.json()) as typeof rawMeta;
    expect(oidc.token_endpoint_auth_methods_supported).toEqual(["none"]);
    expect(oidc.grant_types_supported).toEqual([...DCR_GRANT_TYPES]);

    for (const url of [
      `${origin}/.well-known/oauth-authorization-server`,
      `${origin}/.well-known/oauth-authorization-server/api/auth`,
      `${origin}/.well-known/openid-configuration`,
      `${origin}/.well-known/openid-configuration/api/auth`,
    ]) {
      const wellKnown = url.includes("openid-configuration")
        ? "openid-configuration"
        : "oauth-authorization-server";
      const res = await forwardWellKnown(auth, wellKnown, url, new Headers());
      expect(res.status).toBe(200);
      expect(res.headers.get("access-control-allow-origin")).toBe("*");
      const body = (await res.json()) as typeof rawMeta;
      expect(body.token_endpoint_auth_methods_supported).toEqual(["none"]);
      expect(body.grant_types_supported).toEqual([...DCR_GRANT_TYPES]);
      expect(body.introspection_endpoint_auth_methods_supported).toEqual(
        rawMeta.introspection_endpoint_auth_methods_supported,
      );
      expect(body.revocation_endpoint_auth_methods_supported).toEqual(
        rawMeta.revocation_endpoint_auth_methods_supported,
      );
    }
  });
});
