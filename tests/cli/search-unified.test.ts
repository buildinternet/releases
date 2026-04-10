import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { createTempDataDir, cli, cliJson } from "./roundtrip-helper.js";

describe("unified search", () => {
  let dataDir: string;
  let cleanup: () => void;

  beforeAll(() => {
    ({ dataDir, cleanup } = createTempDataDir());
    // Seed data
    for (const args of [
      ["org", "add", "Vercel", "--category", "cloud"],
      ["org", "add", "Anthropic", "--category", "ai"],
      ["product", "add", "Next.js", "--org", "vercel"],
      ["add", "Vercel Blog", "--url", "https://vercel.com/changelog", "--org", "vercel", "--skip-eval"],
    ]) {
      const r = cli(dataDir, args);
      if (r.exitCode !== 0) throw new Error(`Seed failed (${args.join(" ")}): ${r.stderr}`);
    }
  });

  afterAll(() => cleanup());

  it("returns orgs matching by name", () => {
    const result = cliJson<{ orgs: { slug: string }[] }>(dataDir, [
      "search", "vercel", "--json",
    ]);
    expect(result.orgs.length).toBeGreaterThan(0);
    expect(result.orgs[0].slug).toBe("vercel");
  });

  it("returns products matching by name", () => {
    const result = cliJson<{ products: { slug: string }[] }>(dataDir, [
      "search", "next", "--json",
    ]);
    expect(result.products.length).toBeGreaterThan(0);
    expect(result.products[0].slug).toBe("next-js");
  });

  it("folds standalone sources into products", () => {
    const result = cliJson<{ products: { slug: string; kind?: string }[] }>(dataDir, [
      "search", "vercel blog", "--json",
    ]);
    const source = result.products.find((p) => p.slug === "vercel-blog");
    expect(source).toBeDefined();
    expect(source!.kind).toBe("source");
  });

  it("filters to a single type with --type", () => {
    const result = cliJson<Record<string, unknown>>(dataDir, [
      "search", "vercel", "--type", "orgs", "--json",
    ]);
    expect(result.orgs).toBeDefined();
    expect(result.products).toBeUndefined();
    expect(result.releases).toBeUndefined();
  });

  it("returns empty gracefully", () => {
    const result = cliJson<{ orgs: unknown[]; products: unknown[]; releases: unknown[] }>(
      dataDir,
      ["search", "zzzznonexistent", "--json"],
    );
    expect(result.orgs).toEqual([]);
    expect(result.products).toEqual([]);
    expect(result.releases).toEqual([]);
  });

  it("text output shows section headers", () => {
    const result = cli(dataDir, ["search", "vercel"]);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("Organizations");
    expect(result.stdout).toContain("Products");
  });

  it("text output shows no results message", () => {
    const result = cli(dataDir, ["search", "zzzznonexistent"]);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("No results");
  });
});
