/**
 * Org-scoped source/product routes (#690 Phase B).
 *
 * `/v1/orgs/:orgSlug/sources/:sourceSlug{/...}` resolves the source by
 * `(org_id, slug)` and 307-redirects to `/v1/sources/{src_id}{/...}`. Same
 * shape for products.
 *
 * The redirect itself is the contract under test — we don't follow it. That
 * way these tests stay decoupled from the bare-route handlers' behavior, and
 * Phase C can flip the bare routes to id-only without rewriting these.
 */
import { describe, it, expect } from "bun:test";
import { Database } from "bun:sqlite";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { applyMigrations } from "../../../tests/db-helper";
import { organizations, sources, products } from "@buildinternet/releases-core/schema";
import { Hono } from "hono";
import { sourceRoutes } from "../src/routes/sources.js";
import { productRoutes } from "../src/routes/products.js";

const statusHubStub = {
  idFromName: () => "stub-id",
  get: () => ({
    fetch: async () => new Response("ok", { status: 200 }),
  }),
};

function mkDb() {
  const sqlite = new Database(":memory:");
  const db = drizzle(sqlite);
  applyMigrations(sqlite);
  return db;
}

function mkApp(db: ReturnType<typeof mkDb>) {
  const fakeEnv = { DB: db, STATUS_HUB: statusHubStub };
  const fakeCtx = {
    waitUntil: () => {},
    passThroughOnException: () => {},
  } as unknown as ExecutionContext;
  const app = new Hono();
  const v1 = new Hono();
  v1.route("/", sourceRoutes);
  v1.route("/", productRoutes);
  app.route("/v1", v1);
  // app.fetch returns the handler's Response directly (no auto-follow on 3xx).
  return (req: Request) => app.fetch(req, fakeEnv, fakeCtx);
}

async function seed(db: ReturnType<typeof mkDb>) {
  await db.insert(organizations).values([
    { id: "org_acme", slug: "acme", name: "Acme", category: "cloud" },
    { id: "org_beta", slug: "beta", name: "Beta", category: "cloud" },
  ]);
  await db.insert(sources).values([
    {
      id: "src_acme_cli",
      slug: "cli",
      name: "Acme CLI",
      type: "github",
      url: "https://github.com/acme/cli",
      orgId: "org_acme",
    },
    {
      id: "src_beta_cli",
      slug: "cli-beta",
      name: "Beta CLI",
      type: "github",
      url: "https://github.com/beta/cli",
      orgId: "org_beta",
    },
  ]);
  await db.insert(products).values([
    {
      id: "prod_acme_widget",
      slug: "widget",
      name: "Widget",
      orgId: "org_acme",
    },
  ]);
}

describe("GET /v1/orgs/:orgSlug/sources/:sourceSlug", () => {
  it("307-redirects to the bare /v1/sources/<id> path", async () => {
    const db = mkDb();
    await seed(db);
    const fetch = mkApp(db);

    const res = await fetch(new Request("https://x.test/v1/orgs/acme/sources/cli"));

    expect(res.status).toBe(307);
    const location = res.headers.get("location");
    expect(location).not.toBeNull();
    expect(new URL(location!).pathname).toBe("/v1/sources/src_acme_cli");
  });

  it("preserves the trailing path segment in the redirect target", async () => {
    const db = mkDb();
    await seed(db);
    const fetch = mkApp(db);

    const res = await fetch(new Request("https://x.test/v1/orgs/acme/sources/cli/recent-releases"));

    expect(res.status).toBe(307);
    expect(new URL(res.headers.get("location")!).pathname).toBe(
      "/v1/sources/src_acme_cli/recent-releases",
    );
  });

  it("returns 404 when the source slug doesn't exist within the org", async () => {
    const db = mkDb();
    await seed(db);
    const fetch = mkApp(db);

    // beta/cli — beta has no source slugged "cli" (its slug is "cli-beta").
    const res = await fetch(new Request("https://x.test/v1/orgs/beta/sources/cli"));

    expect(res.status).toBe(404);
  });

  it("returns 404 when the org slug doesn't exist", async () => {
    const db = mkDb();
    await seed(db);
    const fetch = mkApp(db);

    const res = await fetch(new Request("https://x.test/v1/orgs/nope/sources/cli"));

    expect(res.status).toBe(404);
  });

  it("returns 404 for a tombstoned source by default", async () => {
    const db = mkDb();
    await seed(db);
    await db.insert(sources).values({
      id: "src_acme_old",
      slug: "old--src_acme_old",
      name: "Old",
      type: "feed",
      url: "https://acme.test/old",
      orgId: "org_acme",
      deletedAt: new Date().toISOString(),
    });
    const fetch = mkApp(db);

    const res = await fetch(new Request("https://x.test/v1/orgs/acme/sources/old"));

    expect(res.status).toBe(404);
  });

  it("accepts ids (org_… / src_…) interchangeably with slugs", async () => {
    const db = mkDb();
    await seed(db);
    const fetch = mkApp(db);

    const res = await fetch(new Request("https://x.test/v1/orgs/org_acme/sources/src_acme_cli"));

    expect(res.status).toBe(307);
    expect(new URL(res.headers.get("location")!).pathname).toBe("/v1/sources/src_acme_cli");
  });
});

describe("Org-scoped redirect — method preservation", () => {
  it("redirects PATCH with body using 307 (preserves method)", async () => {
    const db = mkDb();
    await seed(db);
    const fetch = mkApp(db);

    const res = await fetch(
      new Request("https://x.test/v1/orgs/acme/sources/cli", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: "Renamed" }),
      }),
    );

    // 307 preserves method+body per RFC 7231; clients re-issue PATCH at target.
    expect(res.status).toBe(307);
    expect(new URL(res.headers.get("location")!).pathname).toBe("/v1/sources/src_acme_cli");
  });
});

describe("GET /v1/orgs/:orgSlug/products/:productSlug", () => {
  it("307-redirects to the bare /v1/products/<id> path", async () => {
    const db = mkDb();
    await seed(db);
    const fetch = mkApp(db);

    const res = await fetch(new Request("https://x.test/v1/orgs/acme/products/widget"));

    expect(res.status).toBe(307);
    expect(new URL(res.headers.get("location")!).pathname).toBe("/v1/products/prod_acme_widget");
  });

  it("preserves trailing segments and query string", async () => {
    const db = mkDb();
    await seed(db);
    const fetch = mkApp(db);

    const res = await fetch(
      new Request("https://x.test/v1/orgs/acme/products/widget/tags?include=hidden"),
    );

    expect(res.status).toBe(307);
    const target = new URL(res.headers.get("location")!);
    expect(target.pathname).toBe("/v1/products/prod_acme_widget/tags");
    expect(target.searchParams.get("include")).toBe("hidden");
  });

  it("returns 404 when the product doesn't exist in that org", async () => {
    const db = mkDb();
    await seed(db);
    const fetch = mkApp(db);

    const res = await fetch(new Request("https://x.test/v1/orgs/beta/products/widget"));

    expect(res.status).toBe(404);
  });
});
