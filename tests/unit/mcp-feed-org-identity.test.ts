/**
 * Org identity on feed rows. The release-feed MCP App renders a company icon
 * (org avatar, with a GitHub-handle fallback) and a human-readable label, so
 * every `ReleaseFeedRow` from `get_latest_releases` / `get_collection_releases`
 * must carry `org { name, slug, avatarUrl, githubHandle }`, `source.type`
 * (to branch GitHub coordinate vs. display name), and `product { name, slug }`.
 */

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import {
  organizations,
  sources,
  releases,
  products,
  orgAccounts,
  collections,
  collectionMembers,
} from "@buildinternet/releases-core/schema";
import { createTestDb, type TestDatabase } from "../db-helper.js";
import { asD1 } from "../mcp-test-helpers.js";
import { getLatestReleases, getCollectionReleases } from "../../workers/mcp/src/tools.js";

interface FeedRow {
  id: string;
  source: { name: string; coordinate: string; type: string };
  org: { name: string; slug: string; avatarUrl: string | null; githubHandle: string | null } | null;
  product: { name: string; slug: string } | null;
}

let testDb: TestDatabase;

beforeEach(async () => {
  testDb = createTestDb();
  await testDb.db.insert(organizations).values({
    id: "org_vercel",
    name: "Vercel",
    slug: "vercel",
    discovery: "curated",
    avatarUrl: "https://media.releases.sh/orgs/vercel.png",
  });
  await testDb.db
    .insert(orgAccounts)
    .values({ id: "oa_vercel", orgId: "org_vercel", platform: "github", handle: "vercel" });
  await testDb.db
    .insert(products)
    .values({ id: "prod_next", orgId: "org_vercel", name: "Next.js", slug: "next-js" });
  await testDb.db.insert(sources).values({
    id: "src_next_blog",
    orgId: "org_vercel",
    productId: "prod_next",
    name: "Next.js Blog",
    slug: "next-js-blog",
    type: "feed",
    url: "https://nextjs.org/blog",
    discovery: "curated",
  });
  await testDb.db.insert(releases).values({
    id: "rel_next_1",
    sourceId: "src_next_blog",
    title: "Next.js 15",
    type: "feature",
    content: "Body.",
    publishedAt: "2026-05-01T00:00:00Z",
  });
});

afterEach(() => testDb.cleanup());

describe("get_latest_releases — structured org identity", () => {
  it("carries org avatar/handle, source.type, and product on each row", async () => {
    const out = await getLatestReleases(asD1(testDb.db), {});
    const rows = (out.structuredContent as unknown as { releases: FeedRow[] }).releases;
    expect(rows).toHaveLength(1);
    const row = rows[0];
    expect(row.source.type).toBe("feed");
    expect(row.org).toEqual({
      name: "Vercel",
      slug: "vercel",
      avatarUrl: "https://media.releases.sh/orgs/vercel.png",
      githubHandle: "vercel",
    });
    expect(row.product).toEqual({ name: "Next.js", slug: "next-js" });
  });
});

describe("get_collection_releases — structured org identity", () => {
  beforeEach(async () => {
    await testDb.db.insert(collections).values({ id: "col_x", slug: "frontier", name: "Frontier" });
    await testDb.db
      .insert(collectionMembers)
      .values({ collectionId: "col_x", orgId: "org_vercel", position: 0 });
  });

  it("carries org avatar/handle, source.type, and product on each row", async () => {
    const out = await getCollectionReleases(asD1(testDb.db), { slug: "frontier" });
    const rows = (out.structuredContent as unknown as { releases: FeedRow[] }).releases;
    expect(rows).toHaveLength(1);
    const row = rows[0];
    expect(row.source.type).toBe("feed");
    expect(row.org).toEqual({
      name: "Vercel",
      slug: "vercel",
      avatarUrl: "https://media.releases.sh/orgs/vercel.png",
      githubHandle: "vercel",
    });
    expect(row.product).toEqual({ name: "Next.js", slug: "next-js" });
  });
});
