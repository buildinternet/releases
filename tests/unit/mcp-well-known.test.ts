/**
 * RFC 9728 protected-resource metadata + the WWW-Authenticate challenge helpers
 * for the MCP worker (OAuth discovery surface). The metadata document is derived
 * from the OAuth resource-server env vars (so staging is automatically correct),
 * falling back to the same prod defaults the auth path hard-codes. The challenge
 * helpers build the 401 header that points a client at this metadata.
 */
import { describe, it, expect } from "bun:test";
import {
  buildProtectedResourceMetadata,
  protectedResourceMetadataUrl,
  wwwAuthenticateChallenge,
  isProtectedResourceMetadataPath,
  protectedResourceMetadataResponse,
  PROTECTED_RESOURCE_PATH,
} from "../../workers/mcp/src/well-known.js";
import type { Env } from "../../workers/mcp/src/mcp-agent.js";

function env(overrides: Partial<Env> = {}): Env {
  return { ...overrides } as unknown as Env;
}

describe("buildProtectedResourceMetadata", () => {
  it("derives resource + authorization_servers from the OAuth env vars", () => {
    const doc = buildProtectedResourceMetadata(
      env({
        OAUTH_JWT_AUDIENCE: "https://mcp-staging.releases.sh",
        OAUTH_JWT_ISSUER: "https://api-staging.releases.sh/api/auth",
      }),
    );
    expect(doc.resource).toBe("https://mcp-staging.releases.sh");
    expect(doc.authorization_servers).toEqual(["https://api-staging.releases.sh/api/auth"]);
    expect(doc.scopes_supported).toEqual(["read", "write", "admin"]);
    expect(doc.bearer_methods_supported).toEqual(["header"]);
  });

  it("falls back to prod defaults when the env vars are unset", () => {
    const doc = buildProtectedResourceMetadata(env());
    expect(doc.resource).toBe("https://mcp.releases.sh");
    expect(doc.authorization_servers).toEqual(["https://api.releases.sh/api/auth"]);
  });

  it("advertises the bare-origin resource so it equals the verified aud", () => {
    // The resource the client echoes back as RFC 8707 `resource` must equal the
    // resource server's verified `aud` (OAUTH_JWT_AUDIENCE) or jose rejects the
    // round-tripped token. Guard that they are the same value.
    const audience = "https://mcp.releases.sh";
    const doc = buildProtectedResourceMetadata(env({ OAUTH_JWT_AUDIENCE: audience }));
    expect(doc.resource).toBe(audience);
  });
});

describe("protectedResourceMetadataUrl", () => {
  it("is the request origin + the well-known path (ignores the request path)", () => {
    expect(protectedResourceMetadataUrl("https://mcp.releases.sh/mcp")).toBe(
      `https://mcp.releases.sh${PROTECTED_RESOURCE_PATH}`,
    );
    expect(protectedResourceMetadataUrl("https://mcp-staging.releases.sh/mcp")).toBe(
      `https://mcp-staging.releases.sh${PROTECTED_RESOURCE_PATH}`,
    );
  });
});

describe("wwwAuthenticateChallenge", () => {
  it("is a Bearer challenge carrying invalid_token + the resource_metadata URL", () => {
    const header = wwwAuthenticateChallenge("https://mcp.releases.sh/mcp");
    expect(header).toBe(
      'Bearer error="invalid_token", ' +
        'resource_metadata="https://mcp.releases.sh/.well-known/oauth-protected-resource"',
    );
  });
});

describe("isProtectedResourceMetadataPath", () => {
  it("matches the root path and the /mcp path-suffixed form", () => {
    expect(isProtectedResourceMetadataPath("/.well-known/oauth-protected-resource")).toBe(true);
    expect(isProtectedResourceMetadataPath("/.well-known/oauth-protected-resource/mcp")).toBe(true);
  });

  it("does not match other paths", () => {
    expect(isProtectedResourceMetadataPath("/mcp")).toBe(false);
    expect(isProtectedResourceMetadataPath("/.well-known/oauth-authorization-server")).toBe(false);
    expect(isProtectedResourceMetadataPath("/.well-known/oauth-protected-resource-other")).toBe(
      false,
    );
  });
});

describe("protectedResourceMetadataResponse", () => {
  it("is a 200 JSON response carrying the metadata document", async () => {
    const res = protectedResourceMetadataResponse(env({ OAUTH_JWT_AUDIENCE: "https://mcp.x" }));
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toContain("application/json");
    const doc = (await res.json()) as Record<string, unknown>;
    expect(doc.resource).toBe("https://mcp.x");
  });
});
