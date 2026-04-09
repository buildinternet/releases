import { describe, it, expect, beforeEach, afterAll } from "bun:test";
import { createTestDb, type TestDatabase } from "../db-helper.js";
import {
  organizations,
  sources,
  releases,
  orgAccounts,
  domainAliases,
} from "../../src/db/schema.js";

// The MCP tools accept a drizzle DB instance. The bun-sqlite drizzle
// instance is API-compatible with the D1 drizzle instance for queries
// used here, so we can test the tool handlers directly.
import {
  searchReleases,
  getLatestReleases,
  listProducts,
  listOrganizations,
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
    ])
    .run();

  return { acme, beta, acmeCli, acmeWeb, betaApi };
}

beforeEach(() => {
  const db = getDb();
  db.delete(releases).run();
  db.delete(sources).run();
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
// listProducts
// ---------------------------------------------------------------------------
describe("listProducts", () => {
  it("lists all sources when no org filter", async () => {
    seedData();
    const result = await listProducts(getDb() as any, {});
    const txt = resultText(result);
    expect(txt).toContain("Acme CLI");
    expect(txt).toContain("Acme Web");
    expect(txt).toContain("Beta API");
  });

  it("filters by organization slug", async () => {
    seedData();
    const result = await listProducts(getDb() as any, { organization: "acme" });
    const txt = resultText(result);
    expect(txt).toContain("Acme CLI");
    expect(txt).toContain("Acme Web");
    expect(txt).not.toContain("Beta API");
  });

  it("resolves org by domain", async () => {
    seedData();
    const result = await listProducts(getDb() as any, { organization: "acme.com" });
    const txt = resultText(result);
    expect(txt).toContain("Acme CLI");
  });

  it("resolves org by domain alias", async () => {
    seedData();
    const result = await listProducts(getDb() as any, { organization: "acme-alias.com" });
    const txt = resultText(result);
    expect(txt).toContain("Acme CLI");
  });

  it("resolves org by account handle", async () => {
    seedData();
    const result = await listProducts(getDb() as any, { organization: "acme-gh" });
    const txt = resultText(result);
    expect(txt).toContain("Acme CLI");
  });

  it("returns error for unknown org", async () => {
    seedData();
    const result = await listProducts(getDb() as any, { organization: "nope" });
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
