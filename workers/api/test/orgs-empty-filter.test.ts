// Issue #746 — hide orgs that have zero indexed releases from the public
// catalog by default. The route exposes `?includeEmpty=true` as an opt-in
// and always returns `meta.emptyOrgCount` so a UI toggle can label itself.
import { describe, it, expect } from "bun:test";
import { organizations, sources, releases } from "@buildinternet/releases-core/schema";
import { orgRoutes } from "../src/routes/orgs.js";
import { createTestDb as mkDb, createTestApp } from "./setup";

const mkApp = (db: ReturnType<typeof mkDb>) => createTestApp(db, orgRoutes);

const NOW = "2026-05-15T12:00:00.000Z";

async function seed(db: ReturnType<typeof mkDb>) {
  // Two orgs with at least one visible release, one stub org with no source,
  // and one stub org that has a source but no releases. Both stubs should be
  // hidden by default and surfaced under `includeEmpty=true`.
  await db.insert(organizations).values([
    { id: "org_acme", slug: "acme", name: "Acme" },
    { id: "org_beta", slug: "beta", name: "Beta" },
    { id: "org_stub_a", slug: "stub-a", name: "Stub A" }, // no source at all
    { id: "org_stub_b", slug: "stub-b", name: "Stub B" }, // source but zero releases
  ]);
  await db.insert(sources).values([
    {
      id: "src_acme",
      orgId: "org_acme",
      slug: "acme-changelog",
      name: "Acme Changelog",
      type: "scrape",
      url: "https://acme.example/changelog",
      createdAt: NOW,
    },
    {
      id: "src_beta",
      orgId: "org_beta",
      slug: "beta-changelog",
      name: "Beta Changelog",
      type: "scrape",
      url: "https://beta.example/changelog",
      createdAt: NOW,
    },
    {
      id: "src_stub_b",
      orgId: "org_stub_b",
      slug: "stub-b-feed",
      name: "Stub B Feed",
      type: "feed",
      url: "https://stub-b.example/feed",
      createdAt: NOW,
    },
  ]);
  await db.insert(releases).values([
    {
      id: "rel_acme_1",
      sourceId: "src_acme",
      title: "Acme 1.0",
      content: "Initial release",
      publishedAt: NOW,
      fetchedAt: NOW,
    },
    {
      id: "rel_beta_1",
      sourceId: "src_beta",
      title: "Beta 1.0",
      content: "Initial release",
      publishedAt: NOW,
      fetchedAt: NOW,
    },
  ]);
}

describe("GET /v1/orgs — empty-org filter (#746)", () => {
  it("hides orgs with zero indexed releases by default and reports the count in meta", async () => {
    const db = mkDb();
    await seed(db);

    const res = await mkApp(db)(new Request("https://x.test/v1/orgs"));
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      items: Array<{ slug: string; releaseCount: number }>;
      pagination: { totalItems: number };
      meta?: { emptyOrgCount?: number };
    };

    expect(body.items.map((o) => o.slug).toSorted()).toEqual(["acme", "beta"]);
    expect(body.items.every((o) => o.releaseCount > 0)).toBe(true);
    expect(body.pagination.totalItems).toBe(2);
    expect(body.meta?.emptyOrgCount).toBe(2);
  });

  it("includes empty orgs when ?includeEmpty=true; meta still reports the empty subset", async () => {
    const db = mkDb();
    await seed(db);

    const res = await mkApp(db)(new Request("https://x.test/v1/orgs?includeEmpty=true"));
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      items: Array<{ slug: string; releaseCount: number }>;
      pagination: { totalItems: number };
      meta?: { emptyOrgCount?: number };
    };

    expect(body.items.map((o) => o.slug).toSorted()).toEqual(["acme", "beta", "stub-a", "stub-b"]);
    expect(body.pagination.totalItems).toBe(4);
    // Even when we're showing them, `meta.emptyOrgCount` keeps its meaning so a
    // toggle that reads it doesn't have to recompute on the second request.
    expect(body.meta?.emptyOrgCount).toBe(2);
  });

  it("respects ?q= scoping for both visible and meta counts", async () => {
    const db = mkDb();
    await seed(db);

    // Only "stub-b" matches by slug; default filter hides it (zero releases).
    const filtered = await mkApp(db)(new Request("https://x.test/v1/orgs?q=stub-b"));
    expect(filtered.status).toBe(200);
    const filteredBody = (await filtered.json()) as {
      items: Array<{ slug: string }>;
      pagination: { totalItems: number };
      meta?: { emptyOrgCount?: number };
    };
    expect(filteredBody.items).toEqual([]);
    expect(filteredBody.pagination.totalItems).toBe(0);
    expect(filteredBody.meta?.emptyOrgCount).toBe(1);

    // Same scope, opt in — the row surfaces.
    const included = await mkApp(db)(
      new Request("https://x.test/v1/orgs?q=stub-b&includeEmpty=true"),
    );
    const includedBody = (await included.json()) as {
      items: Array<{ slug: string }>;
      pagination: { totalItems: number };
      meta?: { emptyOrgCount?: number };
    };
    expect(includedBody.items.map((o) => o.slug)).toEqual(["stub-b"]);
    expect(includedBody.pagination.totalItems).toBe(1);
    expect(includedBody.meta?.emptyOrgCount).toBe(1);
  });
});
