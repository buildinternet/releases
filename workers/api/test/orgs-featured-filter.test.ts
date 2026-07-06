// Editorial home-page featured filter on the orgs list.
// ?featured=true restricts to orgs with featured=1; default returns all.
// PATCH /v1/orgs/:slug { featured: true } sets the flag (round-trip test).
// meta.emptyOrgCount and totalItems stay scoped to the featured filter.
import { describe, it, expect } from "bun:test";
import { organizations, sources, releases } from "@buildinternet/releases-core/schema";
import { orgRoutes } from "../src/routes/orgs.js";
import { createTestDb as mkDb, createTestApp } from "./setup";

const mkApp = (db: ReturnType<typeof mkDb>) => createTestApp(db, orgRoutes);

const NOW = "2026-05-30T12:00:00.000Z";

async function seed(db: ReturnType<typeof mkDb>) {
  // One featured org with a release, one non-featured org with a release,
  // and one featured org with NO releases (empty) so we can verify count scoping.
  await db.insert(organizations).values([
    { id: "org_featured", slug: "featured-co", name: "Featured Co", featured: true },
    { id: "org_regular", slug: "regular-co", name: "Regular Co", featured: false },
    { id: "org_featured_empty", slug: "featured-empty", name: "Featured Empty", featured: true },
  ]);
  await db.insert(sources).values([
    {
      id: "src_featured",
      orgId: "org_featured",
      slug: "featured-changelog",
      name: "Featured Changelog",
      type: "scrape",
      url: "https://featured.example/changelog",
      createdAt: NOW,
    },
    {
      id: "src_regular",
      orgId: "org_regular",
      slug: "regular-changelog",
      name: "Regular Changelog",
      type: "scrape",
      url: "https://regular.example/changelog",
      createdAt: NOW,
    },
  ]);
  await db.insert(releases).values([
    {
      id: "rel_featured_1",
      sourceId: "src_featured",
      title: "Featured 1.0",
      content: "Initial release",
      publishedAt: NOW,
      fetchedAt: NOW,
    },
    {
      id: "rel_regular_1",
      sourceId: "src_regular",
      title: "Regular 1.0",
      content: "Initial release",
      publishedAt: NOW,
      fetchedAt: NOW,
    },
  ]);
}

type ListBody = {
  items: Array<{ slug: string; featured: boolean }>;
  pagination: { totalItems: number };
  meta?: { emptyOrgCount?: number };
};

describe("GET /v1/orgs — featured filter", () => {
  it("?featured=true returns only orgs with featured=1", async () => {
    const db = mkDb();
    await seed(db);

    const res = await mkApp(db)(new Request("https://x.test/v1/orgs?featured=true"));
    expect(res.status).toBe(200);
    const body = (await res.json()) as ListBody;

    // Only the featured org with a release is returned; featured-empty is hidden
    // (no releases); regular-co is excluded by the featured filter.
    expect(body.items.map((o) => o.slug)).toEqual(["featured-co"]);
    expect(body.items.every((o) => o.featured === true)).toBe(true);
    expect(body.pagination.totalItems).toBe(1);
    // featured-empty has no releases — counted in emptyOrgCount, scoped to featured=1.
    expect(body.meta?.emptyOrgCount).toBe(1);
  });

  it("default (no ?featured param) returns all orgs regardless of featured flag", async () => {
    const db = mkDb();
    await seed(db);

    const res = await mkApp(db)(new Request("https://x.test/v1/orgs"));
    expect(res.status).toBe(200);
    const body = (await res.json()) as ListBody;

    // Both orgs with releases are returned; featured-empty is hidden (no releases).
    expect(body.items.map((o) => o.slug).toSorted()).toEqual(["featured-co", "regular-co"]);
    expect(body.pagination.totalItems).toBe(2);
    // Two empty featured slots are collapsed: featured-empty has none.
    expect(body.meta?.emptyOrgCount).toBe(1);
  });

  it("meta.emptyOrgCount and totalItems are scoped to the featured filter", async () => {
    const db = mkDb();
    await seed(db);

    // With featured filter: only 1 non-empty featured org visible, 1 empty featured org counted.
    const featuredRes = await mkApp(db)(new Request("https://x.test/v1/orgs?featured=true"));
    const featuredBody = (await featuredRes.json()) as ListBody;
    expect(featuredBody.pagination.totalItems).toBe(1);
    expect(featuredBody.meta?.emptyOrgCount).toBe(1);

    // Without filter: both orgs with releases shown, 1 empty org total.
    const allRes = await mkApp(db)(new Request("https://x.test/v1/orgs"));
    const allBody = (await allRes.json()) as ListBody;
    expect(allBody.pagination.totalItems).toBe(2);
    expect(allBody.meta?.emptyOrgCount).toBe(1);
  });

  it("PATCH /v1/orgs/:slug { featured: true } then GET ?featured=true includes it (round-trip)", async () => {
    const db = mkDb();
    await seed(db);

    // regular-co starts as non-featured. Promote it.
    const patchRes = await mkApp(db)(
      new Request("https://x.test/v1/orgs/regular-co", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ featured: true }),
      }),
    );
    expect(patchRes.status).toBe(200);

    // Now ?featured=true should include regular-co.
    const listRes = await mkApp(db)(new Request("https://x.test/v1/orgs?featured=true"));
    const listBody = (await listRes.json()) as ListBody;
    expect(listBody.items.map((o) => o.slug).toSorted()).toEqual(["featured-co", "regular-co"]);
    expect(listBody.items.every((o) => o.featured === true)).toBe(true);
  });
});

describe("GET /v1/orgs — admin trackingRequested filter (#1947 phase 2)", () => {
  function secretBinding(value: string) {
    return { get: async () => value };
  }

  function adminEnv() {
    return { RELEASES_API_KEY: secretBinding("root-secret") };
  }

  function adminHeaders() {
    return { Authorization: "Bearer root-secret" };
  }

  async function seedTracking(db: ReturnType<typeof mkDb>) {
    await db.insert(organizations).values([
      { id: "org_plain", slug: "plain-org", name: "Plain Org" },
      {
        id: "org_stamped",
        slug: "stamped-org",
        name: "Stamped Org",
        trackingRequestedAt: "2026-06-01T00:00:00.000Z",
      },
      {
        id: "org_stamped_later",
        slug: "stamped-later-org",
        name: "Stamped Later Org",
        trackingRequestedAt: "2026-06-15T00:00:00.000Z",
      },
    ]);
  }

  it("?trackingRequested=1 without admin auth returns 403", async () => {
    const db = mkDb();
    await seedTracking(db);

    const res = await createTestApp(db, orgRoutes, { env: adminEnv() })(
      new Request("https://x.test/v1/orgs?trackingRequested=1"),
    );
    expect(res.status).toBe(403);
  });

  it("?trackingRequested=1 with admin auth returns only stamped orgs, ordered desc, with the stamp", async () => {
    const db = mkDb();
    await seedTracking(db);

    const res = await createTestApp(db, orgRoutes, { env: adminEnv() })(
      new Request("https://x.test/v1/orgs?trackingRequested=1", { headers: adminHeaders() }),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      items: Array<{ slug: string; trackingRequestedAt?: string | null }>;
      pagination: { totalItems?: number; totalPages?: number };
    };
    expect(body.items.map((o) => o.slug)).toEqual(["stamped-later-org", "stamped-org"]);
    expect(body.items.every((o) => Boolean(o.trackingRequestedAt))).toBe(true);
    expect(body.pagination.totalItems).toBe(2);
    if (body.pagination.totalPages !== undefined) {
      expect(body.pagination.totalPages).toBe(1);
    }
  });

  it("?trackingRequested=1 excludes soft-deleted orgs even if trackingRequestedAt survived the tombstone", async () => {
    const db = mkDb();
    await seedTracking(db);
    await db.insert(organizations).values({
      id: "org_deleted_stamped",
      slug: "deleted-stamped-org--org_deleted_stamped",
      name: "Deleted Stamped Org",
      trackingRequestedAt: "2026-06-20T00:00:00.000Z",
      deletedAt: "2026-06-21T00:00:00.000Z",
    });

    const res = await createTestApp(db, orgRoutes, { env: adminEnv() })(
      new Request("https://x.test/v1/orgs?trackingRequested=1", { headers: adminHeaders() }),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      items: Array<{ slug: string }>;
      pagination: { totalItems?: number };
    };
    expect(body.items.map((o) => o.slug)).toEqual(["stamped-later-org", "stamped-org"]);
    expect(body.pagination.totalItems).toBe(2);
  });

  it("plain list without the param is unchanged and never exposes trackingRequestedAt", async () => {
    const db = mkDb();
    await seedTracking(db);

    const res = await createTestApp(db, orgRoutes, { env: adminEnv() })(
      new Request("https://x.test/v1/orgs"),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      items: Array<Record<string, unknown>>;
    };
    // trackingRequestedAt never appears on the public projection.
    for (const item of body.items) {
      expect(item).not.toHaveProperty("trackingRequestedAt");
    }
  });
});

describe("GET /v1/orgs/:slug — featured in detail response", () => {
  it("returns featured=true when org is featured", async () => {
    const db = mkDb();
    await seed(db);

    const res = await mkApp(db)(new Request("https://x.test/v1/orgs/featured-co"));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { slug: string; featured: boolean };
    expect(body.slug).toBe("featured-co");
    expect(body.featured).toBe(true);
  });

  it("returns featured=false when org is not featured", async () => {
    const db = mkDb();
    await seed(db);

    const res = await mkApp(db)(new Request("https://x.test/v1/orgs/regular-co"));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { slug: string; featured: boolean };
    expect(body.slug).toBe("regular-co");
    expect(body.featured).toBe(false);
  });
});
