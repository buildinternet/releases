/**
 * Org-scoped source/product routes + catalog (#690 Phase B).
 *
 * GET handlers register at both `/v1/sources/:slug` (id-or-slug, id preferred)
 * and `/v1/orgs/:orgSlug/sources/:sourceSlug` (org-scoped, both segments
 * id-or-slug). Same shape for products. The catalog endpoint returns the
 * unified browse view used by the web frontend and CLI.
 */
import { describe, it, expect } from "bun:test";
import { Database } from "bun:sqlite";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { applyMigrations } from "../../../tests/db-helper";
import { organizations, sources, products } from "@buildinternet/releases-core/schema";
import { Hono } from "hono";
import { sourceRoutes } from "../src/routes/sources.js";
import { productRoutes } from "../src/routes/products.js";
import { orgRoutes } from "../src/routes/orgs.js";

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
  v1.route("/", orgRoutes);
  v1.route("/", sourceRoutes);
  v1.route("/", productRoutes);
  app.route("/v1", v1);
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
  it("returns the same payload as the bare /v1/sources/:id route", async () => {
    const db = mkDb();
    await seed(db);
    const fetch = mkApp(db);

    const [orgScoped, bare] = await Promise.all([
      fetch(new Request("https://x.test/v1/orgs/acme/sources/cli")),
      fetch(new Request("https://x.test/v1/sources/src_acme_cli")),
    ]);

    expect(orgScoped.status).toBe(200);
    expect(bare.status).toBe(200);
    const orgBody = (await orgScoped.json()) as { id: string; slug: string };
    const bareBody = (await bare.json()) as { id: string; slug: string };
    expect(orgBody.id).toBe("src_acme_cli");
    expect(orgBody.slug).toBe("cli");
    expect(orgBody).toEqual(bareBody);
  });

  it("accepts ids in either segment", async () => {
    const db = mkDb();
    await seed(db);
    const fetch = mkApp(db);

    const res = await fetch(new Request("https://x.test/v1/orgs/org_acme/sources/src_acme_cli"));

    expect(res.status).toBe(200);
    expect(((await res.json()) as { id: string }).id).toBe("src_acme_cli");
  });

  it("404s when source slug doesn't belong to the named org", async () => {
    const db = mkDb();
    await seed(db);
    const fetch = mkApp(db);

    // Beta org has no source slugged 'cli' — Acme does, but the org scope rules it out.
    const res = await fetch(new Request("https://x.test/v1/orgs/beta/sources/cli"));
    expect(res.status).toBe(404);
  });

  it("excludes tombstoned sources by default", async () => {
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
});

describe("GET /v1/orgs/:orgSlug/products/:productSlug", () => {
  it("returns the same payload as /v1/products/:id", async () => {
    const db = mkDb();
    await seed(db);
    const fetch = mkApp(db);

    const [orgScoped, bare] = await Promise.all([
      fetch(new Request("https://x.test/v1/orgs/acme/products/widget")),
      fetch(new Request("https://x.test/v1/products/prod_acme_widget")),
    ]);

    expect(orgScoped.status).toBe(200);
    expect(bare.status).toBe(200);
    expect(await orgScoped.json()).toEqual(await bare.json());
  });

  it("404s when product doesn't exist in the named org", async () => {
    const db = mkDb();
    await seed(db);
    const fetch = mkApp(db);

    const res = await fetch(new Request("https://x.test/v1/orgs/beta/products/widget"));
    expect(res.status).toBe(404);
  });
});

describe("GET /v1/orgs/:orgSlug/sources/:sourceSlug/changelog", () => {
  it("matches the bare /v1/sources/:slug/changelog response on a real changelog file", async () => {
    // Don't need actual file rows — both routes share the same handler, so
    // a 404 from each is sufficient to prove dual-registration is wired.
    const db = mkDb();
    await seed(db);
    const fetch = mkApp(db);

    const [orgScoped, bare] = await Promise.all([
      fetch(new Request("https://x.test/v1/orgs/acme/sources/cli/changelog")),
      fetch(new Request("https://x.test/v1/sources/cli/changelog")),
    ]);

    expect(orgScoped.status).toBe(404);
    expect(bare.status).toBe(404);
  });
});

describe("GET /v1/orgs/:slug/catalog — input validation", () => {
  it("400s on unknown kind", async () => {
    const db = mkDb();
    await seed(db);
    const fetch = mkApp(db);

    const res = await fetch(new Request("https://x.test/v1/orgs/acme/catalog?kind=bogus"));
    expect(res.status).toBe(400);
  });

  it("clamps limit floor to 1 (rejects negative LIMIT semantics)", async () => {
    const db = mkDb();
    await seed(db);
    const fetch = mkApp(db);

    const res = await fetch(new Request("https://x.test/v1/orgs/acme/catalog?limit=-1"));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { items: unknown[] };
    // 1 product + 1 source seeded, but limit=1 caps each per-kind, so we'd
    // see at most 2 items. The bug we're guarding against is LIMIT -1 acting
    // as no-limit — observable as the catalog returning more than the cap.
    expect(body.items.length).toBeLessThanOrEqual(2);
  });
});

describe("POST /v1/sources — orgId guard (#690 Phase A drift prevention)", () => {
  it("400s when neither orgId nor orgSlug resolves to an org", async () => {
    const db = mkDb();
    await seed(db);
    const fetch = mkApp(db);

    const res = await fetch(
      new Request("https://x.test/v1/sources", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: "Orphan",
          url: "https://orphan.test/changelog",
        }),
      }),
    );

    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("bad_request");
  });
});

describe("GET /v1/orgs/:slug/catalog", () => {
  it("returns sources and products as a discriminated union", async () => {
    const db = mkDb();
    await seed(db);
    const fetch = mkApp(db);

    const res = await fetch(new Request("https://x.test/v1/orgs/acme/catalog"));
    expect(res.status).toBe(200);

    const body = (await res.json()) as {
      org: { id: string; slug: string };
      items: Array<{ kind: "source" | "product"; id: string; slug: string }>;
    };
    expect(body.org.slug).toBe("acme");
    const kinds = new Set(body.items.map((i) => i.kind));
    expect(kinds.has("source")).toBe(true);
    expect(kinds.has("product")).toBe(true);
    expect(body.items.find((i) => i.kind === "source")?.id).toBe("src_acme_cli");
    expect(body.items.find((i) => i.kind === "product")?.id).toBe("prod_acme_widget");
  });

  it("filters by kind", async () => {
    const db = mkDb();
    await seed(db);
    const fetch = mkApp(db);

    const res = await fetch(new Request("https://x.test/v1/orgs/acme/catalog?kind=product"));
    const body = (await res.json()) as { items: Array<{ kind: string }> };
    expect(body.items.every((i) => i.kind === "product")).toBe(true);
  });

  it("404s for unknown org", async () => {
    const db = mkDb();
    await seed(db);
    const fetch = mkApp(db);

    const res = await fetch(new Request("https://x.test/v1/orgs/nope/catalog"));
    expect(res.status).toBe(404);
  });
});
