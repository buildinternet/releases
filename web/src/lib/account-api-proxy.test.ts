import { describe, it, expect } from "bun:test";
import { isAccountOrganizationId } from "./account-organization-id.js";

describe("isAccountOrganizationId", () => {
  it("accepts Better Auth organization ids", () => {
    expect(isAccountOrganizationId("ArGPQ08eSQCdVcsnKbNwvq7FdIcJCYzL")).toBe(true);
  });

  it("rejects empty and pathological ids", () => {
    expect(isAccountOrganizationId("")).toBe(false);
    expect(isAccountOrganizationId("../escape")).toBe(false);
    expect(isAccountOrganizationId("a".repeat(100))).toBe(false);
  });
});
