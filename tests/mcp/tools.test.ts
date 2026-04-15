import { describe, it, expect, beforeEach, afterAll } from "bun:test";
import { createTestDb, type TestDatabase } from "../db-helper.js";
import {
  organizations,
  sources,
  releases,
  orgAccounts,
  domainAliases,
  tags,
  orgTags,
  products,
  productTags,
  sourceChangelogFiles,
} from "../../src/db/schema.js";
import { eq } from "drizzle-orm";

// The MCP tools accept a drizzle DB instance. The bun-sqlite drizzle
// instance is API-compatible with the D1 drizzle instance for queries
// used here, so we can test the tool handlers directly.
import {
  searchReleases,
  getLatestReleases,
  listSources,
  listOrganizations,
  getOrganization,
  getSourceChangelog,
  getRelease,
  getSource,
  listProducts,
  getProduct,
} from "../../workers/mcp/src/tools.js";

let testDatabase: TestDatabase;

function getDb() {
  return testDatabase.db;
}

testDatabase = createTestDb();

afterAll(() => {
  testDatabase.cleanup();
});

function seedData() {
  const db = getDb();

  db.insert(organizations)
    .values([
      { name: "Acme Corp", slug: "acme", domain: "acme.com" },
      { name: "Beta Inc", slug: "beta", domain: "beta.io" },
    ])
    .run();

  const orgs = db.select().from(organizations).all();
  const acme = orgs.find((o) => o.slug === "acme")!;
  const beta = orgs.find((o) => o.slug === "beta")!;

  db.insert(orgAccounts)
    .values([{ orgId: acme.id, platform: "github", handle: "acme-gh" }])
    .run();

  db.insert(domainAliases)
    .values([{ domain: "acme-alias.com", orgId: acme.id }])
    .run();

  db.insert(sources)
    .values([
      { name: "Acme CLI", slug: "acme-cli", type: "github", url: "https://github.com/acme/cli", orgId: acme.id },
      { name: "Acme Web", slug: "acme-web", type: "feed", url: "https://acme.com/changelog.xml", orgId: acme.id },
      { name: "Beta API", slug: "beta-api", type: "github", url: "https://github.com/beta/api", orgId: beta.id },
    ])
    .run();

  const allSources = db.select().from(sources).all();
  const acmeCli = allSources.find((s) => s.slug === "acme-cli")!;
  const acmeWeb = allSources.find((s) => s.slug === "acme-web")!;
  const betaApi = allSources.find((s) => s.slug === "beta-api")!;

  db.insert(products)
    .values({
      name: "Acme CLI Pro",
      slug: "acme-cli-pro",
      orgId: acme.id,
      url: "https://acme.com/cli-pro",
      description: "Pro CLI tools",
      category: "developer-tools",
    })
    .run();
  // Intentionally empty: fixture for `Sources: none` / `Tags: none` assertions in getProduct tests.
  db.insert(products)
    .values({
      name: "Acme Empty",
      slug: "acme-empty",
      orgId: acme.id,
      category: "developer-tools",
    })
    .run();
  const allProducts = db.select().from(products).all();
  const acmeCliPro = allProducts.find((p) => p.slug === "acme-cli-pro")!;

  db.update(sources)
    .set({ productId: acmeCliPro.id })
    .where(eq(sources.id, acmeCli.id))
    .run();

  db.insert(tags).values({ name: "cli", slug: "cli" }).run();
  const cliTag = db.select().from(tags).where(eq(tags.slug, "cli")).all()[0]!;
  db.insert(productTags)
    .values({ productId: acmeCliPro.id, tagId: cliTag.id })
    .run();

  db.insert(sourceChangelogFiles)
    .values({
      sourceId: acmeCli.id,
      path: "CHANGELOG.md",
      filename: "CHANGELOG.md",
      url: "https://github.com/acme/cli/blob/HEAD/CHANGELOG.md",
      rawUrl: "https://raw.githubusercontent.com/acme/cli/HEAD/CHANGELOG.md",
      content: "# Changelog\n\n## v1.1\n- Fixed parsing error",
      contentHash: "scf-hash-1",
      bytes: 47,
    })
    .run();

  const now = new Date();
  db.insert(releases)
    .values([
      {
        sourceId: acmeCli.id,
        title: "v1.0 Release",
        content: "Initial release with core CLI commands",
        version: "1.0.0",
        publishedAt: new Date(now.getTime() - 1000 * 60 * 60 * 24).toISOString(),
        contentHash: "hash1",
      },
      {
        sourceId: acmeCli.id,
        title: "v1.1 Bugfix",
        content: "Fixed parsing error in config",
        version: "1.1.0",
        publishedAt: now.toISOString(),
        contentHash: "hash2",
      },
      {
        sourceId: acmeWeb.id,
        title: "Dashboard Update",
        content: "New analytics dashboard with charts",
        publishedAt: now.toISOString(),
        contentHash: "hash3",
      },
      {
        sourceId: betaApi.id,
        title: "Beta API v2",
        content: "GraphQL endpoint support added",
        version: "2.0.0",
        publishedAt: now.toISOString(),
        contentHash: "hash4",
      },
      {
        sourceId: acmeWeb.id,
        title: "Fall Release 2025",
        content: "Quarterly rollup of everything shipped this fall",
        publishedAt: new Date(now.getTime() - 1000 * 60 * 60 * 2).toISOString(),
        contentHash: "hash5",
        type: "rollup",
      },
      {
        sourceId: betaApi.id,
        title: "Beta Suppressed",
        content: "Hidden release that should never surface",
        version: "2.1.0",
        publishedAt: now.toISOString(),
        contentHash: "hash6",
        suppressed: true,
      },
    ])
    .run();

  const allReleases = db.select().from(releases).all();
  const acmeCliV10 = allReleases.find(
    (r) => r.sourceId === acmeCli.id && r.title === "v1.0 Release",
  )!;
  const suppressedRelease = allReleases.find((r) => r.title === "Beta Suppressed")!;

  return {
    acme,
    beta,
    acmeCli,
    acmeWeb,
    betaApi,
    acmeCliPro,
    acmeCliV10Id: acmeCliV10.id,
    suppressedReleaseId: suppressedRelease.id,
  };
}

beforeEach(() => {
  const db = getDb();
  db.delete(releases).run();
  db.delete(sourceChangelogFiles).run();
  db.delete(sources).run();
  db.delete(orgTags).run();
  db.delete(productTags).run();
  db.delete(tags).run();
  db.delete(products).run();
  db.delete(domainAliases).run();
  db.delete(orgAccounts).run();
  db.delete(organizations).run();
});

function resultText(result: { content: [{ type: "text"; text: string }] }): string {
  return result.content[0].text;
}

// ---------------------------------------------------------------------------
// listOrganizations
// ---------------------------------------------------------------------------
describe("listOrganizations", () => {
  it("lists all orgs when no filters", async () => {
    seedData();
    const result = await listOrganizations(getDb() as any, {});
    const txt = resultText(result);
    expect(txt).toContain("Acme Corp");
    expect(txt).toContain("Beta Inc");
  });

  it("filters by query", async () => {
    seedData();
    const result = await listOrganizations(getDb() as any, { query: "acme" });
    const txt = resultText(result);
    expect(txt).toContain("Acme Corp");
    expect(txt).not.toContain("Beta Inc");
  });

  it("returns empty message when no match", async () => {
    seedData();
    const result = await listOrganizations(getDb() as any, { query: "nonexistent" });
    expect(resultText(result)).toBe("No organizations found.");
  });
});

// ---------------------------------------------------------------------------
// listSources
// ---------------------------------------------------------------------------
describe("listSources", () => {
  it("lists all sources when no org filter", async () => {
    seedData();
    const result = await listSources(getDb() as any, {});
    const txt = resultText(result);
    expect(txt).toContain("Acme CLI");
    expect(txt).toContain("Acme Web");
    expect(txt).toContain("Beta API");
  });

  it("filters by organization slug", async () => {
    seedData();
    const result = await listSources(getDb() as any, { organization: "acme" });
    const txt = resultText(result);
    expect(txt).toContain("Acme CLI");
    expect(txt).toContain("Acme Web");
    expect(txt).not.toContain("Beta API");
  });

  it("resolves org by domain", async () => {
    seedData();
    const result = await listSources(getDb() as any, { organization: "acme.com" });
    const txt = resultText(result);
    expect(txt).toContain("Acme CLI");
  });

  it("resolves org by domain alias", async () => {
    seedData();
    const result = await listSources(getDb() as any, { organization: "acme-alias.com" });
    const txt = resultText(result);
    expect(txt).toContain("Acme CLI");
  });

  it("resolves org by account handle", async () => {
    seedData();
    const result = await listSources(getDb() as any, { organization: "acme-gh" });
    const txt = resultText(result);
    expect(txt).toContain("Acme CLI");
  });

  it("returns error for unknown org", async () => {
    seedData();
    const result = await listSources(getDb() as any, { organization: "nope" });
    expect(resultText(result)).toContain("No organization found");
  });
});

// ---------------------------------------------------------------------------
// getLatestReleases
// ---------------------------------------------------------------------------
describe("getLatestReleases", () => {
  it("returns latest releases across all sources", async () => {
    seedData();
    const result = await getLatestReleases(getDb() as any, {});
    const txt = resultText(result);
    expect(txt).toContain("v1.1 Bugfix");
    expect(txt).toContain("Beta API v2");
  });

  it("filters by product slug", async () => {
    seedData();
    const result = await getLatestReleases(getDb() as any, { product: "acme-cli" });
    const txt = resultText(result);
    expect(txt).toContain("v1.1 Bugfix");
    expect(txt).toContain("v1.0 Release");
    expect(txt).not.toContain("Beta API");
  });

  it("filters by organization", async () => {
    seedData();
    const result = await getLatestReleases(getDb() as any, { organization: "acme" });
    const txt = resultText(result);
    expect(txt).toContain("Acme CLI");
    expect(txt).not.toContain("Beta API");
  });

  it("respects count limit", async () => {
    seedData();
    const result = await getLatestReleases(getDb() as any, { count: 1 });
    const txt = resultText(result);
    // Should have only 1 release (most recent), so only one "---" separator or none
    expect(txt.split("---").length).toBeLessThanOrEqual(2);
  });

  it("returns error for unknown product", async () => {
    seedData();
    const result = await getLatestReleases(getDb() as any, { product: "nope" });
    expect(resultText(result)).toContain("No product found");
  });

  it("returns empty message when no releases", async () => {
    const result = await getLatestReleases(getDb() as any, {});
    expect(resultText(result)).toBe("No releases found.");
  });

  it("badges rollups in output", async () => {
    seedData();
    const result = await getLatestReleases(getDb() as any, {});
    const txt = resultText(result);
    expect(txt).toContain("Fall Release 2025");
    expect(txt).toContain("_(rollup)_");
  });

  it("filters to rollups only when type=rollup", async () => {
    seedData();
    const result = await getLatestReleases(getDb() as any, { type: "rollup" });
    const txt = resultText(result);
    expect(txt).toContain("Fall Release 2025");
    expect(txt).not.toContain("v1.1 Bugfix");
    expect(txt).not.toContain("Beta API v2");
  });

  it("excludes rollups when type=feature", async () => {
    seedData();
    const result = await getLatestReleases(getDb() as any, { type: "feature" });
    const txt = resultText(result);
    expect(txt).not.toContain("Fall Release 2025");
    expect(txt).toContain("v1.1 Bugfix");
  });
});

// ---------------------------------------------------------------------------
// searchReleases (FTS — requires releases_fts virtual table)
// ---------------------------------------------------------------------------
describe("searchReleases", () => {
  it("returns not-found for missing product filter", async () => {
    seedData();
    const result = await searchReleases(getDb() as any, {
      query: "release",
      product: "nonexistent",
    });
    expect(resultText(result)).toContain("No product found");
  });

  it("returns not-found for missing org filter", async () => {
    seedData();
    const result = await searchReleases(getDb() as any, {
      query: "release",
      organization: "nonexistent",
    });
    expect(resultText(result)).toContain("No organization found");
  });
});

// ---------------------------------------------------------------------------
// getOrganization
// ---------------------------------------------------------------------------
describe("getOrganization", () => {
  it("returns detailed org info by slug", async () => {
    seedData();
    const result = await getOrganization(getDb() as any, { identifier: "acme" });
    const txt = resultText(result);
    expect(txt).toContain("Acme Corp");
    expect(txt).toContain("acme.com");
    expect(txt).toContain("github/acme-gh");
    expect(txt).toContain("Acme CLI");
    expect(txt).toContain("Acme Web");
  });

  it("resolves by domain", async () => {
    seedData();
    const result = await getOrganization(getDb() as any, { identifier: "acme.com" });
    const txt = resultText(result);
    expect(txt).toContain("Acme Corp");
  });

  it("resolves by domain alias", async () => {
    seedData();
    const result = await getOrganization(getDb() as any, { identifier: "acme-alias.com" });
    const txt = resultText(result);
    expect(txt).toContain("Acme Corp");
  });

  it("resolves by account handle", async () => {
    seedData();
    const result = await getOrganization(getDb() as any, { identifier: "acme-gh" });
    const txt = resultText(result);
    expect(txt).toContain("Acme Corp");
  });

  it("includes tags when present", async () => {
    const { acme } = seedData();
    const db = getDb();
    const [tag] = db.insert(tags).values({ name: "typescript", slug: "typescript" }).returning().all();
    db.insert(orgTags).values({ orgId: acme.id, tagId: tag.id }).run();

    const result = await getOrganization(db as any, { identifier: "acme" });
    expect(resultText(result)).toContain("typescript");
  });

  it("includes products when present", async () => {
    seedData();
    const db = getDb();
    const result = await getOrganization(db as any, { identifier: "acme" });
    const txt = resultText(result);
    expect(txt).toContain("Acme CLI Pro");
    expect(txt).toContain("acme-cli-pro");
  });

  it("includes aliases", async () => {
    seedData();
    const result = await getOrganization(getDb() as any, { identifier: "acme" });
    expect(resultText(result)).toContain("acme-alias.com");
  });

  it("returns not-found for unknown identifier", async () => {
    seedData();
    const result = await getOrganization(getDb() as any, { identifier: "nonexistent" });
    expect(resultText(result)).toContain("No organization found");
  });
});

// ---------------------------------------------------------------------------
// getSourceChangelog
// ---------------------------------------------------------------------------
describe("getSourceChangelog", () => {
  it("returns stored content for a source with a changelog", async () => {
    seedData();
    const result = await getSourceChangelog(getDb() as any, { source: "acme-cli" });
    const txt = resultText(result);
    expect(txt).toContain("Acme CLI");
    expect(txt).toContain("CHANGELOG.md");
    expect(txt).toContain("Fixed parsing error");
    expect(txt).toContain("end of file");
    expect(txt).toContain("total tokens");
  });

  it("returns not-found message when source has no changelog", async () => {
    seedData();
    const result = await getSourceChangelog(getDb() as any, { source: "beta-api" });
    expect(resultText(result)).toBe(
      'No CHANGELOG file is tracked for "beta-api". Only GitHub sources expose this.',
    );
  });

  it("returns not-found for unknown source", async () => {
    seedData();
    const result = await getSourceChangelog(getDb() as any, { source: "nope" });
    expect(resultText(result)).toBe('No source found matching "nope"');
  });

  it("resolves by src_ id", async () => {
    const { acmeCli } = seedData();
    const result = await getSourceChangelog(getDb() as any, { source: acmeCli.id });
    expect(resultText(result)).toContain("CHANGELOG.md");
  });

  it("supports offset/limit range slicing", async () => {
    seedData();
    const result = await getSourceChangelog(getDb() as any, {
      source: "acme-cli",
      offset: 0,
      limit: 20,
    });
    const txt = resultText(result);
    expect(txt).toMatch(/Slice:.*chars 0–\d+ of \d+/);
    expect(txt).toContain("next: offset=");
  });
});

// ---------------------------------------------------------------------------
// getRelease
// ---------------------------------------------------------------------------
describe("getRelease", () => {
  it("returns formatted detail for a real rel_ id", async () => {
    const { acmeCliV10Id } = seedData();
    const result = await getRelease(getDb() as any, { id: acmeCliV10Id });
    const txt = resultText(result);
    expect(txt).toContain("v1.0 Release");
    expect(txt).toContain(`ID: ${acmeCliV10Id}`);
    expect(txt).toContain("Version: 1.0.0");
    expect(txt).toContain("Acme CLI");
    expect(txt).toContain("Acme Corp");
    expect(txt).toContain("Initial release with core CLI commands");
  });

  it("accepts a bare nanoid (strips rel_ prefix)", async () => {
    const { acmeCliV10Id } = seedData();
    const bare = acmeCliV10Id.replace(/^rel_/, "");
    const result = await getRelease(getDb() as any, { id: bare });
    expect(resultText(result)).toContain("v1.0 Release");
  });

  it("returns not-found for an unknown rel_ id", async () => {
    seedData();
    const result = await getRelease(getDb() as any, { id: "rel_aaaaaaaaaaaaaaaaaaaaa" });
    expect(resultText(result)).toContain("No release found matching");
  });

  it("returns not-found for a suppressed release", async () => {
    const { suppressedReleaseId } = seedData();
    const result = await getRelease(getDb() as any, { id: suppressedReleaseId });
    expect(resultText(result)).toContain("No release found matching");
  });

  it("badges rollup releases in the header", async () => {
    seedData();
    // Find the rollup by selecting directly
    const db = getDb();
    const rollup = db
      .select()
      .from(releases)
      .where(eq(releases.title, "Fall Release 2025"))
      .all()[0]!;
    const result = await getRelease(db as any, { id: rollup.id });
    expect(resultText(result)).toContain("_(rollup)_");
  });
});

// ---------------------------------------------------------------------------
// getSource
// ---------------------------------------------------------------------------
describe("getSource", () => {
  it("returns detail for acme-cli with org, product, release count, and changelog", async () => {
    seedData();
    const result = await getSource(getDb() as any, { identifier: "acme-cli" });
    const txt = resultText(result);
    expect(txt).toContain("**Source: Acme CLI**");
    expect(txt).toContain("Slug: acme-cli");
    expect(txt).toContain("Organization: Acme Corp (acme)");
    expect(txt).toContain("Product: Acme CLI Pro (acme-cli-pro)");
    expect(txt).toContain("Release count: 2");
    expect(txt).toContain("Changelog file stored: yes");
  });

  it("reports Changelog file stored: no for sources without a file", async () => {
    seedData();
    const result = await getSource(getDb() as any, { identifier: "beta-api" });
    expect(resultText(result)).toContain("Changelog file stored: no");
  });

  it("reports Product: none for sources without a product", async () => {
    seedData();
    const result = await getSource(getDb() as any, { identifier: "acme-web" });
    expect(resultText(result)).toContain("Product: none");
  });

  it("excludes suppressed releases from the release count", async () => {
    seedData();
    // beta-api has one non-suppressed release + one suppressed → count should be 1
    const result = await getSource(getDb() as any, { identifier: "beta-api" });
    expect(resultText(result)).toContain("Release count: 1");
  });

  it("returns not-found for unknown source", async () => {
    seedData();
    const result = await getSource(getDb() as any, { identifier: "nope" });
    expect(resultText(result)).toBe('No source found matching "nope"');
  });

  it("resolves by src_ id", async () => {
    const { acmeCli } = seedData();
    const result = await getSource(getDb() as any, { identifier: acmeCli.id });
    expect(resultText(result)).toContain("**Source: Acme CLI**");
  });
});

// ---------------------------------------------------------------------------
// listProducts
// ---------------------------------------------------------------------------
describe("listProducts", () => {
  it("lists all products when no filter", async () => {
    seedData();
    const result = await listProducts(getDb() as any, {});
    const txt = resultText(result);
    expect(txt).toContain("Acme CLI Pro");
    expect(txt).toContain("Slug: acme-cli-pro");
    expect(txt).toContain("Organization: acme");
    expect(txt).toContain("URL: https://acme.com/cli-pro");
    expect(txt).toContain("Description: Pro CLI tools");
  });

  it("filters by organization slug", async () => {
    seedData();
    const result = await listProducts(getDb() as any, { organization: "acme" });
    const txt = resultText(result);
    expect(txt).toContain("Acme CLI Pro");
  });

  it("returns No products found for an org with zero products", async () => {
    seedData();
    const result = await listProducts(getDb() as any, { organization: "beta" });
    expect(resultText(result)).toBe("No products found.");
  });

  it("returns not-found for an unknown org filter", async () => {
    seedData();
    const result = await listProducts(getDb() as any, { organization: "nope" });
    expect(resultText(result)).toContain("No organization found");
  });
});

// ---------------------------------------------------------------------------
// getProduct
// ---------------------------------------------------------------------------
describe("getProduct", () => {
  it("returns detail for acme-cli-pro by slug", async () => {
    seedData();
    const result = await getProduct(getDb() as any, { identifier: "acme-cli-pro" });
    const txt = resultText(result);
    expect(txt).toContain("**Product: Acme CLI Pro**");
    expect(txt).toContain("Slug: acme-cli-pro");
    expect(txt).toContain("Organization: Acme Corp (acme)");
    expect(txt).toContain("Category: developer-tools");
    expect(txt).toContain("URL: https://acme.com/cli-pro");
    expect(txt).toContain("Description: Pro CLI tools");
    expect(txt).toContain("Tags: cli");
    expect(txt).toContain("Acme CLI");
    expect(txt).toContain("(acme-cli)");
  });

  it("resolves by prod_ id", async () => {
    const { acmeCliPro } = seedData();
    const result = await getProduct(getDb() as any, { identifier: acmeCliPro.id });
    expect(resultText(result)).toContain("**Product: Acme CLI Pro**");
  });

  it("returns not-found for unknown product", async () => {
    seedData();
    const result = await getProduct(getDb() as any, { identifier: "nope" });
    expect(resultText(result)).toBe('No product found matching "nope"');
  });

  it("reports Sources: none for a product with no linked sources", async () => {
    seedData();
    const result = await getProduct(getDb() as any, { identifier: "acme-empty" });
    expect(resultText(result)).toContain("Sources: none");
  });

  it("reports Tags: none for a product with no product_tags", async () => {
    seedData();
    const result = await getProduct(getDb() as any, { identifier: "acme-empty" });
    expect(resultText(result)).toContain("Tags: none");
  });
});
