import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { createTestDb, type TestDatabase } from "../../../tests/db-helper.js";
import { organizations, products, sources, releases } from "@buildinternet/releases-core/schema";
import { user } from "../src/db/schema-auth.js";
import { addFollow } from "../src/queries/follows.js";
import { getFollowedReleases } from "../src/queries/releases.js";

let h: TestDatabase;

beforeEach(async () => {
  h = createTestDb();
  await h.db.insert(user).values({
    id: "u1",
    name: "T",
    email: "t@e.com",
    emailVerified: false,
    createdAt: new Date(),
    updatedAt: new Date(),
  });
  await h.db.insert(organizations).values({ id: "org_a", name: "Acme", slug: "acme" });
  await h.db
    .insert(products)
    .values({ id: "prd_p", name: "Widget", slug: "widget", orgId: "org_a" });
  await h.db
    .insert(sources)
    .values({
      id: "src_org",
      name: "Blog",
      slug: "blog",
      type: "feed",
      url: "https://a/blog",
      orgId: "org_a",
    });
  await h.db
    .insert(sources)
    .values({
      id: "src_prd",
      name: "Notes",
      slug: "notes",
      type: "feed",
      url: "https://a/notes",
      orgId: "org_a",
      productId: "prd_p",
    });
  await h.db.insert(organizations).values({ id: "org_b", name: "Other", slug: "other" });
  await h.db
    .insert(sources)
    .values({ id: "src_b", name: "B", slug: "b", type: "feed", url: "https://b", orgId: "org_b" });

  const mkRel = (id: string, sourceId: string, when: string) =>
    h.db.insert(releases).values({
      id,
      sourceId,
      title: id,
      content: "x",
      type: "feature",
      publishedAt: when,
      fetchedAt: when,
    });
  await mkRel("rel_org", "src_org", "2026-01-01T00:00:00Z");
  await mkRel("rel_prd", "src_prd", "2026-01-02T00:00:00Z");
  await mkRel("rel_b", "src_b", "2026-01-03T00:00:00Z");
});

afterEach(() => h.cleanup());

describe("getFollowedReleases", () => {
  it("following an org includes its products' releases (org follow = everything)", async () => {
    await addFollow(h.db, "u1", "org", "org_a");
    const rows = await getFollowedReleases(h.db, "u1", { limit: 50, offset: 0 });
    const ids = rows.map((r) => r.id).sort();
    expect(ids).toEqual(["rel_org", "rel_prd"]);
    expect(ids).not.toContain("rel_b");
  });

  it("following only a product narrows to that product", async () => {
    await addFollow(h.db, "u1", "product", "prd_p");
    const rows = await getFollowedReleases(h.db, "u1", { limit: 50, offset: 0 });
    expect(rows.map((r) => r.id)).toEqual(["rel_prd"]);
  });

  it("returns empty for a user with no follows", async () => {
    const rows = await getFollowedReleases(h.db, "u1", { limit: 50, offset: 0 });
    expect(rows).toEqual([]);
  });

  it("orders newest-first and respects limit/offset", async () => {
    await addFollow(h.db, "u1", "org", "org_a");
    const page1 = await getFollowedReleases(h.db, "u1", { limit: 1, offset: 0 });
    expect(page1.map((r) => r.id)).toEqual(["rel_prd"]);
    const page2 = await getFollowedReleases(h.db, "u1", { limit: 1, offset: 1 });
    expect(page2.map((r) => r.id)).toEqual(["rel_org"]);
  });
});
