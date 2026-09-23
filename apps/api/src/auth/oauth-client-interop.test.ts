import { describe, expect, it } from "bun:test";
import { applyOAuthClientInterop } from "./oauth-client-interop.js";
import { OAUTH_SCOPES } from "./entitlement.js";

const DEVICE_CODE = "urn:ietf:params:oauth:grant-type:device_code";

describe("applyOAuthClientInterop", () => {
  it("rewrites extra DCR grant_types on /oauth2/register", async () => {
    const out = await applyOAuthClientInterop(
      {
        path: "/oauth2/register",
        body: {
          client_name: "MCPJam",
          grant_types: ["authorization_code", "refresh_token", DEVICE_CODE],
        },
      },
      async () => OAUTH_SCOPES,
    );
    expect(out).toEqual({
      context: {
        body: {
          client_name: "MCPJam",
          grant_types: ["authorization_code", "refresh_token"],
          token_endpoint_auth_method: "none",
        },
      },
    });
  });

  it("applies both grant_types intersection and application_type default in one register body", async () => {
    const out = await applyOAuthClientInterop(
      {
        path: "/oauth2/register",
        body: {
          client_name: "opencode-like",
          grant_types: ["authorization_code", "refresh_token", DEVICE_CODE],
          redirect_uris: ["http://127.0.0.1:19876/mcp/oauth/callback"],
        },
      },
      async () => OAUTH_SCOPES,
    );
    expect(out).toEqual({
      context: {
        body: {
          client_name: "opencode-like",
          grant_types: ["authorization_code", "refresh_token"],
          redirect_uris: ["http://127.0.0.1:19876/mcp/oauth/callback"],
          application_type: "native",
          token_endpoint_auth_method: "none",
        },
      },
    });
  });

  it("returns void for an already-public MCP register body", async () => {
    const out = await applyOAuthClientInterop(
      {
        path: "/oauth2/register",
        body: {
          client_name: "Plain Web Client",
          grant_types: ["authorization_code", "refresh_token"],
          redirect_uris: ["https://app.example.com/callback"],
          application_type: "web",
          token_endpoint_auth_method: "none",
        },
      },
      async () => OAUTH_SCOPES,
    );
    expect(out).toBeUndefined();
  });

  it("strips admin/write and skip_consent from a hostile DCR body", async () => {
    const out = await applyOAuthClientInterop(
      {
        path: "/oauth2/register",
        body: {
          client_name: "probe-alpha",
          redirect_uris: ["https://attacker.example.com/cb"],
          token_endpoint_auth_method: "client_secret_post",
          skip_consent: true,
          scope: "openid read write admin",
        },
      },
      async () => OAUTH_SCOPES,
    );
    expect(out?.context.body).toMatchObject({
      token_endpoint_auth_method: "none",
      scope: "openid read",
    });
    expect(out?.context.body).not.toHaveProperty("skip_consent");
  });

  it("downscopes kitchen-sink authorize scope= to the registered list", async () => {
    const out = await applyOAuthClientInterop(
      {
        path: "/oauth2/authorize",
        query: { client_id: "c1", scope: "openid read write admin extra" },
      },
      async (id) => {
        expect(id).toBe("c1");
        return ["openid", "read"];
      },
    );
    expect(out).toEqual({
      context: { query: { client_id: "c1", scope: "openid read" } },
    });
  });

  it("downscopes consent for a non-admin role", async () => {
    const out = await applyOAuthClientInterop(
      {
        path: "/oauth2/consent",
        body: { accept: true, client_id: "c1", scope: "openid read write admin" },
      },
      async () => [...OAUTH_SCOPES],
      "user",
    );
    expect(out).toEqual({
      context: { body: { accept: true, client_id: "c1", scope: "openid read offline_access" } },
    });
  });
});
