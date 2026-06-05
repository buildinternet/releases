import { describe, it, expect } from "bun:test";
import {
  API_PERMISSION_RESOURCE,
  scopeToPermissions,
  apiScopesFromPermissions,
} from "../../workers/api/src/auth/api-key-scope.js";
import { scopeSatisfies } from "@buildinternet/releases-core/api-token";

describe("scopeToPermissions", () => {
  it("expands a ladder scope to cumulative actions on the api resource", () => {
    expect(scopeToPermissions("read")).toEqual({ [API_PERMISSION_RESOURCE]: ["read"] });
    expect(scopeToPermissions("write")).toEqual({ [API_PERMISSION_RESOURCE]: ["read", "write"] });
    expect(scopeToPermissions("admin")).toEqual({
      [API_PERMISSION_RESOURCE]: ["read", "write", "admin"],
    });
  });
});

describe("apiScopesFromPermissions", () => {
  it("reads the api actions back as a scopes array usable by scopeSatisfies", () => {
    const perms = scopeToPermissions("write");
    const scopes = apiScopesFromPermissions(perms);
    expect(scopes).toEqual(["read", "write"]);
    expect(scopeSatisfies(scopes, "write")).toBe(true);
    expect(scopeSatisfies(scopes, "admin")).toBe(false);
  });

  it("returns [] for missing/garbage permissions (caller denies on empty)", () => {
    expect(apiScopesFromPermissions(null)).toEqual([]);
    expect(apiScopesFromPermissions({})).toEqual([]);
    expect(apiScopesFromPermissions({ other: ["read"] })).toEqual([]);
  });
});
