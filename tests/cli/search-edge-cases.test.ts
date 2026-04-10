import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { createTempDataDir, cli, cliJson } from "./roundtrip-helper.js";

describe("CLI search with empty database", () => {
  let dataDir: string;
  let cleanup: () => void;

  beforeAll(() => {
    ({ dataDir, cleanup } = createTempDataDir());
  });

  afterAll(() => cleanup());

  it("search returns empty results gracefully (JSON)", () => {
    const results = cliJson<{ orgs: unknown[]; products: unknown[]; releases: unknown[] }>(dataDir, [
      "search", "anything", "--json",
    ]);
    expect(results.orgs).toEqual([]);
    expect(results.products).toEqual([]);
    expect(results.releases).toEqual([]);
  });

  it("search returns empty results gracefully (text)", () => {
    const result = cli(dataDir, ["search", "anything"]);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("No results");
  });
});

describe("CLI category validation", () => {
  let dataDir: string;
  let cleanup: () => void;

  beforeAll(() => {
    ({ dataDir, cleanup } = createTempDataDir());
    // Seed an org for edit/product tests
    const seed = cli(dataDir, ["org", "add", "Test Org"]);
    if (seed.exitCode !== 0) throw new Error(`Seed failed: ${seed.stderr}`);
  });

  afterAll(() => cleanup());

  it("categories command lists valid categories", () => {
    const result = cli(dataDir, ["categories"]);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("ai");
    expect(result.stdout).toContain("cloud");
  });

  it("rejects invalid category on org add", () => {
    const result = cli(dataDir, [
      "org", "add", "Bad Category Org", "--category", "fake-category",
    ]);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("Invalid category");
  });

  it("rejects invalid category on org edit", () => {
    const result = cli(dataDir, [
      "org", "edit", "test-org", "--category", "not-real",
    ]);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("Invalid category");
  });

  it("rejects invalid category on product add", () => {
    const result = cli(dataDir, [
      "product", "add", "Bad Product",
      "--org", "test-org",
      "--category", "bogus",
    ]);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("Invalid category");
  });
});

describe("CLI org link/unlink", () => {
  let dataDir: string;
  let cleanup: () => void;

  beforeAll(() => {
    ({ dataDir, cleanup } = createTempDataDir());
    const seed = cli(dataDir, ["org", "add", "Acme Corp"]);
    if (seed.exitCode !== 0) throw new Error(`Seed failed: ${seed.stderr}`);
  });

  afterAll(() => cleanup());

  it("links a platform account", () => {
    const result = cli(dataDir, [
      "org", "link", "acme-corp",
      "--platform", "github",
      "--handle", "acme-corp",
      "--json",
    ]);
    expect(result.exitCode).toBe(0);
    const parsed = JSON.parse(result.stdout);
    expect(parsed.platform).toBe("github");
    expect(parsed.handle).toBe("acme-corp");
  });

  it("linked account appears in org show", () => {
    const org = cliJson<{ accounts: { platform: string; handle: string }[] }>(
      dataDir,
      ["org", "show", "acme-corp", "--json"],
    );
    expect(org.accounts.length).toBe(1);
    expect(org.accounts[0].platform).toBe("github");
    expect(org.accounts[0].handle).toBe("acme-corp");
  });

  it("unlinks a platform account", () => {
    const result = cli(dataDir, [
      "org", "unlink", "acme-corp",
      "--platform", "github",
      "--handle", "acme-corp",
      "--json",
    ]);
    expect(result.exitCode).toBe(0);
    const parsed = JSON.parse(result.stdout);
    expect(parsed.unlinked).toBe("github/acme-corp");
  });

  it("account is gone after unlinking", () => {
    const org = cliJson<{ accounts: unknown[] }>(
      dataDir,
      ["org", "show", "acme-corp", "--json"],
    );
    expect(org.accounts.length).toBe(0);
  });
});

describe("CLI org remove dry-run", () => {
  let dataDir: string;
  let cleanup: () => void;

  beforeAll(() => {
    ({ dataDir, cleanup } = createTempDataDir());
    const seed = cli(dataDir, ["org", "add", "Ephemeral Org"]);
    if (seed.exitCode !== 0) throw new Error(`Seed failed: ${seed.stderr}`);
  });

  afterAll(() => cleanup());

  it("dry-run shows what would be removed", () => {
    const result = cli(dataDir, [
      "org", "remove", "ephemeral-org", "--dry-run", "--json",
    ]);
    expect(result.exitCode).toBe(0);
    const parsed = JSON.parse(result.stdout);
    expect(parsed.wouldRemove).toBe("ephemeral-org");
  });

  it("org still exists after dry-run", () => {
    const orgs = cliJson<{ slug: string }[]>(dataDir, ["org", "list", "--json"]);
    expect(orgs.length).toBe(1);
    expect(orgs[0].slug).toBe("ephemeral-org");
  });
});

describe("CLI product adopt", () => {
  let dataDir: string;
  let cleanup: () => void;

  beforeAll(() => {
    ({ dataDir, cleanup } = createTempDataDir());
    for (const args of [
      ["org", "add", "Vercel", "--category", "cloud"],
      ["org", "add", "Next.js", "--domain", "nextjs.org"],
      ["add", "Next.js Blog", "--url", "https://nextjs.org/blog", "--org", "next-js", "--skip-eval"],
    ]) {
      const r = cli(dataDir, args);
      if (r.exitCode !== 0) throw new Error(`Seed failed: ${r.stderr}`);
    }
  });

  afterAll(() => cleanup());

  it("dry-run shows adoption plan", () => {
    const result = cli(dataDir, [
      "product", "adopt", "next-js",
      "--into", "vercel",
      "--dry-run",
      "--json",
    ]);
    expect(result.exitCode).toBe(0);
    const plan = JSON.parse(result.stdout);
    expect(plan.sourceOrg.slug).toBe("next-js");
    expect(plan.targetOrg.slug).toBe("vercel");
    expect(plan.sourcesToMove.length).toBe(1);
    expect(plan.wouldRemoveOrg).toBe("next-js");
  });

  it("adopts org as product", () => {
    const result = cli(dataDir, [
      "product", "adopt", "next-js",
      "--into", "vercel",
      "--json",
    ]);
    expect(result.exitCode).toBe(0);
    const adopted = JSON.parse(result.stdout);
    expect(adopted.adopted).toBe("next-js");
    expect(adopted.into).toBe("vercel");
    expect(adopted.sourcesMoved).toBe(1);
  });

  it("source org no longer exists", () => {
    const result = cli(dataDir, ["org", "show", "next-js"]);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("not found");
  });

  it("product exists under target org", () => {
    const products = cliJson<{ slug: string }[]>(dataDir, [
      "product", "list", "vercel", "--json",
    ]);
    expect(products.some((p) => p.slug === "next-js")).toBe(true);
  });

  it("source was moved to target org", () => {
    const sources = cliJson<{ slug: string; orgName: string }[]>(dataDir, [
      "list", "--org", "vercel", "--json",
    ]);
    expect(sources.some((s) => s.slug === "next-js-blog")).toBe(true);
  });
});

describe("CLI remove with --ignore", () => {
  let dataDir: string;
  let cleanup: () => void;

  beforeAll(() => {
    ({ dataDir, cleanup } = createTempDataDir());
    for (const args of [
      ["org", "add", "Acme Corp"],
      ["add", "Acme Blog", "--url", "https://acme.com/blog", "--org", "acme-corp", "--skip-eval"],
    ]) {
      const r = cli(dataDir, args);
      if (r.exitCode !== 0) throw new Error(`Seed failed: ${r.stderr}`);
    }
  });

  afterAll(() => cleanup());

  it("removes source and adds URL to ignored list", () => {
    const result = cli(dataDir, [
      "remove", "acme-blog",
      "--ignore",
      "--reason", "not a changelog",
      "--json",
    ]);
    expect(result.exitCode).toBe(0);
    const parsed = JSON.parse(result.stdout);
    expect(parsed[0].status).toBe("removed");
    expect(parsed[0].ignored).toBe(true);
  });

  it("URL appears in ignored list", () => {
    const rows = cliJson<{ url: string }[]>(dataDir, [
      "ignore", "list", "--org", "acme-corp", "--json",
    ]);
    expect(rows.some((r) => r.url === "https://acme.com/blog")).toBe(true);
  });
});
