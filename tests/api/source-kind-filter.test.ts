/**
 * Tests for Task 6: kind filter on list endpoints.
 * /v1/sources?kind=, /v1/products?kind=, /v1/orgs/:slug/releases?kind=,
 * and /v1/orgs/:slug/catalog?kind= (entity kind — distinct from ?entryType=).
 */
import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { organizations, products, sources, releases } from "@buildinternet/releases-core/schema";
import { productRoutes } from "../../workers/api/src/routes/products.js";
import { sourceRoutes } from "../../workers/api/src/routes/sources.js";
import { orgRoutes } from "../../workers/api/src/routes/orgs.js";
import { createTestDb, type TestDatabase } from "../db-helper.js";

let testDb: TestDatabase;

beforeEach(() => {
  testDb = createTestDb();
});

afterEach(() => {
  testDb.cleanup();
});

function makeEnv() {
  return { DB: testDb.db as unknown as never };
}

const noopCtx = { waitUntil: () => {}, passThroughOnException: () => {} };

async function callSource(path: string): Promise<Response> {
  return sourceRoutes.request(
    path,
    { method: "GET" },
    makeEnv(),
    noopCtx as unknown as Parameters<typeof sourceRoutes.request>[3],
  );
}

async function callProduct(path: string): Promise<Response> {
  return productRoutes.request(
    path,
    { method: "GET" },
    makeEnv(),
    noopCtx as unknown as Parameters<typeof productRoutes.request>[3],
  );
}

async function callOrg(path: string): Promise<Response> {
  return orgRoutes.request(
    path,
    { method: "GET" },
    makeEnv(),
    noopCtx as unknown as Parameters<typeof orgRoutes.request>[3],
  );
}

async function seedOrg(slug = "acme") {
  await testDb.db.insert(organizations).values({
    id: `org_${slug}`,
    name: slug,
    slug,
    discovery: "curated",
  });
}

async function seedProduct(opts: {
  id: string;
  slug: string;
  orgSlug?: string;
  kind?: string | null;
}) {
  await testDb.db.insert(products).values({
    id: opts.id,
    name: opts.slug,
    slug: opts.slug,
    orgId: `org_${opts.orgSlug ?? "acme"}`,
    kind: opts.kind ?? null,
  });
}

async function seedSource(opts: {
  id: string;
  slug: string;
  orgSlug?: string;
  productId?: string | null;
  kind?: string | null;
}) {
  await testDb.db.insert(sources).values({
    id: opts.id,
    orgId: `org_${opts.orgSlug ?? "acme"}`,
    slug: opts.slug,
    name: opts.slug,
    url: `https://example.com/${opts.slug}`,
    type: "feed",
    metadata: "{}",
    kind: opts.kind ?? null,
    productId: opts.productId ?? null,
  });
}

async function seedRelease(opts: { id: string; sourceId: string; title: string }) {
  await testDb.db.insert(releases).values({
    id: opts.id,
    sourceId: opts.sourceId,
    title: opts.title,
    content: "",
    url: `https://example.com/${opts.id}`,
    publishedAt: "2024-01-01T00:00:00Z",
  });
}

// ---------------------------------------------------------------------------
// /v1/sources?kind=
// ---------------------------------------------------------------------------

describe("GET /v1/sources?kind= filter", () => {
  it("returns only sources with matching kind", async () => {
    await seedOrg("acme");
    await seedSource({ id: "src_a", slug: "a", kind: "sdk" });
    await seedSource({ id: "src_b", slug: "b", kind: "docs" });
    await seedSource({ id: "src_c", slug: "c", kind: null });

    const res = await callSource("/sources?kind=sdk&orgSlug=acme");
    expect(res.status).toBe(200);
    const body = (await res.json()) as Array<{ slug: string }>;
    expect(body.map((s) => s.slug)).toEqual(["a"]);
  });

  it("returns 400 on unknown kind value", async () => {
    const res = await callSource("/sources?kind=framework");
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("bad_request");
  });

  it("returns all sources when kind is omitted", async () => {
    await seedOrg("acme");
    await seedSource({ id: "src_d", slug: "d", kind: "sdk" });
    await seedSource({ id: "src_e", slug: "e", kind: "docs" });

    const res = await callSource("/sources?orgSlug=acme");
    expect(res.status).toBe(200);
    const body = (await res.json()) as Array<{ slug: string }>;
    expect(body.length).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// /v1/products?kind=
// ---------------------------------------------------------------------------

describe("GET /v1/products?kind= filter", () => {
  it("returns only products with matching kind", async () => {
    await seedOrg("acme");
    await seedProduct({ id: "prod_p1", slug: "p1", kind: "sdk" });
    await seedProduct({ id: "prod_p2", slug: "p2", kind: "platform" });

    const res = await callProduct("/products?kind=sdk&orgId=org_acme");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { items: Array<{ slug: string }> };
    expect(body.items.map((p) => p.slug)).toEqual(["p1"]);
  });

  it("returns 400 on unknown kind value", async () => {
    const res = await callProduct("/products?kind=framework");
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("bad_request");
  });

  it("returns all products when kind is omitted", async () => {
    await seedOrg("acme");
    await seedProduct({ id: "prod_q1", slug: "q1", kind: "sdk" });
    await seedProduct({ id: "prod_q2", slug: "q2", kind: "platform" });

    const res = await callProduct("/products?orgId=org_acme");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { items: Array<{ slug: string }> };
    expect(body.items.length).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// /v1/orgs/:slug/releases?kind=
// ---------------------------------------------------------------------------

describe("GET /v1/orgs/:slug/releases?kind= filter", () => {
  it("returns only releases from sources with matching kind", async () => {
    await seedOrg("acme");
    await seedSource({ id: "src_sdk", slug: "sdk-src", kind: "sdk" });
    await seedSource({ id: "src_plat", slug: "platform-src", kind: "platform" });
    await seedRelease({ id: "rel_sdk", sourceId: "src_sdk", title: "sdk release" });
    await seedRelease({ id: "rel_plat", sourceId: "src_plat", title: "platform release" });

    const res = await callOrg("/orgs/acme/releases?kind=platform");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { releases: Array<{ title: string }> };
    const titles = body.releases.map((r) => r.title);
    expect(titles).toEqual(["platform release"]);
  });

  it("resolves kind through parent product when source.kind is null", async () => {
    await seedOrg("acme");
    await seedProduct({ id: "prod_py", slug: "py", kind: "sdk" });
    await seedSource({ id: "src_py", slug: "py-src", productId: "prod_py", kind: null });
    await seedRelease({ id: "rel_py", sourceId: "src_py", title: "py update" });

    const res = await callOrg("/orgs/acme/releases?kind=sdk");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { releases: Array<{ title: string }> };
    expect(body.releases.map((r) => r.title)).toEqual(["py update"]);
  });

  it("returns 400 on unknown kind value", async () => {
    await seedOrg("acme");
    const res = await callOrg("/orgs/acme/releases?kind=framework");
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("bad_request");
  });

  it("returns all releases when kind is omitted", async () => {
    await seedOrg("acme");
    await seedSource({ id: "src_m1", slug: "m1", kind: "sdk" });
    await seedSource({ id: "src_m2", slug: "m2", kind: "platform" });
    await seedRelease({ id: "rel_m1", sourceId: "src_m1", title: "m1 release" });
    await seedRelease({ id: "rel_m2", sourceId: "src_m2", title: "m2 release" });

    const res = await callOrg("/orgs/acme/releases");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { releases: Array<{ title: string }> };
    expect(body.releases.length).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// /v1/orgs/:slug/catalog?kind= (entity kind filter — distinct from ?entryType=)
// ---------------------------------------------------------------------------

describe("GET /v1/orgs/:slug/catalog?kind= filter", () => {
  it("?entryType=product preserves existing entry-type filter (no regression)", async () => {
    await seedOrg("acme");
    await seedProduct({ id: "prod_cat1", slug: "cat-prod", kind: "sdk" });
    await seedSource({ id: "src_cat1", slug: "cat-src", kind: "docs" });

    const res = await callOrg("/orgs/acme/catalog?entryType=product");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { items: Array<{ entryType: string }> };
    expect(body.items.every((i) => i.entryType === "product")).toBe(true);
  });

  it("?kind= filters products by entity kind", async () => {
    await seedOrg("acme");
    await seedProduct({ id: "prod_sdk1", slug: "sdk-prod", kind: "sdk" });
    await seedProduct({ id: "prod_plat1", slug: "plat-prod", kind: "platform" });

    const res = await callOrg("/orgs/acme/catalog?kind=sdk&entryType=product");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { items: Array<{ slug: string }> };
    expect(body.items.map((i) => i.slug)).toEqual(["sdk-prod"]);
  });

  it("?kind= filters sources by entity kind", async () => {
    await seedOrg("acme");
    await seedSource({ id: "src_sdk1", slug: "sdk-src-cat", kind: "sdk" });
    await seedSource({ id: "src_docs1", slug: "docs-src-cat", kind: "docs" });

    const res = await callOrg("/orgs/acme/catalog?kind=sdk&entryType=source");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { items: Array<{ slug: string }> };
    expect(body.items.map((i) => i.slug)).toEqual(["sdk-src-cat"]);
  });

  it("?kind= does NOT inherit kind from parent product (catalog is metadata-oriented)", async () => {
    // Contract: catalog `?kind=` filters on the row's own kind, with no
    // source→product fallback. This is intentionally asymmetric with the
    // releases feed (`/orgs/:slug/releases?kind=`), which COALESCEs through
    // product.kind. Rationale: catalog answers "which rows are classified as
    // X?" while the feed answers "which content belongs to kind X?".
    await seedOrg("acme");
    await seedProduct({ id: "prod_py", slug: "py", kind: "sdk" });
    await seedSource({ id: "src_py", slug: "py-src", productId: "prod_py", kind: null });

    const res = await callOrg("/orgs/acme/catalog?kind=sdk&entryType=source");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { items: Array<{ slug: string }> };
    // Source's own kind is null, parent product is `sdk`, but catalog does
    // not inherit — the source is excluded.
    expect(body.items.map((i) => i.slug)).toEqual([]);
  });

  it("returns 400 on unknown entity kind value", async () => {
    await seedOrg("acme");
    const res = await callOrg("/orgs/acme/catalog?kind=framework");
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("bad_request");
  });

  it("?entryType= returns 400 on unknown entry type value", async () => {
    await seedOrg("acme");
    const res = await callOrg("/orgs/acme/catalog?entryType=unknown");
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("bad_request");
  });
});
