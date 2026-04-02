import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { createTempDataDir, cli, cliJson } from "./roundtrip-helper.js";

describe("CLI org tags", () => {
  let dataDir: string;
  let cleanup: () => void;

  beforeAll(() => {
    ({ dataDir, cleanup } = createTempDataDir());
    const seed = cli(dataDir, ["org", "add", "Acme Corp", "--category", "cloud"]);
    if (seed.exitCode !== 0) throw new Error(`Seed failed: ${seed.stderr}`);
  });

  afterAll(() => cleanup());

  it("starts with no tags", () => {
    const tags = cliJson<string[]>(dataDir, ["org", "tag", "list", "acme-corp", "--json"]);
    expect(tags).toEqual([]);
  });

  it("adds tags to an org", () => {
    const result = cli(dataDir, ["org", "tag", "add", "acme-corp", "typescript", "react", "--json"]);
    expect(result.exitCode).toBe(0);
    const parsed = JSON.parse(result.stdout);
    expect(parsed.tags).toContain("typescript");
    expect(parsed.tags).toContain("react");
  });

  it("lists tags", () => {
    const tags = cliJson<string[]>(dataDir, ["org", "tag", "list", "acme-corp", "--json"]);
    expect(tags).toContain("typescript");
    expect(tags).toContain("react");
    expect(tags.length).toBe(2);
  });

  it("removes a tag", () => {
    const result = cli(dataDir, ["org", "tag", "remove", "acme-corp", "react", "--json"]);
    expect(result.exitCode).toBe(0);
    const parsed = JSON.parse(result.stdout);
    expect(parsed.tags).toEqual(["typescript"]);
  });

  it("only typescript remains", () => {
    const tags = cliJson<string[]>(dataDir, ["org", "tag", "list", "acme-corp", "--json"]);
    expect(tags).toEqual(["typescript"]);
  });

  it("adds more tags", () => {
    const result = cli(dataDir, ["org", "tag", "add", "acme-corp", "serverless", "edge", "--json"]);
    expect(result.exitCode).toBe(0);
    const parsed = JSON.parse(result.stdout);
    expect(parsed.tags.length).toBe(3);
  });

  it("removes multiple tags", () => {
    const result = cli(dataDir, ["org", "tag", "remove", "acme-corp", "serverless", "edge"]);
    expect(result.exitCode).toBe(0);
    const tags = cliJson<string[]>(dataDir, ["org", "tag", "list", "acme-corp", "--json"]);
    expect(tags).toEqual(["typescript"]);
  });

  it("tag operations on non-existent org fail", () => {
    const result = cli(dataDir, ["org", "tag", "list", "nonexistent"]);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("not found");
  });

  it("org add with --tags creates org and tags together", () => {
    const result = cli(dataDir, [
      "org", "add", "Tagged Org",
      "--tags", "golang,rust",
      "--json",
    ]);
    expect(result.exitCode).toBe(0);

    const tags = cliJson<string[]>(dataDir, ["org", "tag", "list", "tagged-org", "--json"]);
    expect(tags).toContain("golang");
    expect(tags).toContain("rust");
  });
});

describe("CLI product tags", () => {
  let dataDir: string;
  let cleanup: () => void;

  beforeAll(() => {
    ({ dataDir, cleanup } = createTempDataDir());
    const s1 = cli(dataDir, ["org", "add", "Vercel"]);
    if (s1.exitCode !== 0) throw new Error(`Seed org failed: ${s1.stderr}`);
    const s2 = cli(dataDir, ["product", "add", "Next.js", "--org", "vercel"]);
    if (s2.exitCode !== 0) throw new Error(`Seed product failed: ${s2.stderr}`);
  });

  afterAll(() => cleanup());

  it("starts with no product tags", () => {
    const tags = cliJson<string[]>(dataDir, ["product", "tag", "list", "next-js", "--json"]);
    expect(tags).toEqual([]);
  });

  it("adds tags to a product", () => {
    const result = cli(dataDir, ["product", "tag", "add", "next-js", "react", "ssr", "--json"]);
    expect(result.exitCode).toBe(0);
    const parsed = JSON.parse(result.stdout);
    expect(parsed.tags).toContain("react");
    expect(parsed.tags).toContain("ssr");
  });

  it("lists product tags", () => {
    const tags = cliJson<string[]>(dataDir, ["product", "tag", "list", "next-js", "--json"]);
    expect(tags.length).toBe(2);
  });

  it("removes a product tag", () => {
    cli(dataDir, ["product", "tag", "remove", "next-js", "ssr"]);
    const tags = cliJson<string[]>(dataDir, ["product", "tag", "list", "next-js", "--json"]);
    expect(tags).toEqual(["react"]);
  });

  it("product tag operations on non-existent product fail", () => {
    const result = cli(dataDir, ["product", "tag", "list", "nonexistent"]);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("not found");
  });

  it("product add with --tags creates product and tags together", () => {
    cli(dataDir, [
      "product", "add", "Turborepo",
      "--org", "vercel",
      "--tags", "monorepo,build",
    ]);
    const tags = cliJson<string[]>(dataDir, ["product", "tag", "list", "turborepo", "--json"]);
    expect(tags).toContain("monorepo");
    expect(tags).toContain("build");
  });
});
