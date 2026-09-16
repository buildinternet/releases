import { describe, expect, it } from "bun:test";
import { DCR_SCOPES } from "./entitlement.js";
import {
  capDcrScopes,
  clampDcrRegistrationResult,
  dcrClientRowPatch,
  registrationScopesIncludePrivileged,
  sanitizeDcrRegistrationBody,
} from "./oauth-dcr.js";

describe("capDcrScopes", () => {
  it("defaults to the DCR allowlist when scope is omitted or empty", () => {
    expect(capDcrScopes(undefined)).toEqual([...DCR_SCOPES]);
    expect(capDcrScopes("")).toEqual([...DCR_SCOPES]);
    expect(capDcrScopes([])).toEqual([...DCR_SCOPES]);
  });

  it("drops admin and write from a space-delimited request", () => {
    expect(capDcrScopes("openid profile email offline_access read write admin")).toEqual([
      ...DCR_SCOPES,
    ]);
  });

  it("drops admin from a scope array and keeps a non-empty subset", () => {
    expect(capDcrScopes(["openid", "admin", "read"])).toEqual(["openid", "read"]);
  });

  it("ignores a request that is only privileged scopes (does not grant them)", () => {
    expect(capDcrScopes("admin write")).toEqual([...DCR_SCOPES]);
    expect(capDcrScopes(["admin"])).toEqual([...DCR_SCOPES]);
  });
});

describe("sanitizeDcrRegistrationBody", () => {
  it("forces a confidential registration onto public PKCE", () => {
    expect(
      sanitizeDcrRegistrationBody({
        client_name: "probe-alpha",
        redirect_uris: ["https://attacker.example.com/cb"],
        token_endpoint_auth_method: "client_secret_basic",
        scope: "openid profile email offline_access read write admin",
      }),
    ).toEqual({
      client_name: "probe-alpha",
      redirect_uris: ["https://attacker.example.com/cb"],
      token_endpoint_auth_method: "none",
      scope: DCR_SCOPES.join(" "),
    });
  });

  it("forces none when token_endpoint_auth_method is omitted", () => {
    expect(
      sanitizeDcrRegistrationBody({
        client_name: "MCP Inspector",
        redirect_uris: ["https://app.example.com/callback"],
      }),
    ).toEqual({
      client_name: "MCP Inspector",
      redirect_uris: ["https://app.example.com/callback"],
      token_endpoint_auth_method: "none",
    });
  });

  it("strips skip_consent, trusted, secrets, and private_key_jwt material", () => {
    const out = sanitizeDcrRegistrationBody({
      client_name: "Evil",
      token_endpoint_auth_method: "private_key_jwt",
      skip_consent: true,
      trusted: true,
      client_secret: "reloc_forged",
      jwks: { keys: [] },
      client_credentials_scopes: ["admin"],
    });
    expect(out).toEqual({
      client_name: "Evil",
      token_endpoint_auth_method: "none",
    });
    expect(out).not.toHaveProperty("skip_consent");
    expect(out).not.toHaveProperty("trusted");
    expect(out).not.toHaveProperty("client_secret");
    expect(out).not.toHaveProperty("jwks");
    expect(out).not.toHaveProperty("client_credentials_scopes");
  });

  it("drops client_credentials from advertised grant_types", () => {
    expect(
      sanitizeDcrRegistrationBody({
        token_endpoint_auth_method: "none",
        grant_types: ["authorization_code", "refresh_token", "client_credentials"],
      }),
    ).toEqual({
      token_endpoint_auth_method: "none",
      grant_types: ["authorization_code", "refresh_token"],
    });
  });

  it("leaves an already-public MCP body alone", () => {
    expect(
      sanitizeDcrRegistrationBody({
        client_name: "MCP Inspector",
        redirect_uris: ["https://app.example.com/callback"],
        token_endpoint_auth_method: "none",
      }),
    ).toBeUndefined();
  });
});

describe("dcrClientRowPatch / registration result clamp", () => {
  it("never stores skip_consent, a secret-bearing auth method, or privileged scopes", () => {
    expect(dcrClientRowPatch(["openid", "read", "write", "admin"])).toEqual({
      scopes: ["openid", "read"],
      skipConsent: false,
      tokenEndpointAuthMethod: "none",
      public: true,
      requirePKCE: true,
      clientCredentialsScopes: null,
    });
  });

  it("rewrites a 201 body so it cannot return admin or a client_secret", () => {
    const returned = {
      client_id: "abc",
      client_secret: "reloc_leaked",
      client_secret_expires_at: 0,
      scope: "openid read write admin",
      token_endpoint_auth_method: "client_secret_basic",
    };
    expect(clampDcrRegistrationResult(returned)).toBe("abc");
    expect(returned.scope).toBe(DCR_SCOPES.join(" "));
    expect(returned.token_endpoint_auth_method).toBe("none");
    expect("client_secret" in returned).toBe(false);
    expect("client_secret_expires_at" in returned).toBe(false);
  });

  it("ignores errors and raw Response objects", () => {
    expect(clampDcrRegistrationResult(new Error("nope"))).toBeUndefined();
    expect(clampDcrRegistrationResult(new Response("{}", { status: 201 }))).toBeUndefined();
  });

  it("flags privileged scope lists", () => {
    expect(registrationScopesIncludePrivileged("read write")).toBe(true);
    expect(registrationScopesIncludePrivileged(["openid", "admin"])).toBe(true);
    expect(registrationScopesIncludePrivileged(DCR_SCOPES)).toBe(false);
  });
});
