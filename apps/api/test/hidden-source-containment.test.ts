import { describe, expect, it } from "bun:test";
import { organizations, products, releases, sources } from "@buildinternet/releases-core/schema";
import { orgRoutes } from "../src/routes/orgs.js";
import { searchRoutes } from "../src/routes/search.js";
import { sourceRoutes } from "../src/routes/sources.js";
import { createTestApp, createTestDb } from "./setup.js";

const NOW = "2026-07-01T12:00:00.000Z";

async function seedContainmentFixture(db: ReturnType<typeof createTestDb>) {
  await db.insert(organizations).values([
    {
      id: "org_hidden_containment",
      slug: "hidden-containment",
      name: "Hidden Containment",
    },
    {
      id: "org_visible_containment",
      slug: "visible-containment",
      name: "Visible Containment",
    },
  ]);
  await db.insert(products).values([
    {
      id: "prod_hidden_containment",
      orgId: "org_hidden_containment",
      slug: "hidden-product",
      name: "Hidden Containment Product",
    },
    {
      id: "prod_visible_containment",
      orgId: "org_visible_containment",
      slug: "visible-product",
      name: "Visible Containment Product",
    },
  ]);
  await db.insert(sources).values([
    {
      id: "src_hidden_containment",
      orgId: "org_hidden_containment",
      productId: "prod_hidden_containment",
      slug: "hidden-source",
      name: "Hidden Containment Source",
      type: "feed",
      url: "https://hidden.example/releases",
      isHidden: true,
      createdAt: NOW,
    },
    {
      id: "src_visible_containment",
      orgId: "org_visible_containment",
      productId: "prod_visible_containment",
      slug: "visible-source",
      name: "Visible Containment Source",
      type: "feed",
      url: "https://visible.example/releases",
      isHidden: false,
      createdAt: NOW,
    },
  ]);
  await db.insert(releases).values([
    {
      id: "rel_hidden_containment",
      sourceId: "src_hidden_containment",
      title: "Hidden Containment Release",
      content: "Hidden containment release body",
      publishedAt: NOW,
      fetchedAt: NOW,
    },
    {
      id: "rel_visible_containment",
      sourceId: "src_visible_containment",
      title: "Visible Containment Release",
      content: "Visible containment release body",
      publishedAt: NOW,
      fetchedAt: NOW,
    },
  ]);
}

describe("hidden-source containment on public read surfaces", () => {
  it("excludes hidden-source data while retaining a visible sibling", async () => {
    const db = createTestDb();
    await seedContainmentFixture(db);
    const app = createTestApp(db, [orgRoutes, sourceRoutes, searchRoutes], { env: {} });

    const hiddenFeed = await app(new Request("https://x.test/v1/orgs/hidden-containment/releases"));
    expect(hiddenFeed.status).toBe(200);
    expect(((await hiddenFeed.json()) as { releases: unknown[] }).releases).toEqual([]);

    const visibleFeed = await app(
      new Request("https://x.test/v1/orgs/visible-containment/releases"),
    );
    expect(visibleFeed.status).toBe(200);
    expect(
      ((await visibleFeed.json()) as { releases: Array<{ id: string }> }).releases.map((r) => r.id),
    ).toEqual(["rel_visible_containment"]);

    const hiddenRelease = await app(
      new Request("https://x.test/v1/releases/rel_hidden_containment"),
    );
    expect(hiddenRelease.status).toBe(404);
    const visibleRelease = await app(
      new Request("https://x.test/v1/releases/rel_visible_containment"),
    );
    expect(visibleRelease.status).toBe(200);

    const catalog = await app(new Request("https://x.test/v1/orgs"));
    expect(catalog.status).toBe(200);
    expect(
      ((await catalog.json()) as { items: Array<{ slug: string }> }).items.map((o) => o.slug),
    ).toEqual(["visible-containment"]);

    const hiddenOrg = await app(new Request("https://x.test/v1/orgs/hidden-containment"));
    expect(hiddenOrg.status).toBe(200);
    const hiddenOrgBody = (await hiddenOrg.json()) as {
      products: Array<{ slug: string }>;
      sources: Array<{ slug: string }>;
    };
    expect(hiddenOrgBody.products).toEqual([]);
    expect(hiddenOrgBody.sources).toEqual([]);

    const visibleOrg = await app(new Request("https://x.test/v1/orgs/visible-containment"));
    expect(visibleOrg.status).toBe(200);
    const visibleOrgBody = (await visibleOrg.json()) as {
      products: Array<{ slug: string }>;
      sources: Array<{ slug: string }>;
    };
    expect(visibleOrgBody.products.map((p) => p.slug)).toEqual(["visible-product"]);
    expect(visibleOrgBody.sources.map((s) => s.slug)).toEqual(["visible-source"]);

    // ?include_hidden=true is admin-only: an anonymous caller can't use it to
    // enumerate hidden sources (would otherwise defeat the whole containment).
    const anonIncludeHidden = await app(
      new Request("https://x.test/v1/sources?include_hidden=true"),
    );
    expect(anonIncludeHidden.status).toBe(200);
    const anonSourceSlugs = ((await anonIncludeHidden.json()) as Array<{ slug: string }>).map(
      (s) => s.slug,
    );
    expect(anonSourceSlugs).toContain("visible-source");
    expect(anonSourceSlugs).not.toContain("hidden-source");

    const search = await app(new Request("https://x.test/v1/search?q=Containment&mode=lexical"));
    expect(search.status).toBe(200);
    const searchBody = (await search.json()) as {
      orgs: Array<{ slug: string }>;
      catalog: Array<{ slug: string }>;
    };
    expect(searchBody.orgs.map((o) => o.slug)).toEqual(["visible-containment"]);
    expect(searchBody.catalog.map((p) => p.slug)).toEqual(["visible-product"]);
  });
});
