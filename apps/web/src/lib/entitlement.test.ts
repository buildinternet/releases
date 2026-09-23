import { describe, it, expect } from "bun:test";
import { displayScopes, SCOPE_LABELS, IDENTITY_SCOPES, ROLE_LADDER } from "./entitlement";

describe("displayScopes", () => {
  it("filters requested scopes to those the role is entitled to", () => {
    expect(displayScopes("user", ["openid", "read", "write"])).toEqual(["openid", "read"]);
    expect(displayScopes("curator", ["openid", "read", "write", "admin"])).toEqual([
      "openid",
      "read",
      "write",
    ]);
  });
  it("fails closed for unknown roles → identity + read only", () => {
    expect(displayScopes(null, ["openid", "read", "write", "admin"])).toEqual(["openid", "read"]);
  });
  it("unions ladders for a comma-separated multi-role", () => {
    expect(displayScopes("user,curator", ["read", "write", "admin"])).toEqual(["read", "write"]);
  });
  it("has a label for every grantable scope", () => {
    const ladderScopes = [...new Set(Object.values(ROLE_LADDER).flat())];
    for (const s of [...IDENTITY_SCOPES, ...ladderScopes]) {
      expect(SCOPE_LABELS[s]).toBeDefined();
    }
  });
});
