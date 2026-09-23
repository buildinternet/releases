import { describe, it, expect } from "bun:test";
import {
  organizations,
  orgTags,
  productTags,
  products,
  sources,
  tags,
} from "@buildinternet/releases-core/schema";
import { ReleasesJsonDomainSchema } from "@buildinternet/releases-api-types";
import { createTestDb } from "../../../test/setup.js";
import { buildOrgManifest } from "./export-manifest.js";

type Db = ReturnType<typeof createTestDb>;

async function seedOrg(db: Db, over: Partial<typeof organizations.$inferInsert> = {}) {
  const [org] = await db
    .insert(organizations)
    .values({
      name: "Acme",
      slug: "acme",
      domain: "acme.com",
      description: "Acme makes things",
      category: "developer-tools",
      avatarUrl: "https://media.releases.sh/orgs/acme.png",
      ...over,
    })
    .returning();
  return org;
}

async function addProduct(db: Db, orgId: string, over: Partial<typeof products.$inferInsert>) {
  const [product] = await db
    .insert(products)
    .values({ orgId, name: "Prod", slug: "prod", ...over })
    .returning();
  return product;
}

async function addSource(db: Db, orgId: string, over: Partial<typeof sources.$inferInsert>) {
  const [source] = await db
    .insert(sources)
    .values({
      orgId,
      name: "Src",
      slug: `src-${Math.round(over.isPrimary ? 1 : 0)}-${over.type ?? "scrape"}-${over.url ?? ""}`,
      type: "scrape",
      url: "https://acme.com/changelog",
      ...over,
    })
    .returning();
  return source;
}

describe("buildOrgManifest", () => {
  it("reconstructs a valid v2 domain manifest from live products + sources", async () => {
    const db = createTestDb();
    const org = await seedOrg(db);
    const api = await addProduct(db, org.id, {
      name: "Acme API",
      slug: "acme-api",
      description: "The API",
      url: "https://acme.com/api",
      kind: "platform",
      category: "developer-tools",
    });

    // A github source (canonical) + a feed source under the product.
    await addSource(db, org.id, {
      type: "github",
      url: "https://github.com/acme/api",
      productId: api.id,
      isPrimary: true,
    });
    await addSource(db, org.id, {
      type: "feed",
      url: "https://acme.com/api/news",
      productId: api.id,
      metadata: JSON.stringify({ feedUrl: "https://acme.com/api/feed.xml" }),
    });
    // An unlinked scrape source → top-level releases[].
    await addSource(db, org.id, { type: "scrape", url: "https://acme.com/blog", productId: null });

    const manifest = await buildOrgManifest(db as never, org);

    // Strong assertion: it satisfies the published schema the sweep enforces.
    expect(ReleasesJsonDomainSchema.safeParse(manifest).success).toBe(true);

    expect(manifest.version).toBe(2);
    expect(manifest.name).toBe("Acme");
    expect(manifest.category).toBe("developer-tools");
    expect(manifest.avatar).toBe("https://media.releases.sh/orgs/acme.png");

    const product = manifest.products?.find((p) => p.slug === "acme-api");
    expect(product?.website).toBe("https://acme.com/api");
    expect(product?.kind).toBe("platform");
    // github coordinate extracted; primary → canonical; feed routed via metadata.
    expect(product?.releases).toEqual([
      { github: "acme/api", canonical: true },
      { feed: "https://acme.com/api/feed.xml" },
    ]);
    // Unlinked source rides the top level.
    expect(manifest.releases).toEqual([{ url: "https://acme.com/blog" }]);
  });

  it("maps an appstore source and a github-override scrape source", async () => {
    const db = createTestDb();
    const org = await seedOrg(db, { slug: "beta", domain: "beta.com" });
    await addSource(db, org.id, {
      type: "appstore",
      url: "https://apps.apple.com/us/app/beta/id123",
    });
    // A scrape source whose fetch is overridden to a github repo via metadata.
    await addSource(db, org.id, {
      type: "scrape",
      url: "https://beta.com/docs/releases",
      metadata: JSON.stringify({ githubUrl: "https://github.com/beta/core" }),
    });

    const manifest = await buildOrgManifest(db as never, org);
    expect(ReleasesJsonDomainSchema.safeParse(manifest).success).toBe(true);
    const locators = manifest.releases ?? [];
    expect(locators).toContainEqual({ appstore: "https://apps.apple.com/us/app/beta/id123" });
    expect(locators).toContainEqual({ github: "beta/core" });
  });

  it("excludes hidden and soft-deleted sources", async () => {
    const db = createTestDb();
    const org = await seedOrg(db, { slug: "gamma", domain: "gamma.com" });
    await addSource(db, org.id, { type: "scrape", url: "https://gamma.com/visible" });
    await addSource(db, org.id, {
      type: "scrape",
      url: "https://gamma.com/hidden",
      isHidden: true,
    });
    await addSource(db, org.id, {
      type: "scrape",
      url: "https://gamma.com/deleted",
      deletedAt: new Date().toISOString(),
    });

    const manifest = await buildOrgManifest(db as never, org);
    expect(manifest.releases).toEqual([{ url: "https://gamma.com/visible" }]);
  });

  it("keeps at most one canonical per array", async () => {
    const db = createTestDb();
    const org = await seedOrg(db, { slug: "delta", domain: "delta.com" });
    await addSource(db, org.id, { type: "scrape", url: "https://delta.com/a", isPrimary: true });
    await addSource(db, org.id, { type: "scrape", url: "https://delta.com/b", isPrimary: true });

    const manifest = await buildOrgManifest(db as never, org);
    expect(ReleasesJsonDomainSchema.safeParse(manifest).success).toBe(true);
    const canonicalCount = (manifest.releases ?? []).filter((r) => r.canonical).length;
    expect(canonicalCount).toBe(1);
  });

  it("surfaces org tags and product tags", async () => {
    const db = createTestDb();
    const org = await seedOrg(db, { slug: "epsilon", domain: "epsilon.com" });
    const [tagCi] = await db.insert(tags).values({ name: "ci", slug: "ci" }).returning();
    const [tagCloud] = await db.insert(tags).values({ name: "cloud", slug: "cloud" }).returning();
    await db.insert(orgTags).values({ orgId: org.id, tagId: tagCi.id });
    const product = await addProduct(db, org.id, { name: "Runner", slug: "runner" });
    await db.insert(productTags).values({ productId: product.id, tagId: tagCloud.id });
    await addSource(db, org.id, {
      type: "scrape",
      url: "https://epsilon.com/runner",
      productId: product.id,
    });

    const manifest = await buildOrgManifest(db as never, org);
    expect(manifest.tags).toEqual(["ci"]);
    expect(manifest.products?.[0]?.tags).toEqual(["cloud"]);
  });
});
