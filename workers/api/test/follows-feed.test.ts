import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { createTestDb, type TestDatabase } from "../../../tests/db-helper.js";
import { organizations, products, sources, releases } from "@buildinternet/releases-core/schema";
import { user } from "../src/db/schema-auth.js";
import { addFollow } from "../src/queries/follows.js";
import { feedCursorFromLatestRow, getFollowedReleases } from "../src/queries/releases.js";

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
  await h.db.insert(sources).values({
    id: "src_org",
    name: "Blog",
    slug: "blog",
    type: "feed",
    url: "https://a/blog",
    orgId: "org_a",
  });
  await h.db.insert(sources).values({
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
    const rows = await getFollowedReleases(h.db, "u1", { limit: 50 });
    const ids = rows.map((r) => r.id).toSorted();
    expect(ids).toEqual(["rel_org", "rel_prd"]);
    expect(ids).not.toContain("rel_b");
  });

  it("following only a product narrows to that product", async () => {
    await addFollow(h.db, "u1", "product", "prd_p");
    const rows = await getFollowedReleases(h.db, "u1", { limit: 50 });
    expect(rows.map((r) => r.id)).toEqual(["rel_prd"]);
  });

  it("returns empty for a user with no follows", async () => {
    const rows = await getFollowedReleases(h.db, "u1", { limit: 50 });
    expect(rows).toEqual([]);
  });

  it("orders newest-first and paginates via cursor", async () => {
    await addFollow(h.db, "u1", "org", "org_a");
    const page1 = await getFollowedReleases(h.db, "u1", { limit: 1 });
    expect(page1.map((r) => r.id)).toEqual(["rel_prd"]);

    const page2 = await getFollowedReleases(h.db, "u1", {
      limit: 1,
      cursor: feedCursorFromLatestRow(page1[0]!),
    });
    expect(page2.map((r) => r.id)).toEqual(["rel_org"]);
  });

  it("does not duplicate the cursor anchor when a release lands between pages", async () => {
    await addFollow(h.db, "u1", "org", "org_a");
    const page1 = await getFollowedReleases(h.db, "u1", { limit: 1 });
    expect(page1.map((r) => r.id)).toEqual(["rel_prd"]);

    // Lands between rel_prd (2026-01-02) and rel_org (2026-01-01) — older than
    // the page-1 anchor, so page 2 must pick it up without re-emitting rel_prd.
    await h.db.insert(releases).values({
      id: "rel_between",
      sourceId: "src_org",
      title: "Between",
      content: "x",
      type: "feature",
      publishedAt: "2026-01-01T12:00:00Z",
      fetchedAt: "2026-01-01T12:00:00Z",
    });

    const page2 = await getFollowedReleases(h.db, "u1", {
      limit: 10,
      cursor: feedCursorFromLatestRow(page1[0]!),
    });
    const ids = page2.map((r) => r.id);
    expect(ids).not.toContain("rel_prd");
    expect(ids).toEqual(["rel_between", "rel_org"]);
  });

  it("filters by the ingest-time watermark window", async () => {
    await addFollow(h.db, "u1", "org", "org_a");
    await h.db.insert(releases).values([
      {
        id: "rel_old",
        sourceId: "src_org",
        title: "Old",
        content: "x",
        url: "https://a/1",
        publishedAt: "2026-01-01T00:00:00.000Z",
        fetchedAt: "2026-01-01T00:00:00.000Z",
      },
      {
        id: "rel_in",
        sourceId: "src_org",
        title: "In window",
        content: "x",
        url: "https://a/2",
        publishedAt: "2026-06-05T00:00:00.000Z",
        fetchedAt: "2026-06-05T00:00:00.000Z",
      },
      {
        id: "rel_future",
        sourceId: "src_org",
        title: "After runStart",
        content: "x",
        url: "https://a/3",
        publishedAt: "2026-06-09T23:00:00.000Z",
        fetchedAt: "2026-06-09T23:00:00.000Z",
      },
    ]);

    const rows = await getFollowedReleases(h.db, "u1", {
      limit: 50,
      fetchedAfter: "2026-06-01T00:00:00.000Z",
      fetchedBefore: "2026-06-09T13:00:00.000Z",
    });

    expect(rows.map((r) => r.id)).toEqual(["rel_in"]);
  });

  // The window is on ingest, not publish: a post that went live before the previous
  // run but that we only fetched afterwards still belongs to exactly one digest —
  // the run after we saw it. Windowing on published_at dropped it from both.
  it("delivers a release published before the window but ingested inside it", async () => {
    await addFollow(h.db, "u1", "org", "org_a");
    await h.db.insert(releases).values([
      {
        id: "rel_late",
        sourceId: "src_org",
        title: "Published pre-window, fetched in-window",
        content: "x",
        url: "https://a/1",
        publishedAt: "2026-06-08T10:00:00.000Z",
        fetchedAt: "2026-06-08T15:00:00.000Z",
      },
      {
        // Published at the exact instant the previous run fired — the boundary case
        // a `published_at >` window excluded from every digest, forever.
        id: "rel_boundary",
        sourceId: "src_org",
        title: "Published on the watermark",
        content: "x",
        url: "https://a/2",
        publishedAt: "2026-06-08T13:00:00.000Z",
        fetchedAt: "2026-06-08T16:00:00.000Z",
      },
    ]);

    const rows = await getFollowedReleases(h.db, "u1", {
      limit: 50,
      fetchedAfter: "2026-06-08T13:00:00.000Z",
      fetchedBefore: "2026-06-09T13:00:00.000Z",
      publishedFloor: "2026-05-09T13:00:00.000Z",
    });

    expect(rows.map((r) => r.id).sort()).toEqual(["rel_boundary", "rel_late"]);
  });

  it("floors a backfill's old posts but keeps undated rows", async () => {
    await addFollow(h.db, "u1", "org", "org_a");
    await h.db.insert(releases).values([
      {
        // Ancient post, freshly re-ingested by a history backfill.
        id: "rel_backfilled",
        sourceId: "src_org",
        title: "Ancient",
        content: "x",
        url: "https://a/1",
        publishedAt: "2024-01-01T00:00:00.000Z",
        fetchedAt: "2026-06-08T15:00:00.000Z",
      },
      {
        // No publish date is not evidence of age — keep it.
        id: "rel_undated",
        sourceId: "src_org",
        title: "Undated",
        content: "x",
        url: "https://a/2",
        publishedAt: null,
        fetchedAt: "2026-06-08T15:00:00.000Z",
      },
    ]);

    const rows = await getFollowedReleases(h.db, "u1", {
      limit: 50,
      fetchedAfter: "2026-06-08T13:00:00.000Z",
      fetchedBefore: "2026-06-09T13:00:00.000Z",
      publishedFloor: "2026-05-09T13:00:00.000Z",
    });

    expect(rows.map((r) => r.id)).toEqual(["rel_undated"]);
  });
});
