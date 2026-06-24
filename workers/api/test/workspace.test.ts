import { describe, it, expect } from "bun:test";
import { deriveWorkspaceName, personalWorkspaceSlug } from "../src/auth/workspace.js";

describe("deriveWorkspaceName", () => {
  it("uses the first token of a multi-word name", () => {
    expect(deriveWorkspaceName({ name: "Ann Smith", email: "ann@example.com" })).toBe(
      "Ann's Workspace",
    );
  });
  it("uses a single-word name as-is", () => {
    expect(deriveWorkspaceName({ name: "Ann", email: "ann@example.com" })).toBe("Ann's Workspace");
  });
  it("falls back to the email local-part when name is empty", () => {
    expect(deriveWorkspaceName({ name: "", email: "bea.long@example.com" })).toBe(
      "bea.long's Workspace",
    );
  });
  it("falls back to a generic name when neither is present", () => {
    expect(deriveWorkspaceName(null)).toBe("Personal Workspace");
    expect(deriveWorkspaceName({ name: "   ", email: null })).toBe("Personal Workspace");
  });
});

describe("personalWorkspaceSlug", () => {
  it("is deterministic and namespaced by user id", () => {
    expect(personalWorkspaceSlug("u_abc123")).toBe("ws-u_abc123");
    expect(personalWorkspaceSlug("u_abc123")).toBe(personalWorkspaceSlug("u_abc123"));
  });
  it("differs per user", () => {
    expect(personalWorkspaceSlug("u_a")).not.toBe(personalWorkspaceSlug("u_b"));
  });
});
