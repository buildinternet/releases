import { describe, it, expect } from "bun:test";
import { computeOrgIdentityUpdates } from "./reconcile-org.js";
import type { ReleasesJsonConfig } from "@buildinternet/releases-api-types";

// resolveCategory stub: accept known slugs, reject everything else.
const resolveCategory = (input: string) =>
  ["developer-tools", "cloud", "ai"].includes(input) ? input : null;

function org(over: Partial<Record<string, unknown>> = {}) {
  return {
    name: "Acme",
    description: null,
    category: null,
    avatarUrl: null,
    metadata: "{}",
    ...over,
  } as any;
}

describe("computeOrgIdentityUpdates", () => {
  it("fills empty fields and marks them self-declared", () => {
    const cfg: ReleasesJsonConfig = {
      version: 2,
      description: "CI for teams.",
      category: "developer-tools",
    };
    const plan = computeOrgIdentityUpdates(org(), cfg, { resolveCategory });
    expect(plan.columnUpdates.description).toBe("CI for teams.");
    expect(plan.columnUpdates.category).toBe("developer-tools");
    expect(plan.selfDeclaredFields.sort()).toEqual(["category", "description"]);
  });

  it("never clobbers a curator-set field (non-empty, not self-declared)", () => {
    const plan = computeOrgIdentityUpdates(
      org({ description: "Curator wrote this" }),
      { version: 2, description: "owner override" },
      { resolveCategory },
    );
    expect(plan.columnUpdates.description).toBeUndefined();
    expect(plan.skipped).toContain("description");
  });

  it("updates a field that was previously self-declared", () => {
    const meta = JSON.stringify({
      selfDeclared: {
        fields: ["description"],
        source: "well-known",
        configHash: "x",
        syncedAt: "x",
      },
    });
    const plan = computeOrgIdentityUpdates(
      org({ description: "old owner value", metadata: meta }),
      { version: 2, description: "new owner value" },
      { resolveCategory },
    );
    expect(plan.columnUpdates.description).toBe("new owner value");
    expect(plan.selfDeclaredFields).toContain("description");
  });

  it("skips a valid category when curator-owned (not self-declared)", () => {
    const plan = computeOrgIdentityUpdates(
      org({ category: "cloud" }),
      { version: 2, category: "developer-tools" },
      { resolveCategory },
    );
    expect(plan.columnUpdates.category).toBeUndefined();
    expect(plan.skipped).toContain("category");
  });

  it("ignores an unresolvable category but proceeds", () => {
    const plan = computeOrgIdentityUpdates(
      org(),
      { version: 2, description: "ok", category: "not-a-category" },
      { resolveCategory },
    );
    expect(plan.columnUpdates.category).toBeUndefined();
    expect(plan.columnUpdates.description).toBe("ok");
    expect(plan.skipped).toContain("category");
  });

  it("collects additive tags and socials without precedence", () => {
    const plan = computeOrgIdentityUpdates(
      org(),
      { version: 2, tags: ["ci"], social: { twitter: "acmehq" } },
      { resolveCategory },
    );
    expect(plan.tagsToAdd).toEqual(["ci"]);
    expect(plan.socialsToAdd).toEqual([{ platform: "twitter", handle: "acmehq" }]);
  });

  it("plans an avatar mirror when avatarUrl is empty", () => {
    const plan = computeOrgIdentityUpdates(
      org(),
      { version: 2, avatar: "https://acme.com/logo.png" },
      { resolveCategory },
    );
    expect(plan.avatarSourceUrl).toBe("https://acme.com/logo.png");
  });

  it("does not touch name when config omits it", () => {
    const plan = computeOrgIdentityUpdates(
      org(),
      { version: 2, description: "x" },
      { resolveCategory },
    );
    expect(plan.columnUpdates.name).toBeUndefined();
  });
});
