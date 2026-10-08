/**
 * Products and sources share the public `/{org}/{slug}` namespace, so within
 * one org a product slug and a source slug may never be equal. Covers every
 * API write path: product adopt, source create (auto-suffix skips product
 * slugs) and source PATCH rename. Product create is covered in
 * orgs-resolve.test.ts; the sitemap product set in sitemap.test.ts.
 */
import { describe, it, expect } from "bun:test";
import { eq } from "drizzle-orm";
import { organizations, products, sources } from "@buildinternet/releases-core/schema";
import { respondError } from "../src/lib/error-response.js";
import { productRoutes } from "../src/routes/products.js";
import { sourceRoutes } from "../src/routes/sources.js";
import { createTestDb as mkDb, createTestApp, type TestDb } from "./setup";

const statusHubStub = {
  idFromName: () => "stub-id",
  get: () => ({ fetch: async () => new Response("ok", { status: 200 }) }),
};

const mkApp = (db: TestDb) =>
  createTestApp(db, [productRoutes, sourceRoutes], {
    env: { STATUS_HUB: statusHubStub },
    onError: (err, c) => respondError(c, err),
  });

const json = (method: string, body: unknown) => ({
  method,
  headers: { "content-type": "application/json" },
  body: JSON.stringify(body),
});

async function seedOrg(db: TestDb) {
  await db.insert(organizations).values([{ id: "org_acme", slug: "acme", name: "Acme" }]);
}

const createSource = (fetch: ReturnType<typeof mkApp>, name: string, url: string) =>
  fetch(new Request("https://x.test/v1/sources", json("POST", { name, url, orgSlug: "acme" })));

describe("source create skips slugs held by a product", () => {
  it("falls to `<base>-releases` when the base slug is a product", async () => {
    const db = mkDb();
    await seedOrg(db);
    await db
      .insert(products)
      .values({ id: "prod_cli", name: "CLI", slug: "cli", orgId: "org_acme" });
    const res = await createSource(mkApp(db), "CLI", "https://acme.test/cli");
    expect(res.status).toBe(201);
    expect(((await res.json()) as { slug: string }).slug).toBe("cli-releases");
  });

  it("falls to `<base>-2` when `<base>-releases` is also taken", async () => {
    const db = mkDb();
    await seedOrg(db);
    await db.insert(products).values([
      { id: "prod_cli", name: "CLI", slug: "cli", orgId: "org_acme" },
      { id: "prod_cli_rel", name: "CLI Rel", slug: "cli-releases", orgId: "org_acme" },
    ]);
    const res = await createSource(mkApp(db), "CLI", "https://acme.test/cli");
    expect(res.status).toBe(201);
    expect(((await res.json()) as { slug: string }).slug).toBe("cli-2");
  });

  it("falls to `-2` when `<base>-releases` is held by a source", async () => {
    const db = mkDb();
    await seedOrg(db);
    await db
      .insert(products)
      .values({ id: "prod_cli", name: "CLI", slug: "cli", orgId: "org_acme" });
    await db.insert(sources).values({
      id: "src_rel",
      name: "x",
      slug: "cli-releases",
      orgId: "org_acme",
      type: "feed",
      url: "https://acme.test/x",
    });
    const res = await createSource(mkApp(db), "CLI", "https://acme.test/cli");
    expect(((await res.json()) as { slug: string }).slug).toBe("cli-2");
  });

  it("a tombstoned (deleted) product does not block the base slug", async () => {
    const db = mkDb();
    await seedOrg(db);
    await db.insert(products).values({
      id: "prod_gone",
      name: "CLI",
      slug: "cli",
      orgId: "org_acme",
      deletedAt: new Date().toISOString(),
    });
    const res = await createSource(mkApp(db), "CLI", "https://acme.test/cli");
    expect(res.status).toBe(201);
    expect(((await res.json()) as { slug: string }).slug).toBe("cli");
  });

  it("a product in another org does not block the slug", async () => {
    const db = mkDb();
    await seedOrg(db);
    await db.insert(organizations).values({ id: "org_other", slug: "other", name: "Other" });
    await db
      .insert(products)
      .values({ id: "prod_o", name: "CLI", slug: "cli", orgId: "org_other" });
    const res = await createSource(mkApp(db), "CLI", "https://acme.test/cli");
    expect(((await res.json()) as { slug: string }).slug).toBe("cli");
  });
});

describe("source PATCH rename", () => {
  async function seedSource(db: TestDb) {
    await seedOrg(db);
    await db.insert(sources).values({
      id: "src_a",
      name: "A",
      slug: "a-feed",
      orgId: "org_acme",
      type: "feed",
      url: "https://acme.test/a",
    });
  }
  const rename = (fetch: ReturnType<typeof mkApp>, slug: string) =>
    fetch(new Request("https://x.test/v1/orgs/acme/sources/a-feed", json("PATCH", { slug })));

  it("409s when a live product in the org holds the new slug", async () => {
    const db = mkDb();
    await seedSource(db);
    await db
      .insert(products)
      .values({ id: "prod_cli", name: "CLI", slug: "cli", orgId: "org_acme" });
    const res = await rename(mkApp(db), "cli");
    expect(res.status).toBe(409);
    const body = (await res.json()) as { error: { message: string } };
    expect(body.error.message).toContain("already used by a product");
    const [row] = await db.select().from(sources).where(eq(sources.id, "src_a"));
    expect(row!.slug).toBe("a-feed");
  });

  it("allows the rename when the product holding the slug is deleted", async () => {
    const db = mkDb();
    await seedSource(db);
    await db.insert(products).values({
      id: "prod_gone",
      name: "CLI",
      slug: "cli",
      orgId: "org_acme",
      deletedAt: new Date().toISOString(),
    });
    const res = await rename(mkApp(db), "cli");
    expect(res.status).toBe(200);
  });
});

describe("POST /v1/products/adopt", () => {
  it("rejects with 409 when the product slug is held by a source in the target org", async () => {
    const db = mkDb();
    await db.insert(organizations).values([
      { id: "org_target", slug: "target-org", name: "Target" },
      { id: "org_source", slug: "widget", name: "Widget" },
    ]);
    await db.insert(sources).values({
      id: "src_w",
      name: "Widget blog",
      slug: "widget",
      orgId: "org_target",
      type: "feed",
      url: "https://t.test/w",
    });
    const res = await mkApp(db)(
      new Request(
        "https://x.test/v1/products/adopt",
        json("POST", { sourceOrgSlug: "widget", targetOrgSlug: "target-org" }),
      ),
    );
    expect(res.status).toBe(409);
    const rows = await db.select().from(products).where(eq(products.orgId, "org_target"));
    expect(rows).toHaveLength(0);
    const [org] = await db.select().from(organizations).where(eq(organizations.id, "org_source"));
    expect(org).toBeTruthy();
  });

  it("rejects with 409 when a moved source would take the new product's slug, moving nothing", async () => {
    const db = mkDb();
    await db.insert(organizations).values([
      { id: "org_target", slug: "target-org", name: "Target" },
      { id: "org_source", slug: "widget", name: "Widget" },
    ]);
    await db.insert(sources).values({
      id: "src_w",
      name: "Widget",
      slug: "widget",
      orgId: "org_source",
      type: "github",
      url: "https://github.com/widget/widget",
    });
    const res = await mkApp(db)(
      new Request(
        "https://x.test/v1/products/adopt",
        json("POST", { sourceOrgSlug: "widget", targetOrgSlug: "target-org" }),
      ),
    );
    expect(res.status).toBe(409);
    const body = (await res.json()) as { error: { details?: { slugs?: string[] } } };
    expect(body.error.details?.slugs).toEqual(["widget"]);
    const [src] = await db.select().from(sources).where(eq(sources.id, "src_w"));
    expect(src!.orgId).toBe("org_source");
  });

  it("adopts once the clashing source is renamed", async () => {
    const db = mkDb();
    await db.insert(organizations).values([
      { id: "org_target", slug: "target-org", name: "Target" },
      { id: "org_source", slug: "widget", name: "Widget" },
    ]);
    await db.insert(sources).values({
      id: "src_w",
      name: "Widget",
      slug: "widget-releases",
      orgId: "org_source",
      type: "github",
      url: "https://github.com/widget/widget",
    });
    const res = await mkApp(db)(
      new Request(
        "https://x.test/v1/products/adopt",
        json("POST", { sourceOrgSlug: "widget", targetOrgSlug: "target-org" }),
      ),
    );
    expect(res.status).toBe(200);
    const [src] = await db.select().from(sources).where(eq(sources.id, "src_w"));
    expect(src!.orgId).toBe("org_target");
  });
});
