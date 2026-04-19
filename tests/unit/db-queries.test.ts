import { describe, it, expect, beforeEach, afterAll } from "bun:test";
import { eq, desc } from "drizzle-orm";
import { createTestDb, type TestDatabase } from "../db-helper.js";
import {
  organizations,
  sources,
  releases,
  orgAccounts,
  ignoredUrls,
  blockedUrls,
  products,
  tags,
  orgTags,
  productTags,
} from "@releases/core-internal/schema";

let testDatabase: TestDatabase;

function getDb() {
  return testDatabase.db;
}

// Create one DB for the entire file, clear tables between tests
testDatabase = createTestDb();

afterAll(() => {
  testDatabase.cleanup();
});

// ---------------------------------------------------------------------------
// Organizations
// ---------------------------------------------------------------------------
describe("Organizations CRUD", () => {
  beforeEach(() => {
    const db = getDb();
    // Clear in dependency order
    db.delete(orgTags).run();
    db.delete(productTags).run();
    db.delete(releases).run();
    db.delete(sources).run();
    db.delete(orgAccounts).run();
    db.delete(products).run();
    db.delete(ignoredUrls).run();
    db.delete(tags).run();
    db.delete(organizations).run();
    db.delete(blockedUrls).run();
  });

  it("inserts an org with auto-generated ID and timestamps", () => {
    const db = getDb();
    db.insert(organizations)
      .values({ name: "Acme Corp", slug: "acme" })
      .run();

    const rows = db.select().from(organizations).all();
    expect(rows).toHaveLength(1);
    expect(rows[0].id).toMatch(/^org_/);
    expect(rows[0].name).toBe("Acme Corp");
    expect(rows[0].createdAt).toBeTruthy();
    expect(rows[0].updatedAt).toBeTruthy();
  });

  it("finds an org by slug", () => {
    const db = getDb();
    db.insert(organizations)
      .values({ name: "Vercel", slug: "vercel" })
      .run();

    const found = db
      .select()
      .from(organizations)
      .where(eq(organizations.slug, "vercel"))
      .get();

    expect(found).toBeDefined();
    expect(found!.name).toBe("Vercel");
  });

  it("persists category on insert", () => {
    const db = getDb();
    db.insert(organizations)
      .values({ name: "OpenAI", slug: "openai", category: "ai" })
      .run();

    const row = db
      .select()
      .from(organizations)
      .where(eq(organizations.slug, "openai"))
      .get();

    expect(row!.category).toBe("ai");
  });

  it("rejects duplicate slugs", () => {
    const db = getDb();
    db.insert(organizations)
      .values({ name: "First", slug: "same-slug" })
      .run();

    expect(() => {
      db.insert(organizations)
        .values({ name: "Second", slug: "same-slug" })
        .run();
    }).toThrow();
  });

  it("persists avatarUrl on insert", () => {
    const db = getDb();
    db.insert(organizations)
      .values({ name: "Avatar Org", slug: "avatar-org", avatarUrl: "https://example.com/logo.png" })
      .run();

    const row = db.select().from(organizations).where(eq(organizations.slug, "avatar-org")).get();
    expect(row).toBeDefined();
    expect(row!.avatarUrl).toBe("https://example.com/logo.png");
  });

  it("avatarUrl defaults to null when not provided", () => {
    const db = getDb();
    db.insert(organizations)
      .values({ name: "No Avatar", slug: "no-avatar" })
      .run();

    const row = db.select().from(organizations).where(eq(organizations.slug, "no-avatar")).get();
    expect(row).toBeDefined();
    expect(row!.avatarUrl).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Sources
// ---------------------------------------------------------------------------
describe("Sources CRUD", () => {
  let orgId: string;

  beforeEach(() => {
    const db = getDb();
    db.delete(orgTags).run();
    db.delete(productTags).run();
    db.delete(releases).run();
    db.delete(sources).run();
    db.delete(orgAccounts).run();
    db.delete(products).run();
    db.delete(ignoredUrls).run();
    db.delete(tags).run();
    db.delete(organizations).run();
    db.delete(blockedUrls).run();

    const org = db
      .insert(organizations)
      .values({ name: "TestOrg", slug: "testorg" })
      .returning()
      .get();
    orgId = org.id;
  });

  it("inserts a source linked to an org", () => {
    const db = getDb();
    db.insert(sources)
      .values({
        name: "TestOrg Releases",
        slug: "testorg-releases",
        type: "github",
        url: "https://github.com/testorg/repo/releases",
        orgId,
      })
      .run();

    const rows = db.select().from(sources).all();
    expect(rows).toHaveLength(1);
    expect(rows[0].id).toMatch(/^src_/);
    expect(rows[0].orgId).toBe(orgId);
  });

  it("stores metadata JSON", () => {
    const db = getDb();
    const meta = JSON.stringify({ feedUrl: "https://example.com/feed.xml", feedType: "rss" });
    db.insert(sources)
      .values({
        name: "Feed Source",
        slug: "feed-source",
        type: "feed",
        url: "https://example.com/changelog",
        orgId,
        metadata: meta,
      })
      .run();

    const row = db.select().from(sources).where(eq(sources.slug, "feed-source")).get();
    expect(JSON.parse(row!.metadata!)).toEqual({
      feedUrl: "https://example.com/feed.xml",
      feedType: "rss",
    });
  });

  it("rejects duplicate source slugs", () => {
    const db = getDb();
    db.insert(sources)
      .values({
        name: "Source A",
        slug: "dupe-slug",
        type: "scrape",
        url: "https://a.com",
        orgId,
      })
      .run();

    expect(() => {
      db.insert(sources)
        .values({
          name: "Source B",
          slug: "dupe-slug",
          type: "scrape",
          url: "https://b.com",
          orgId,
        })
        .run();
    }).toThrow();
  });

  it("allows source without an org (null orgId)", () => {
    const db = getDb();
    db.insert(sources)
      .values({
        name: "Orphan Source",
        slug: "orphan",
        type: "scrape",
        url: "https://orphan.com/changelog",
      })
      .run();

    const row = db.select().from(sources).where(eq(sources.slug, "orphan")).get();
    expect(row).toBeDefined();
    expect(row!.orgId).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Releases
// ---------------------------------------------------------------------------
describe("Releases", () => {
  let sourceId: string;

  beforeEach(() => {
    const db = getDb();
    db.delete(orgTags).run();
    db.delete(productTags).run();
    db.delete(releases).run();
    db.delete(sources).run();
    db.delete(orgAccounts).run();
    db.delete(products).run();
    db.delete(ignoredUrls).run();
    db.delete(tags).run();
    db.delete(organizations).run();
    db.delete(blockedUrls).run();

    const org = db
      .insert(organizations)
      .values({ name: "RelOrg", slug: "relorg" })
      .returning()
      .get();

    const src = db
      .insert(sources)
      .values({
        name: "RelSource",
        slug: "relsource",
        type: "github",
        url: "https://github.com/relorg/repo/releases",
        orgId: org.id,
      })
      .returning()
      .get();
    sourceId = src.id;
  });

  it("inserts releases for a source", () => {
    const db = getDb();
    db.insert(releases)
      .values([
        {
          sourceId,
          title: "v1.0.0",
          content: "Initial release",
          url: "https://example.com/v1",
          publishedAt: "2025-01-01T00:00:00Z",
        },
        {
          sourceId,
          title: "v1.1.0",
          content: "Second release",
          url: "https://example.com/v1.1",
          publishedAt: "2025-02-01T00:00:00Z",
        },
      ])
      .run();

    const rows = db.select().from(releases).where(eq(releases.sourceId, sourceId)).all();
    expect(rows).toHaveLength(2);
    expect(rows[0].id).toMatch(/^rel_/);
  });

  it("defaults type to 'feature' when unset", () => {
    const db = getDb();
    db.insert(releases)
      .values({
        sourceId,
        title: "v2.0.0",
        content: "Release",
        url: "https://example.com/v2",
      })
      .run();

    const row = db.select().from(releases).where(eq(releases.sourceId, sourceId)).get();
    expect(row?.type).toBe("feature");
  });

  it("persists type='rollup' when set", () => {
    const db = getDb();
    db.insert(releases)
      .values({
        sourceId,
        title: "Fall Release 2025",
        content: "Quarterly rollup",
        url: "https://example.com/fall-2025",
        type: "rollup",
      })
      .run();

    const row = db.select().from(releases).where(eq(releases.sourceId, sourceId)).get();
    expect(row?.type).toBe("rollup");
  });

  it("prevents duplicate URLs for the same source", () => {
    const db = getDb();
    db.insert(releases)
      .values({
        sourceId,
        title: "v1.0.0",
        content: "First",
        url: "https://example.com/same-url",
      })
      .run();

    expect(() => {
      db.insert(releases)
        .values({
          sourceId,
          title: "v1.0.0 duplicate",
          content: "Second",
          url: "https://example.com/same-url",
        })
        .run();
    }).toThrow();
  });

  it("allows duplicate content hashes for the same source (dedup is URL-based)", () => {
    // The UNIQUE(source_id, content_hash) index was dropped because it
    // silently 500'd the batch upsert whenever a re-fetch produced the same
    // content under a drifted URL. URL-based upsert is the primary dedup path.
    const db = getDb();
    db.insert(releases)
      .values({
        sourceId,
        title: "v1.0.0",
        content: "Some content",
        url: "https://example.com/a",
        contentHash: "abc123",
      })
      .run();

    db.insert(releases)
      .values({
        sourceId,
        title: "v1.0.1",
        content: "Different title same hash",
        url: "https://example.com/b",
        contentHash: "abc123",
      })
      .run();

    const rows = db.select().from(releases).where(eq(releases.sourceId, sourceId)).all();
    expect(rows).toHaveLength(2);
  });

  it("orders by publishedAt descending", () => {
    const db = getDb();
    db.insert(releases)
      .values([
        {
          sourceId,
          title: "Old",
          content: "old release",
          url: "https://example.com/old",
          publishedAt: "2024-01-01T00:00:00Z",
        },
        {
          sourceId,
          title: "New",
          content: "new release",
          url: "https://example.com/new",
          publishedAt: "2025-06-01T00:00:00Z",
        },
        {
          sourceId,
          title: "Mid",
          content: "mid release",
          url: "https://example.com/mid",
          publishedAt: "2025-03-01T00:00:00Z",
        },
      ])
      .run();

    const rows = db
      .select()
      .from(releases)
      .where(eq(releases.sourceId, sourceId))
      .orderBy(desc(releases.publishedAt))
      .all();

    expect(rows.map((r) => r.title)).toEqual(["New", "Mid", "Old"]);
  });

  it("filters out suppressed releases", () => {
    const db = getDb();
    db.insert(releases)
      .values([
        {
          sourceId,
          title: "Visible",
          content: "visible",
          url: "https://example.com/visible",
          suppressed: false,
        },
        {
          sourceId,
          title: "Hidden",
          content: "hidden",
          url: "https://example.com/hidden",
          suppressed: true,
          suppressedReason: "spam",
        },
      ])
      .run();

    const visible = db
      .select()
      .from(releases)
      .where(eq(releases.suppressed, false))
      .all();

    expect(visible).toHaveLength(1);
    expect(visible[0].title).toBe("Visible");
  });
});

// ---------------------------------------------------------------------------
// Org Accounts
// ---------------------------------------------------------------------------
describe("Org Accounts", () => {
  let orgId: string;

  beforeEach(() => {
    const db = getDb();
    db.delete(orgTags).run();
    db.delete(productTags).run();
    db.delete(releases).run();
    db.delete(sources).run();
    db.delete(orgAccounts).run();
    db.delete(products).run();
    db.delete(ignoredUrls).run();
    db.delete(tags).run();
    db.delete(organizations).run();
    db.delete(blockedUrls).run();

    const org = db
      .insert(organizations)
      .values({ name: "AccountOrg", slug: "accountorg" })
      .returning()
      .get();
    orgId = org.id;
  });

  it("links a GitHub account to an org", () => {
    const db = getDb();
    db.insert(orgAccounts)
      .values({ orgId, platform: "github", handle: "acme-corp" })
      .run();

    const rows = db
      .select()
      .from(orgAccounts)
      .where(eq(orgAccounts.orgId, orgId))
      .all();

    expect(rows).toHaveLength(1);
    expect(rows[0].platform).toBe("github");
    expect(rows[0].handle).toBe("acme-corp");
  });

  it("enforces unique (platform, handle) constraint", () => {
    const db = getDb();
    db.insert(orgAccounts)
      .values({ orgId, platform: "github", handle: "unique-handle" })
      .run();

    // Even for a different org, same platform+handle should fail
    const org2 = db
      .insert(organizations)
      .values({ name: "Org2", slug: "org2" })
      .returning()
      .get();

    expect(() => {
      db.insert(orgAccounts)
        .values({ orgId: org2.id, platform: "github", handle: "unique-handle" })
        .run();
    }).toThrow();
  });

  it("cascades delete when org is removed", () => {
    const db = getDb();
    db.insert(orgAccounts)
      .values({ orgId, platform: "github", handle: "cascade-test" })
      .run();

    // Verify account exists
    let accounts = db.select().from(orgAccounts).all();
    expect(accounts).toHaveLength(1);

    // Delete the org
    db.delete(organizations).where(eq(organizations.id, orgId)).run();

    // Account should be gone
    accounts = db.select().from(orgAccounts).all();
    expect(accounts).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Products
// ---------------------------------------------------------------------------
describe("Products", () => {
  let orgId: string;

  beforeEach(() => {
    const db = getDb();
    db.delete(orgTags).run();
    db.delete(productTags).run();
    db.delete(releases).run();
    db.delete(sources).run();
    db.delete(orgAccounts).run();
    db.delete(products).run();
    db.delete(ignoredUrls).run();
    db.delete(tags).run();
    db.delete(organizations).run();
    db.delete(blockedUrls).run();

    const org = db
      .insert(organizations)
      .values({ name: "Vercel", slug: "vercel" })
      .returning()
      .get();
    orgId = org.id;
  });

  it("creates a product under an org", () => {
    const db = getDb();
    db.insert(products)
      .values({ name: "Next.js", slug: "nextjs", orgId })
      .run();

    const rows = db.select().from(products).where(eq(products.orgId, orgId)).all();
    expect(rows).toHaveLength(1);
    expect(rows[0].id).toMatch(/^prod_/);
    expect(rows[0].name).toBe("Next.js");
  });

  it("cascades delete when org is removed", () => {
    const db = getDb();
    db.insert(products)
      .values({ name: "Turborepo", slug: "turborepo", orgId })
      .run();

    db.delete(organizations).where(eq(organizations.id, orgId)).run();

    const rows = db.select().from(products).all();
    expect(rows).toHaveLength(0);
  });

  it("stores category on a product", () => {
    const db = getDb();
    db.insert(products)
      .values({ name: "Next.js", slug: "nextjs", orgId, category: "framework" })
      .run();

    const row = db.select().from(products).where(eq(products.slug, "nextjs")).get();
    expect(row!.category).toBe("framework");
  });
});

// ---------------------------------------------------------------------------
// Tags
// ---------------------------------------------------------------------------
describe("Tags", () => {
  let orgId: string;
  let productId: string;

  beforeEach(() => {
    const db = getDb();
    db.delete(orgTags).run();
    db.delete(productTags).run();
    db.delete(releases).run();
    db.delete(sources).run();
    db.delete(orgAccounts).run();
    db.delete(products).run();
    db.delete(ignoredUrls).run();
    db.delete(tags).run();
    db.delete(organizations).run();
    db.delete(blockedUrls).run();

    const org = db
      .insert(organizations)
      .values({ name: "TagOrg", slug: "tagorg" })
      .returning()
      .get();
    orgId = org.id;

    const prod = db
      .insert(products)
      .values({ name: "TagProduct", slug: "tagproduct", orgId })
      .returning()
      .get();
    productId = prod.id;
  });

  it("creates a tag with slug", () => {
    const db = getDb();
    const tag = db
      .insert(tags)
      .values({ name: "TypeScript", slug: "typescript" })
      .returning()
      .get();

    expect(tag.id).toMatch(/^tag_/);
    expect(tag.slug).toBe("typescript");
  });

  it("associates a tag with an org via orgTags", () => {
    const db = getDb();
    const tag = db
      .insert(tags)
      .values({ name: "Edge", slug: "edge" })
      .returning()
      .get();

    db.insert(orgTags).values({ orgId, tagId: tag.id }).run();

    const rows = db.select().from(orgTags).where(eq(orgTags.orgId, orgId)).all();
    expect(rows).toHaveLength(1);
    expect(rows[0].tagId).toBe(tag.id);
  });

  it("associates a tag with a product via productTags", () => {
    const db = getDb();
    const tag = db
      .insert(tags)
      .values({ name: "React", slug: "react" })
      .returning()
      .get();

    db.insert(productTags).values({ productId, tagId: tag.id }).run();

    const rows = db
      .select()
      .from(productTags)
      .where(eq(productTags.productId, productId))
      .all();
    expect(rows).toHaveLength(1);
    expect(rows[0].tagId).toBe(tag.id);
  });

  it("enforces unique constraint on orgTags join", () => {
    const db = getDb();
    const tag = db
      .insert(tags)
      .values({ name: "Serverless", slug: "serverless" })
      .returning()
      .get();

    db.insert(orgTags).values({ orgId, tagId: tag.id }).run();

    expect(() => {
      db.insert(orgTags).values({ orgId, tagId: tag.id }).run();
    }).toThrow();
  });

  it("enforces unique constraint on productTags join", () => {
    const db = getDb();
    const tag = db
      .insert(tags)
      .values({ name: "CLI", slug: "cli" })
      .returning()
      .get();

    db.insert(productTags).values({ productId, tagId: tag.id }).run();

    expect(() => {
      db.insert(productTags).values({ productId, tagId: tag.id }).run();
    }).toThrow();
  });
});

// ---------------------------------------------------------------------------
// Ignored URLs (org-scoped)
// ---------------------------------------------------------------------------
describe("Ignored URLs", () => {
  let orgId1: string;
  let orgId2: string;

  beforeEach(() => {
    const db = getDb();
    db.delete(orgTags).run();
    db.delete(productTags).run();
    db.delete(releases).run();
    db.delete(sources).run();
    db.delete(orgAccounts).run();
    db.delete(products).run();
    db.delete(ignoredUrls).run();
    db.delete(tags).run();
    db.delete(organizations).run();
    db.delete(blockedUrls).run();

    const org1 = db
      .insert(organizations)
      .values({ name: "IgnOrg1", slug: "ignorg1" })
      .returning()
      .get();
    orgId1 = org1.id;

    const org2 = db
      .insert(organizations)
      .values({ name: "IgnOrg2", slug: "ignorg2" })
      .returning()
      .get();
    orgId2 = org2.id;
  });

  it("adds an ignored URL for an org", () => {
    const db = getDb();
    db.insert(ignoredUrls)
      .values({ url: "https://spam.example.com", orgId: orgId1, reason: "not a changelog" })
      .run();

    const rows = db
      .select()
      .from(ignoredUrls)
      .where(eq(ignoredUrls.orgId, orgId1))
      .all();

    expect(rows).toHaveLength(1);
    expect(rows[0].url).toBe("https://spam.example.com");
    expect(rows[0].reason).toBe("not a changelog");
  });

  it("allows the same URL to be ignored for different orgs", () => {
    const db = getDb();
    const sharedUrl = "https://shared.example.com/blog";

    db.insert(ignoredUrls).values({ url: sharedUrl, orgId: orgId1 }).run();
    db.insert(ignoredUrls).values({ url: sharedUrl, orgId: orgId2 }).run();

    const all = db.select().from(ignoredUrls).all();
    expect(all).toHaveLength(2);
  });

  it("rejects duplicate (org, url) pairs", () => {
    const db = getDb();
    db.insert(ignoredUrls)
      .values({ url: "https://dupe.example.com", orgId: orgId1 })
      .run();

    expect(() => {
      db.insert(ignoredUrls)
        .values({ url: "https://dupe.example.com", orgId: orgId1 })
        .run();
    }).toThrow();
  });
});

// ---------------------------------------------------------------------------
// Blocked URLs (global)
// ---------------------------------------------------------------------------
describe("Blocked URLs", () => {
  beforeEach(() => {
    const db = getDb();
    db.delete(blockedUrls).run();
  });

  it("adds a blocked URL pattern", () => {
    const db = getDb();
    db.insert(blockedUrls)
      .values({ pattern: "spam-domain.com", type: "domain", reason: "known spam" })
      .run();

    const rows = db.select().from(blockedUrls).all();
    expect(rows).toHaveLength(1);
    expect(rows[0].id).toMatch(/^bu_/);
    expect(rows[0].type).toBe("domain");
  });

  it("enforces unique pattern constraint", () => {
    const db = getDb();
    db.insert(blockedUrls)
      .values({ pattern: "https://bad.example.com/page", type: "exact" })
      .run();

    expect(() => {
      db.insert(blockedUrls)
        .values({ pattern: "https://bad.example.com/page", type: "exact" })
        .run();
    }).toThrow();
  });
});
