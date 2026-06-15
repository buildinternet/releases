import { describe, it, expect } from "bun:test";
import { computeIsAdmin } from "./admin-only";

describe("computeIsAdmin", () => {
  it("true for an admin-role session", () => {
    expect(computeIsAdmin("admin", false)).toBe(true);
  });
  it("false for a non-admin session", () => {
    expect(computeIsAdmin("user", false)).toBe(false);
    expect(computeIsAdmin("curator", false)).toBe(false);
    expect(computeIsAdmin(null, false)).toBe(false);
    expect(computeIsAdmin(undefined, false)).toBe(false);
  });
  it("true when the dev override is set, regardless of role", () => {
    expect(computeIsAdmin(null, true)).toBe(true);
    expect(computeIsAdmin("user", true)).toBe(true);
  });
});
