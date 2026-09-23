// web/src/lib/workspace-permissions.test.ts
import { describe, expect, test } from "bun:test";
import { isManager, roleToggleTarget, canActOnMember } from "./workspace-permissions";

describe("isManager", () => {
  test("owner and admin are managers", () => {
    expect(isManager("owner")).toBe(true);
    expect(isManager("admin")).toBe(true);
  });
  test("member, unknown, and nullish are not", () => {
    expect(isManager("member")).toBe(false);
    expect(isManager("guest")).toBe(false);
    expect(isManager(null)).toBe(false);
    expect(isManager(undefined)).toBe(false);
  });
});

describe("roleToggleTarget", () => {
  test("member <-> admin toggle", () => {
    expect(roleToggleTarget("member")).toBe("admin");
    expect(roleToggleTarget("admin")).toBe("member");
  });
  test("owner and unknown have no toggle", () => {
    expect(roleToggleTarget("owner")).toBeNull();
    expect(roleToggleTarget("whatever")).toBeNull();
  });
});

describe("canActOnMember", () => {
  test("manager may act on a non-owner member that is not themselves", () => {
    expect(canActOnMember("owner", "member", false)).toBe(true);
    expect(canActOnMember("admin", "admin", false)).toBe(true);
  });
  test("cannot act on yourself", () => {
    expect(canActOnMember("owner", "member", true)).toBe(false);
  });
  test("cannot act on an owner row", () => {
    expect(canActOnMember("admin", "owner", false)).toBe(false);
  });
  test("non-managers cannot act on anyone", () => {
    expect(canActOnMember("member", "member", false)).toBe(false);
  });
});
