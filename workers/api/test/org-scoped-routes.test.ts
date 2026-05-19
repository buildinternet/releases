/**
 * Org-scoped source/product routes + catalog (#690 Phase B, #698 Phase D).
 *
 * Handlers register at both `/v1/sources/:slug` and
 * `/v1/orgs/:orgSlug/sources/:sourceSlug` (same handler, different params).
 * Post-#698 the bare path accepts typed `src_…` IDs only — bare slugs throw
 * `BareSlugRejected` → 400. The org-scoped path accepts id-or-slug on both
 * segments. Same shape for products (typed-ID-only on `/v1/products/:slug`,
 * id-or-slug on `/v1/orgs/:orgSlug/products/:productSlug`). The catalog
 * endpoint returns the unified browse view used by the web frontend and CLI.
 */
import { describe, it, expect } from "bun:test";
import { organizations, sources, products } from "@buildinternet/releases-core/schema";
import { sourceRoutes } from "../src/routes/sources.js";
import { productRoutes } from "../src/routes/products.js";
import { orgRoutes } from "../src/routes/orgs.js";
import { BareSlugRejected } from "../src/utils.js";
import { createTestDb as mkDb, createTestApp } from "./setup";

const statusHubStub = {
  idFromName: () => "stub-id",
  get: () => ({
    fetch: async () => new Response("ok", { status: 200 }),
  }),
};

// Mirror the real app's onError so BareSlugRejected (#698) translates to a
// 400 in tests. Without this, a thrown error would surface as Hono's default
// 500 response and the bare-slug rejection assertions wouldn't be honest.
const mkApp = (db: ReturnType<typeof mkDb>) =>
  createTestApp(db, [orgRoutes, sourceRoutes, productRoutes], {
    env: { STATUS_HUB: statusHubStub },
    onError: (err, c) => {
      if (err instanceof BareSlugRejected) {
        return c.json(
          { error: "bare_slug_rejected", entity: err.entity, message: err.message },
          400,
        );
      }
      const message = err instanceof Error ? err.message : String(err);
      return c.json({ error: "internal_error", message }, 500);
    },
  });

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

  it("accepts ids in either segment", async () => {
    const db = mkDb();
    await seed(db);
    const fetch = mkApp(db);

    const [orgScoped, bare] = await Promise.all([
      fetch(new Request("https://x.test/v1/orgs/org_acme/products/prod_acme_widget")),
      fetch(new Request("https://x.test/v1/products/prod_acme_widget")),
    ]);

    expect(orgScoped.status).toBe(200);
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
  it("is dual-registered: org-scoped path reaches the handler", async () => {
    const db = mkDb();
    await seed(db);
    const fetch = mkApp(db);

    const orgScoped = await fetch(new Request("https://x.test/v1/orgs/acme/sources/cli/changelog"));

    // 404 means the route resolved to the handler — the seed has no changelog
    // file for `cli`, so the handler runs and returns "not found." The status
    // we're guarding against is 400 (BareSlugRejected) or 405 (no route).
    expect(orgScoped.status).toBe(404);
  });

  it("rejects bare-slug requests with a BareSlugRejected 400 (#698)", async () => {
    const db = mkDb();
    await seed(db);
    const fetch = mkApp(db);

    const res = await fetch(new Request("https://x.test/v1/sources/cli/changelog"));

    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string; entity: string };
    expect(body.error).toBe("bare_slug_rejected");
    expect(body.entity).toBe("source");
  });

  it("typed src_… IDs still resolve on the bare path", async () => {
    const db = mkDb();
    await seed(db);
    const fetch = mkApp(db);

    // No changelog seeded for this source — 404 confirms the resolver ran
    // (and didn't throw BareSlugRejected). The status we're guarding against
    // here is 400.
    const res = await fetch(new Request("https://x.test/v1/sources/src_acme_cli/changelog"));
    expect(res.status).toBe(404);
  });
});

describe("bare-slug rejection on product routes (#698)", () => {
  it("rejects bare-slug GET /products/:identifier with 400", async () => {
    const db = mkDb();
    await seed(db);
    const fetch = mkApp(db);

    const res = await fetch(new Request("https://x.test/v1/products/widget"));
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string; entity: string };
    expect(body.error).toBe("bare_slug_rejected");
    expect(body.entity).toBe("product");
  });

  it("typed prod_… IDs still resolve on the bare path", async () => {
    const db = mkDb();
    await seed(db);
    const fetch = mkApp(db);

    const res = await fetch(new Request("https://x.test/v1/products/prod_acme_widget"));
    expect(res.status).toBe(200);
  });
});

// Regression coverage for #698 / #709: the discovery worker, scripts, and
// promote-source action all hit these write endpoints over the org-scoped
// path. If a future refactor accidentally drops one of the dual
// registrations, the cron worker would 404 every fetch.
describe("org-scoped write endpoints — dual-registered handlers", () => {
  it("PATCH /v1/orgs/:orgSlug/sources/:sourceSlug reaches the handler", async () => {
    const db = mkDb();
    await seed(db);
    const fetch = mkApp(db);

    const res = await fetch(
      new Request("https://x.test/v1/orgs/acme/sources/cli", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ isHidden: true }),
      }),
    );

    expect(res.status).toBe(200);
    const body = (await res.json()) as { isHidden: boolean };
    expect(body.isHidden).toBe(true);
  });

  it("PATCH /v1/orgs/:orgSlug/sources/:sourceSlug/metadata reaches the handler", async () => {
    const db = mkDb();
    await seed(db);
    const fetch = mkApp(db);

    const res = await fetch(
      new Request("https://x.test/v1/orgs/acme/sources/cli/metadata", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ feedUrl: "https://example.com/feed" }),
      }),
    );

    expect(res.status).toBe(200);
    const body = (await res.json()) as { metadata: Record<string, unknown> };
    expect(body.metadata.feedUrl).toBe("https://example.com/feed");
  });

  it("PATCH metadata with exactly 20 changelogPaths → 200", async () => {
    const db = mkDb();
    await seed(db);
    const fetch = mkApp(db);

    const paths = Array.from({ length: 20 }, (_, i) => `packages/pkg-${i}/CHANGELOG.md`);
    const res = await fetch(
      new Request("https://x.test/v1/orgs/acme/sources/cli/metadata", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ changelogPaths: paths }),
      }),
    );

    expect(res.status).toBe(200);
    const body = (await res.json()) as { metadata: { changelogPaths: string[] } };
    expect(body.metadata.changelogPaths).toHaveLength(20);
  });

  it("PATCH metadata with 21 changelogPaths → 400 bad_request", async () => {
    const db = mkDb();
    await seed(db);
    const fetch = mkApp(db);

    const paths = Array.from({ length: 21 }, (_, i) => `packages/pkg-${i}/CHANGELOG.md`);
    const res = await fetch(
      new Request("https://x.test/v1/orgs/acme/sources/cli/metadata", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ changelogPaths: paths }),
      }),
    );

    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string; message: string };
    expect(body.error).toBe("bad_request");
    expect(body.message).toContain("21");
    expect(body.message).toContain("20");
  });

  it("POST /v1/orgs/:orgSlug/sources/:sourceSlug/content-hash reaches the handler", async () => {
    const db = mkDb();
    await seed(db);
    const fetch = mkApp(db);

    const res = await fetch(
      new Request("https://x.test/v1/orgs/acme/sources/cli/content-hash", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ contentHash: "deadbeef" }),
      }),
    );

    expect(res.status).toBe(200);
    const body = (await res.json()) as { unchanged: boolean };
    // First write of a new hash → unchanged=false (was null on the seed row).
    expect(body.unchanged).toBe(false);
  });

  it("POST /v1/orgs/:orgSlug/sources/:sourceSlug/releases/batch reaches the handler", async () => {
    const db = mkDb();
    await seed(db);
    const fetch = mkApp(db);

    const res = await fetch(
      new Request("https://x.test/v1/orgs/acme/sources/cli/releases/batch", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ releases: [] }),
      }),
    );

    // Empty array is accepted; the response shape carries `inserted: 0`.
    expect(res.status).toBe(200);
    const body = (await res.json()) as { inserted: number };
    expect(body.inserted).toBe(0);
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
    // limit=-1 is clamped to 1 per-kind; seed has 1 product + 1 source = 2 items max.
    expect(body.items.length).toBe(2);
  });
});

describe("POST /v1/sources — orgId guard", () => {
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

  it("400s when orgId is supplied but doesn't exist", async () => {
    const db = mkDb();
    await seed(db);
    const fetch = mkApp(db);

    const res = await fetch(
      new Request("https://x.test/v1/sources", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: "Bad Ref",
          url: "https://bad-ref.test/changelog",
          orgId: "org_does_not_exist",
        }),
      }),
    );

    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toBe("bad_request");
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
      items: Array<{ entryType: "source" | "product"; id: string; slug: string }>;
    };
    expect(body.org.slug).toBe("acme");
    const entryTypes = new Set(body.items.map((i) => i.entryType));
    expect(entryTypes.has("source")).toBe(true);
    expect(entryTypes.has("product")).toBe(true);
    expect(body.items.find((i) => i.entryType === "source")?.id).toBe("src_acme_cli");
    expect(body.items.find((i) => i.entryType === "product")?.id).toBe("prod_acme_widget");
  });

  it("filters by kind", async () => {
    const db = mkDb();
    await seed(db);
    const fetch = mkApp(db);

    const res = await fetch(new Request("https://x.test/v1/orgs/acme/catalog?kind=product"));
    const body = (await res.json()) as { items: Array<{ entryType: string }> };
    expect(body.items.every((i) => i.entryType === "product")).toBe(true);
  });

  it("404s for unknown org", async () => {
    const db = mkDb();
    await seed(db);
    const fetch = mkApp(db);

    const res = await fetch(new Request("https://x.test/v1/orgs/nope/catalog"));
    expect(res.status).toBe(404);
  });
});
