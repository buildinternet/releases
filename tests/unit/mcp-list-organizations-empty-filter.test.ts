/**
 * Issue #746 — hide orgs with zero indexed releases from the MCP
 * `list_organizations` tool by default; opt back in via `include_empty: true`.
 *
 * Driven through the tool function directly (not the registered server) since
 * the SQL filter is what we care about — the registration shape is covered by
 * the schema review.
 */
import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { organizations, sources, releases } from "@buildinternet/releases-core/schema";
import { newOrgId, newSourceId, newReleaseId } from "@buildinternet/releases-core/id";
import { createTestDb, type TestDatabase } from "../db-helper.js";
import { asD1 } from "../mcp-test-helpers.js";
import { listOrganizations } from "../../workers/mcp/src/tools.js";

let testDb: TestDatabase;

beforeEach(() => {
  testDb = createTestDb();
});

afterEach(() => {
  testDb.cleanup();
});

async function seed(db: TestDatabase["db"]) {
  const acme = newOrgId();
  const beta = newOrgId();
  const stub = newOrgId();
  await db.insert(organizations).values([
    { id: acme, name: "Acme", slug: "acme" },
    { id: beta, name: "Beta", slug: "beta" },
    { id: stub, name: "Stub", slug: "stub" },
  ]);

  const acmeSrc = newSourceId();
  const betaSrc = newSourceId();
  await db.insert(sources).values([
    {
      id: acmeSrc,
      orgId: acme,
      name: "Acme",
      slug: "acme-cl",
      type: "scrape",
      url: "https://acme.example",
      discovery: "curated",
    },
    {
      id: betaSrc,
      orgId: beta,
      name: "Beta",
      slug: "beta-cl",
      type: "scrape",
      url: "https://beta.example",
      discovery: "curated",
    },
  ]);
  await db.insert(releases).values([
    {
      id: newReleaseId(),
      sourceId: acmeSrc,
      title: "Acme 1.0",
      content: "first",
      publishedAt: "2026-04-01T00:00:00Z",
    },
    {
      id: newReleaseId(),
      sourceId: betaSrc,
      title: "Beta 1.0",
      content: "first",
      publishedAt: "2026-04-01T00:00:00Z",
    },
  ]);
}

function bodyText(result: Awaited<ReturnType<typeof listOrganizations>>): string {
  return result.content
    .filter((c): c is { type: "text"; text: string } => c.type === "text")
    .map((c) => c.text)
    .join("\n");
}

describe("MCP list_organizations — empty filter (#746)", () => {
  it("hides orgs with zero indexed releases by default", async () => {
    await seed(testDb.db);
    const db = asD1(testDb.db);

    const result = await listOrganizations(db, {});
    const text = bodyText(result);
    expect(text).toContain("Acme");
    expect(text).toContain("Beta");
    expect(text).not.toContain("Stub");
  });

  it("surfaces empty orgs with include_empty: true", async () => {
    await seed(testDb.db);
    const db = asD1(testDb.db);

    const result = await listOrganizations(db, { include_empty: true });
    const text = bodyText(result);
    expect(text).toContain("Acme");
    expect(text).toContain("Beta");
    expect(text).toContain("Stub");
  });

  it("combines the empty filter with query string search", async () => {
    await seed(testDb.db);
    const db = asD1(testDb.db);

    // Default filter: no match because the only "stub" org has zero releases.
    const filtered = bodyText(await listOrganizations(db, { query: "stub" }));
    expect(filtered).toContain("No organizations found");

    // Opt in — the row surfaces.
    const included = bodyText(await listOrganizations(db, { query: "stub", include_empty: true }));
    expect(included).toContain("Stub");
  });
});
