import { describe, it, expect } from "bun:test";
import { buildApiProtectedResourceMetadata } from "../src/oauth-discovery";

/**
 * RFC 9728 protected-resource metadata for the REST API worker (#1483 — the API
 * is itself an OAuth resource server). Derived from BETTER_AUTH_URL so staging is
 * automatically correct; falls back to the prod origin the auth path hard-codes.
 * Mirrors the MCP worker's well-known builder so the two surfaces never disagree.
 */
describe("buildApiProtectedResourceMetadata", () => {
  it("derives resource + authorization_servers from BETTER_AUTH_URL origin", () => {
    const doc = buildApiProtectedResourceMetadata({
      BETTER_AUTH_URL: "https://api-staging.releases.sh/api/auth",
    });
    expect(doc.resource).toBe("https://api-staging.releases.sh");
    expect(doc.authorization_servers).toEqual(["https://api-staging.releases.sh/api/auth"]);
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
