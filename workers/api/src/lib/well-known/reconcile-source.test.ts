import { describe, it, expect } from "bun:test";
import { parseGitHubRepo, computeProductPlan } from "./reconcile-source.js";
import type { ReleasesJsonConfig } from "@buildinternet/releases-api-types";

const resolveCategory = (input: string) => (["cloud", "ai"].includes(input) ? input : null);

describe("parseGitHubRepo", () => {
  it("parses owner/repo from a github url", () => {
    expect(parseGitHubRepo("https://github.com/acme/cloud")).toEqual({
      owner: "acme",
      repo: "cloud",
    });
  });
  it("strips trailing path and .git", () => {
    expect(parseGitHubRepo("https://github.com/acme/cloud.git/releases")).toEqual({
      owner: "acme",
      repo: "cloud",
    });
  });
  it("accepts the www.github.com host", () => {
    expect(parseGitHubRepo("https://www.github.com/acme/cloud")).toEqual({
      owner: "acme",
      repo: "cloud",
    });
  });
  it("returns null for non-github urls", () => {
    expect(parseGitHubRepo("https://gitlab.com/acme/cloud")).toBeNull();
  });
  it("returns null for owner/repo with unexpected characters", () => {
    expect(parseGitHubRepo("https://github.com/acme/cloud@evil")).toBeNull();
  });
});

describe("computeProductPlan", () => {
  const cfg: ReleasesJsonConfig = {
    product: { name: "Acme Cloud", category: "cloud", kind: "platform" },
  };

  it("creates a product when none matches the slug", () => {
    const plan = computeProductPlan(null, { productId: null, metadata: "{}" }, cfg, {
      resolveCategory,
    });
    expect(plan.create).toEqual({
      name: "Acme Cloud",
      slug: "acme-cloud",
      description: null,
      category: "cloud",
      kind: "platform",
    });
    expect(plan.attach).toBe(true);
  });

  it("attaches to an existing product and fills only empty fields", () => {
    const existing = {
      id: "prod_1",
      slug: "acme-cloud",
      description: "Existing",
      category: null,
      kind: null,
    };
    const plan = computeProductPlan(existing, { productId: null, metadata: "{}" }, cfg, {
      resolveCategory,
    });
    expect(plan.create).toBeUndefined();
    expect(plan.attach).toBe(true);
    expect(plan.fills).toEqual({ category: "cloud", kind: "platform" }); // description NOT overwritten
  });

  it("does not reattach a curator-set productId", () => {
    const existing = {
      id: "prod_1",
      slug: "acme-cloud",
      description: null,
      category: null,
      kind: null,
    };
    const plan = computeProductPlan(existing, { productId: "prod_other", metadata: "{}" }, cfg, {
      resolveCategory,
    });
    expect(plan.attach).toBe(false);
  });

  it("reattaches when productId was self-declared", () => {
    const meta = JSON.stringify({
      selfDeclared: { fields: ["product"], source: "github", configHash: "x", syncedAt: "x" },
    });
    const existing = {
      id: "prod_1",
      slug: "acme-cloud",
      description: null,
      category: null,
      kind: null,
    };
    const plan = computeProductPlan(existing, { productId: "prod_old", metadata: meta }, cfg, {
      resolveCategory,
    });
    expect(plan.attach).toBe(true);
    expect(plan.fills).toEqual({ category: "cloud", kind: "platform" });
  });

  it("returns empty plan when there is no product block", () => {
    const plan = computeProductPlan(
      null,
      { productId: null, metadata: "{}" },
      {},
      { resolveCategory },
    );
    expect(plan.create).toBeUndefined();
    expect(plan.attach).toBe(false);
  });
});
