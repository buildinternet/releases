import { describe, it, expect } from "bun:test";
import { isAccountOrganizationId } from "./account-organization-id.js";
import { isCloudflareChallengeBody } from "./cloudflare-challenge.js";

describe("isCloudflareChallengeBody", () => {
  it("detects managed challenge HTML", () => {
    const html = "<!DOCTYPE html><title>Just a moment...</title>";
    const body = new TextEncoder().encode(html).buffer;
    expect(isCloudflareChallengeBody("text/html; charset=UTF-8", body)).toBe(true);
  });

  it("ignores JSON API errors", () => {
    const json = '{"error":"forbidden","message":"Owner or admin required"}';
    const body = new TextEncoder().encode(json).buffer;
    expect(isCloudflareChallengeBody("application/json", body)).toBe(false);
  });
});

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
