import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { createTempDataDir, cli, cliJson } from "./roundtrip-helper.js";

describe("CLI product lifecycle", () => {
  let dataDir: string;
  let cleanup: () => void;

  beforeAll(() => {
    ({ dataDir, cleanup } = createTempDataDir());
    const seed = cli(dataDir, ["admin", "org", "add", "Vercel", "--category", "cloud"]);
    if (seed.exitCode !== 0) throw new Error(`Seed failed: ${seed.stderr}`);
  });

  afterAll(() => cleanup());

  it("starts with no products", () => {
    const products = cliJson<unknown[]>(dataDir, ["admin", "product", "list", "vercel", "--json"]);
    expect(products).toEqual([]);
  });

  it("adds a product", () => {
    const result = cli(dataDir, [
      "admin", "product", "add", "Next.js",
      "--org", "vercel",
      "--url", "https://nextjs.org",
      "--description", "The React framework",
      "--json",
    ]);
    expect(result.exitCode).toBe(0);
    const product = JSON.parse(result.stdout);
    expect(product.name).toBe("Next.js");
    expect(product.slug).toBe("next-js");
    expect(product.url).toBe("https://nextjs.org");
  });

  it("product appears in list", () => {
    const products = cliJson<{ slug: string }[]>(dataDir, [
      "admin", "product", "list", "vercel", "--json",
    ]);
    expect(products.length).toBe(1);
    expect(products[0].slug).toBe("next-js");
  });

  it("edits product name", () => {
    const result = cli(dataDir, [
      "admin", "product", "edit", "next-js",
      "--name", "Next.js Framework",
      "--json",
    ]);
    expect(result.exitCode).toBe(0);
    const updated = JSON.parse(result.stdout);
    expect(updated.name).toBe("Next.js Framework");
  });

  it("edits product URL", () => {
    const result = cli(dataDir, [
      "admin", "product", "edit", "next-js",
      "--url", "https://nextjs.org/blog",
      "--json",
    ]);
    expect(result.exitCode).toBe(0);
    const updated = JSON.parse(result.stdout);
    expect(updated.url).toBe("https://nextjs.org/blog");
  });

  it("edits product description", () => {
    const result = cli(dataDir, [
      "admin", "product", "edit", "next-js",
      "--description", "A React framework for production",
      "--json",
    ]);
    expect(result.exitCode).toBe(0);
    const updated = JSON.parse(result.stdout);
    expect(updated.description).toBe("A React framework for production");
  });

  it("edits product category", () => {
    const result = cli(dataDir, [
      "admin", "product", "edit", "next-js",
      "--category", "framework",
      "--json",
    ]);
    expect(result.exitCode).toBe(0);
    const updated = JSON.parse(result.stdout);
    expect(updated.category).toBe("framework");
  });

  it("rejects invalid product category", () => {
    const result = cli(dataDir, [
      "admin", "product", "edit", "next-js",
      "--category", "nonsense",
    ]);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("Invalid category");
  });

  it("adds a second product", () => {
    const result = cli(dataDir, [
      "admin", "product", "add", "Turborepo",
      "--org", "vercel",
      "--json",
    ]);
    expect(result.exitCode).toBe(0);
    const product = JSON.parse(result.stdout);
    expect(product.slug).toBe("turborepo");
  });

  it("lists both products", () => {
    const products = cliJson<unknown[]>(dataDir, [
      "admin", "product", "list", "vercel", "--json",
    ]);
    expect(products.length).toBe(2);
  });

  it("product shows up in org show", () => {
    const org = cliJson<{ products: { slug: string }[] }>(
      dataDir,
      ["admin", "org", "show", "vercel", "--json"],
    );
    const slugs = org.products.map((p) => p.slug);
    expect(slugs).toContain("next-js");
    expect(slugs).toContain("turborepo");
  });

  it("removes a product", () => {
    const result = cli(dataDir, ["admin", "product", "remove", "turborepo", "--json"]);
    expect(result.exitCode).toBe(0);
    const removed = JSON.parse(result.stdout);
    expect(removed.removed).toBe("turborepo");
  });

  it("product is gone after removal", () => {
    const products = cliJson<{ slug: string }[]>(dataDir, [
      "admin", "product", "list", "vercel", "--json",
    ]);
    expect(products.length).toBe(1);
    expect(products[0].slug).toBe("next-js");
  });

  it("removing non-existent product fails", () => {
    const result = cli(dataDir, ["admin", "product", "remove", "nonexistent"]);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("not found");
  });

  it("editing non-existent product fails", () => {
    const result = cli(dataDir, ["admin", "product", "edit", "nonexistent", "--name", "foo"]);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("not found");
  });

  it("product list without org slug fails", () => {
    const result = cli(dataDir, ["admin", "product", "list"]);
    expect(result.exitCode).toBe(1);
  });

  it("product list with unknown org fails", () => {
    const result = cli(dataDir, ["admin", "product", "list", "nonexistent"]);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("not found");
  });

  it("product dry-run remove shows what would happen", () => {
    const result = cli(dataDir, [
      "admin", "product", "remove", "next-js", "--dry-run", "--json",
    ]);
    expect(result.exitCode).toBe(0);
    const plan = JSON.parse(result.stdout);
    expect(plan.wouldRemove).toBe("next-js");
  });

  it("product still exists after dry-run", () => {
    const products = cliJson<{ slug: string }[]>(dataDir, [
      "admin", "product", "list", "vercel", "--json",
    ]);
    expect(products.length).toBe(1);
    expect(products[0].slug).toBe("next-js");
  });
});
