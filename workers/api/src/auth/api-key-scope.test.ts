import { describe, it, expect } from "bun:test";
import {
  clampUserKeyScopes,
  isWithinUserKeyCeiling,
  USER_API_KEY_MAX_SCOPE,
} from "./api-key-scope.js";
import { scopeSatisfies } from "@buildinternet/releases-core/api-token";

describe("clampUserKeyScopes (user-key read-only ceiling)", () => {
  it("passes a read-only key through unchanged", () => {
    expect(clampUserKeyScopes(["read"])).toEqual(["read"]);
  });

  it("strips write from a read+write key, leaving read", () => {
    expect(clampUserKeyScopes(["read", "write"])).toEqual(["read"]);
  });

  it("strips write+admin from a full key, leaving read", () => {
    expect(clampUserKeyScopes(["read", "write", "admin"])).toEqual(["read"]);
  });

  it("denies (empty) a key that carries no read scope", () => {
    expect(clampUserKeyScopes([])).toEqual([]);
    expect(clampUserKeyScopes(["write"])).toEqual([]);
  });

  it("exposes a read ceiling", () => {
    expect(USER_API_KEY_MAX_SCOPE).toBe("read");
  });

  it("clamped scopes satisfy read but never write or admin", () => {
    const clamped = clampUserKeyScopes(["read", "write", "admin"]);
    expect(scopeSatisfies(clamped, "read")).toBe(true);
    expect(scopeSatisfies(clamped, "write")).toBe(false);
    expect(scopeSatisfies(clamped, "admin")).toBe(false);
  });
});

describe("isWithinUserKeyCeiling (mint admission, ceiling-aware)", () => {
  it("admits the ceiling scope (read)", () => {
    expect(isWithinUserKeyCeiling("read")).toBe(true);
  });

  it("refuses scopes above the ceiling", () => {
    expect(isWithinUserKeyCeiling("write")).toBe(false);
    expect(isWithinUserKeyCeiling("admin")).toBe(false);
  });

  it("refuses non-scope / non-string values", () => {
    expect(isWithinUserKeyCeiling("owner")).toBe(false);
    expect(isWithinUserKeyCeiling(undefined)).toBe(false);
    expect(isWithinUserKeyCeiling(42)).toBe(false);
  });
});
