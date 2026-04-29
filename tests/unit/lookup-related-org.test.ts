import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { createTestDb, type TestDatabase } from "../db-helper.js";
import { resolveRelatedOrg } from "../../workers/api/src/lib/lookup-related-org.js";
import { organizations, sources } from "@buildinternet/releases-core/schema";
import type { D1Db } from "../../workers/api/src/db.js";

// bun:sqlite fixtures satisfy the drizzle query surface used here; this cast
// matches the existing `asD1` pattern in tests/mcp-test-helpers.ts.
const asD1 = (db: TestDatabase["db"]): D1Db => db as unknown as D1Db;

let testDb: TestDatabase;

beforeEach(() => {
  testDb = createTestDb();
});

afterEach(() => {
  testDb.cleanup();
});

describe("resolveRelatedOrg", () => {
  test("matches by exact org slug", async () => {
    const db = testDb.db;
    await db.insert(organizations).values({
      id: "org_acme",
      name: "Acme",
      slug: "acme",
      discovery: "curated",
    });
    await db.insert(sources).values({
      id: "src_one",
      name: "Acme Foo",
      slug: "acme-foo",
      type: "github",
      url: "https://github.com/acme/foo",
      orgId: "org_acme",
      discovery: "curated",
    });

    const result = await resolveRelatedOrg(asD1(db), "acme");
    expect(result).not.toBeNull();
    expect(result?.org.slug).toBe("acme");
    expect(result?.sources).toHaveLength(1);
    expect(result?.sources[0]?.slug).toBe("acme-foo");
  });

  test("matches when github.com/{org} appears in an existing source URL", async () => {
    const db = testDb.db;
    await db.insert(organizations).values({
      id: "org_acme",
      name: "Acme",
      slug: "acme-corp",
      discovery: "curated",
    });
    await db.insert(sources).values({
      id: "src_one",
      name: "Acme Foo",
      slug: "acme-foo",
      type: "github",
      url: "https://github.com/acme/foo",
      orgId: "org_acme",
      discovery: "curated",
    });

    const result = await resolveRelatedOrg(asD1(db), "acme");
    expect(result?.org.slug).toBe("acme-corp");
  });

  test("returns null when no org matches", async () => {
    const result = await resolveRelatedOrg(asD1(testDb.db), "missing");
    expect(result).toBeNull();
  });

  test("returns null when on_demand orgs would be the only match", async () => {
    const db = testDb.db;
    await db.insert(organizations).values({
      id: "org_one",
      name: "On-demand",
      slug: "ondemand",
      discovery: "on_demand",
    });
    const result = await resolveRelatedOrg(asD1(db), "ondemand");
    expect(result).toBeNull();
  });

  test("returns null when multiple curated orgs match (ambiguous)", async () => {
    const db = testDb.db;
    await db.insert(organizations).values([
      { id: "org_a", name: "Apple Inc", slug: "apple", discovery: "curated" },
      { id: "org_b", name: "Apple Records", slug: "apple-records", discovery: "curated" },
    ]);
    await db.insert(sources).values([
      {
        id: "src_a",
        name: "a",
        slug: "a",
        type: "github",
        url: "https://github.com/apple/foo",
        orgId: "org_a",
        discovery: "curated",
      },
      {
        id: "src_b",
        name: "b",
        slug: "b",
        type: "github",
        url: "https://github.com/apple/bar",
        orgId: "org_b",
        discovery: "curated",
      },
    ]);
    const result = await resolveRelatedOrg(asD1(db), "apple");
    expect(result).toBeNull();
  });

  test("caps returned sources at 5", async () => {
    const db = testDb.db;
    await db.insert(organizations).values({
      id: "org_acme",
      name: "Acme",
      slug: "acme",
      discovery: "curated",
    });
    await db.insert(sources).values(
      Array.from({ length: 8 }, (_, i) => ({
        id: `src_${i}`,
        name: `Source ${i}`,
        slug: `acme-src-${i}`,
        type: "github" as const,
        url: `https://github.com/acme/repo-${i}`,
        orgId: "org_acme",
        discovery: "curated" as const,
      })),
    );
    const result = await resolveRelatedOrg(asD1(db), "acme");
    expect(result?.sources.length).toBeLessThanOrEqual(5);
  });
});
