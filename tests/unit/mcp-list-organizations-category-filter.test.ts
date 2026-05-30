/**
 * Category filter for the MCP `list_organizations` tool.
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
  const aiOrg = newOrgId();
  const devopsOrg = newOrgId();
  const uncategorizedOrg = newOrgId();

  await db.insert(organizations).values([
    { id: aiOrg, name: "AI Corp", slug: "ai-corp", category: "ai" },
    { id: devopsOrg, name: "Devops Inc", slug: "devops-inc", category: "devops" },
    { id: uncategorizedOrg, name: "Uncategorized", slug: "uncategorized", category: null },
  ]);

  const aiSrc = newSourceId();
  const devopsSrc = newSourceId();
  const uncatSrc = newSourceId();

  await db.insert(sources).values([
    {
      id: aiSrc,
      orgId: aiOrg,
      name: "AI Corp Releases",
      slug: "ai-corp-releases",
      type: "scrape",
      url: "https://ai-corp.example/changelog",
      discovery: "curated",
    },
    {
      id: devopsSrc,
      orgId: devopsOrg,
      name: "Devops Inc Releases",
      slug: "devops-inc-releases",
      type: "scrape",
      url: "https://devops-inc.example/changelog",
      discovery: "curated",
    },
    {
      id: uncatSrc,
      orgId: uncategorizedOrg,
      name: "Uncategorized Releases",
      slug: "uncategorized-releases",
      type: "scrape",
      url: "https://uncategorized.example/changelog",
      discovery: "curated",
    },
  ]);

  await db.insert(releases).values([
    {
      id: newReleaseId(),
      sourceId: aiSrc,
      title: "AI Corp 1.0",
      content: "first ai release",
      publishedAt: "2026-04-01T00:00:00Z",
    },
    {
      id: newReleaseId(),
      sourceId: devopsSrc,
      title: "Devops Inc 1.0",
      content: "first devops release",
      publishedAt: "2026-04-01T00:00:00Z",
    },
    {
      id: newReleaseId(),
      sourceId: uncatSrc,
      title: "Uncategorized 1.0",
      content: "first uncategorized release",
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

describe("MCP list_organizations — category filter", () => {
  it("(a) category alone filters to matching orgs", async () => {
    await seed(testDb.db);
    const db = asD1(testDb.db);

    const result = await listOrganizations(db, { category: "ai" });
    const text = bodyText(result);
    expect(text).toContain("AI Corp");
    expect(text).not.toContain("Devops Inc");
    expect(text).not.toContain("Uncategorized");
  });

  it("(b) category + query narrows to matching orgs in that category", async () => {
    await seed(testDb.db);
    const db = asD1(testDb.db);

    // "Inc" matches Devops Inc and Devops category — returns the devops org
    const result = await listOrganizations(db, { category: "devops", query: "Inc" });
    const text = bodyText(result);
    expect(text).toContain("Devops Inc");
    expect(text).not.toContain("AI Corp");
    expect(text).not.toContain("Uncategorized");
  });

  it("(c) category + include_empty includes empty orgs in that category", async () => {
    await seed(testDb.db);
    const db = asD1(testDb.db);

    // Add an empty org in the ai category
    const emptyAiOrg = newOrgId();
    await testDb.db
      .insert(organizations)
      .values({ id: emptyAiOrg, name: "Empty AI", slug: "empty-ai", category: "ai" });

    // Without include_empty: empty org hidden
    const filtered = bodyText(await listOrganizations(db, { category: "ai" }));
    expect(filtered).toContain("AI Corp");
    expect(filtered).not.toContain("Empty AI");

    // With include_empty: both visible
    const included = bodyText(await listOrganizations(db, { category: "ai", include_empty: true }));
    expect(included).toContain("AI Corp");
    expect(included).toContain("Empty AI");
    expect(included).not.toContain("Devops Inc");
  });

  it("(d) invalid category is ignored — returns unfiltered results", async () => {
    await seed(testDb.db);
    const db = asD1(testDb.db);

    // "not-a-category" is not in the CATEGORIES enum
    const result = await listOrganizations(db, { category: "not-a-category" });
    const text = bodyText(result);
    // All three orgs with releases should appear (fail-open)
    expect(text).toContain("AI Corp");
    expect(text).toContain("Devops Inc");
    expect(text).toContain("Uncategorized");
  });

  it("(e) totalItems reflects the category filter", async () => {
    await seed(testDb.db);
    const db = asD1(testDb.db);

    const result = await listOrganizations(db, { category: "ai" });
    expect(result._meta?.pagination).toMatchObject({
      kind: "page",
      totalItems: 1,
    });
  });
});
