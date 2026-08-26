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
        },
      },
    });
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
      context: { body: { accept: true, client_id: "c1", scope: "openid read" } },
    });
  });
});
