import { describe, it, expect } from "bun:test";
import { Hono } from "hono";
import { apiTokenRoutes } from "../../workers/api/src/routes/api-tokens.js";
import type { Env } from "../../workers/api/src/index.js";

/** Mount /tokens with an injected oauth_ JWT identity (skips the verify path). */
function appWithOAuthAuth(tokenId: string, scopes: string[]) {
  const a = new Hono<Env>();
  a.use("*", (c, next) => {
    c.set("auth", { kind: "token", tokenId, scopes });
    return next();
  });
  a.route("/", apiTokenRoutes);
  return a;
}

describe("GET /tokens/me for OAuth JWT principals (#1733)", () => {
  it("synthesizes an identity from auth context without a DB row", async () => {
    // No DB binding at all — the oauth_ branch must never touch api_tokens/apikey.
    const res = await appWithOAuthAuth("oauth_user_42", ["read", "write"]).request(
      "/tokens/me",
      {},
      {} as Env["Bindings"],
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.kind).toBe("token");
    expect(body.name).toBe("oauth-user");
    expect(body.principalType).toBe("user");
    // <sub> is the owning user id — surfaced under both principalId and userId.
    expect(body.principalId).toBe("user_42");
    expect(body.userId).toBe("user_42");
    expect(body.tokenId).toBe("oauth_user_42");
    expect(body.scopes).toEqual(["read", "write"]);
    expect(body.expiresAt).toBeNull();
    expect(body.lastUsedAt).toBeNull();
  });

  it("handles a machine (m2m) subject with no user id", async () => {
    const res = await appWithOAuthAuth("oauth_m2m", ["read"]).request(
      "/tokens/me",
      {},
      {} as Env["Bindings"],
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.principalId).toBe("m2m");
    expect(body.userId).toBe("m2m");
    expect(body.scopes).toEqual(["read"]);
  });
});
