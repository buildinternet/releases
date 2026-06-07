import { describe, it, expect } from "bun:test";
import {
  IDENTITY_SCOPES,
  ROLE_LADDER,
  entitledScopes,
  assertScopesEntitled,
  oauthAccessTokenClaims,
  consentScopeViolation,
} from "../src/auth/entitlement.js";

describe("entitledScopes", () => {
  it("gives identity + read to a plain user", () => {
    expect(entitledScopes("user")).toEqual([...IDENTITY_SCOPES, "read"]);
  });
  it("gives read+write to a curator", () => {
    expect(entitledScopes("curator")).toEqual([...IDENTITY_SCOPES, "read", "write"]);
  });
  it("gives the full ladder to an admin", () => {
    expect(entitledScopes("admin")).toEqual([...IDENTITY_SCOPES, "read", "write", "admin"]);
  });
  it("fails closed for null/unknown roles → read-only", () => {
    expect(entitledScopes(null)).toEqual([...IDENTITY_SCOPES, "read"]);
    expect(entitledScopes(undefined)).toEqual([...IDENTITY_SCOPES, "read"]);
    expect(entitledScopes("wizard")).toEqual([...IDENTITY_SCOPES, "read"]);
  });
  it("unions ladders for a comma-separated multi-role", () => {
    expect(entitledScopes("user,curator")).toEqual([...IDENTITY_SCOPES, "read", "write"]);
  });
  it("treats empty-string role as read-only (fail-closed)", () => {
    expect(entitledScopes("")).toEqual([...IDENTITY_SCOPES, "read"]);
  });
  it("an unknown role inside a multi-role string degrades to read-only for that token", () => {
    expect(entitledScopes("user,wizard")).toEqual([...IDENTITY_SCOPES, "read"]);
  });
});

describe("assertScopesEntitled", () => {
  it("passes when requested ⊆ entitled", () => {
    expect(() => assertScopesEntitled("curator", ["openid", "read", "write"])).not.toThrow();
  });
  it("throws when a user requests write", () => {
    expect(() => assertScopesEntitled("user", ["read", "write"])).toThrow(/write/);
  });
  it("allows identity scopes for everyone", () => {
    expect(() => assertScopesEntitled("user", [...IDENTITY_SCOPES])).not.toThrow();
  });
});

describe("oauthAccessTokenClaims", () => {
  it("stamps the role claim for a user-bound token", () => {
    expect(
      oauthAccessTokenClaims({ user: { role: "curator" }, scopes: ["read", "write"] }),
    ).toEqual({
      "https://releases.sh/role": "curator",
    });
  });
  it("defaults the role claim to user when role is absent", () => {
    expect(oauthAccessTokenClaims({ user: { role: null }, scopes: ["read"] })).toEqual({
      "https://releases.sh/role": "user",
    });
  });
  it("throws (fail-closed) when a user-bound token exceeds entitlement", () => {
    expect(() =>
      oauthAccessTokenClaims({ user: { role: "user" }, scopes: ["read", "admin"] }),
    ).toThrow();
  });
  it("skips the entitlement check for M2M tokens (user undefined)", () => {
    expect(oauthAccessTokenClaims({ scopes: ["read", "write", "admin"] })).toEqual({});
  });
  it("denies a deleted user (user null) beyond read", () => {
    expect(() => oauthAccessTokenClaims({ user: null, scopes: ["write"] })).toThrow();
  });
});

describe("consentScopeViolation", () => {
  it("flags a user granting write", () => {
    expect(consentScopeViolation("user", { accept: true, scope: "read write" })).toBe(true);
  });
  it("passes a curator granting read+write", () => {
    expect(consentScopeViolation("curator", { accept: true, scope: "openid read write" })).toBe(
      false,
    );
  });
  it("ignores deny submissions", () => {
    expect(consentScopeViolation("user", { accept: false, scope: "read write" })).toBe(false);
  });
  it("passes when scope is omitted (token backstop catches over-broad)", () => {
    expect(consentScopeViolation("user", { accept: true })).toBe(false);
  });
});
