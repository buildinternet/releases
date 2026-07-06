/**
 * Routes for stub-tier org creation (#1947):
 *   POST /v1/orgs/stub              — curator-authored stub (basis: curator)
 *   POST /v1/orgs/stub-from-domain  — unlisted-domain manifest (basis: declared)
 *
 * Both bump the namespace write-gate to admin in-handler (isValidBearerAuth),
 * so a request with no/under-scoped bearer is 403. The admin key is injected as
 * a Secrets-Store-shaped binding, matching the worker's getSecret contract.
 */
import { describe, it, expect, afterEach } from "bun:test";
import { eq } from "drizzle-orm";
import {
  organizations,
  sources,
  releaseLocations,
  domainAliases,
} from "@buildinternet/releases-core/schema";
import { orgRoutes } from "../src/routes/orgs.js";
import {
  createStubOrg,
  resolveDomainOrg,
  createStubFromManifest,
} from "../src/lib/well-known/stub.js";
import { createTestDb, createTestApp } from "./setup";
import { restoreGlobalFetch } from "../../../tests/global-fetch";

afterEach(() => {
  restoreGlobalFetch();
});

const ADMIN_KEY = "test-admin-key";
const adminEnv = { RELEASES_API_KEY: { get: async () => ADMIN_KEY } };
const auth = { authorization: `Bearer ${ADMIN_KEY}`, "content-type": "application/json" };

describe("POST /v1/orgs/stub", () => {
  it("creates a stub org with locators as an admin", async () => {
    const db = createTestDb();
    const app = createTestApp(db, orgRoutes, { env: adminEnv });
    const res = await app(
      new Request("https://x/v1/orgs/stub", {
        method: "POST",
        headers: auth,
        body: JSON.stringify({
          name: "Acme",
          domain: "acme.com",
          products: [{ name: "Widget", releases: [{ feed: "https://acme.com/widget.xml" }] }],
          releases: [{ url: "https://acme.com/blog" }],
        }),
      }),
    );
    expect(res.status).toBe(201);
    const body = (await res.json()) as { id: string; tier: string; locationCount: number };
    expect(body.tier).toBe("stub");
    expect(body.locationCount).toBe(2);
    const locs = await db
      .select()
      .from(releaseLocations)
      .where(eq(releaseLocations.orgId, body.id));
    expect(locs.every((l) => l.basis === "curator")).toBe(true);
  });

  it("rejects a non-admin (no bearer) with 403", async () => {
    const db = createTestDb();
    const app = createTestApp(db, orgRoutes, { env: adminEnv });
    const res = await app(
      new Request("https://x/v1/orgs/stub", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name: "Nope" }),
      }),
    );
    expect(res.status).toBe(403);
    const orgs = await db.select().from(organizations).where(eq(organizations.slug, "nope"));
    expect(orgs.length).toBe(0);
  });

  it("409s on a slug collision", async () => {
    const db = createTestDb();
    const app = createTestApp(db, orgRoutes, { env: adminEnv });
    const make = () =>
      app(
        new Request("https://x/v1/orgs/stub", {
          method: "POST",
          headers: auth,
          body: JSON.stringify({ name: "Dup", slug: "dup" }),
        }),
      );
    expect((await make()).status).toBe(201);
    expect((await make()).status).toBe(409);
  });
});

describe("POST /v1/orgs/stub-from-domain", () => {
  const manifest = JSON.stringify({
    version: 2,
    name: "Beta Corp",
    releases: [{ feed: "https://beta.com/feed.xml" }],
  });

  it("creates a stub from an unlisted domain's manifest", async () => {
    const db = createTestDb();
    globalThis.fetch = (async () =>
      new Response(manifest, {
        status: 200,
        headers: { "content-type": "application/json" },
      })) as unknown as typeof fetch;
    const app = createTestApp(db, orgRoutes, { env: adminEnv });
    const res = await app(
      new Request("https://x/v1/orgs/stub-from-domain", {
        method: "POST",
        headers: auth,
        body: JSON.stringify({ domain: "beta.com" }),
      }),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { created: boolean; orgId?: string };
    expect(body.created).toBe(true);
    const [org] = await db.select().from(organizations).where(eq(organizations.domain, "beta.com"));
    expect(org!.tier).toBe("stub");
  });

  it("rejects a non-admin with 403", async () => {
    const db = createTestDb();
    const app = createTestApp(db, orgRoutes, { env: adminEnv });
    const res = await app(
      new Request("https://x/v1/orgs/stub-from-domain", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ domain: "beta.com" }),
      }),
    );
    expect(res.status).toBe(403);
  });
});

describe("POST /v1/orgs/:slug/promote", () => {
  it("promotes a stub to tracked (tier-2 locators, no network)", async () => {
    const db = createTestDb();
    // A bare-url locator is tier-2 — the materializer pends it as a paused
    // source without a network probe, so the route stays hermetic.
    await createStubOrg(
      db as never,
      { name: "Promo", slug: "promo", locations: [{ url: "https://promo.com/blog" }] },
      { basis: "curator" },
    );
    const app = createTestApp(db, orgRoutes, { env: adminEnv });
    const res = await app(
      new Request("https://x/v1/orgs/promo/promote", { method: "POST", headers: auth }),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { promoted: boolean; sourcesCreated: number };
    expect(body.promoted).toBe(true);
    expect(body.sourcesCreated).toBe(1);
    const [org] = await db.select().from(organizations).where(eq(organizations.slug, "promo"));
    expect(org!.tier).toBe("tracked");
    const srcs = await db.select().from(sources).where(eq(sources.orgId, org!.id));
    expect(srcs.length).toBe(1);
    expect(srcs[0]!.fetchPriority).toBe("paused");
  });

  it("rejects a non-admin with 403", async () => {
    const db = createTestDb();
    await createStubOrg(db as never, { name: "P2", slug: "p2" }, { basis: "curator" });
    const app = createTestApp(db, orgRoutes, { env: adminEnv });
    const res = await app(
      new Request("https://x/v1/orgs/p2/promote", {
        method: "POST",
        headers: { "content-type": "application/json" },
      }),
    );
    expect(res.status).toBe(403);
  });

  it("404s for an unknown org", async () => {
    const db = createTestDb();
    const app = createTestApp(db, orgRoutes, { env: adminEnv });
    const res = await app(
      new Request("https://x/v1/orgs/nope/promote", { method: "POST", headers: auth }),
    );
    expect(res.status).toBe(404);
  });
});

describe("resolveDomainOrg", () => {
  it("resolves by organizations.domain and returns the org row", async () => {
    const db = createTestDb();
    const { org } = await createStubOrg(
      db as never,
      { name: "Acme", slug: "acme", domain: "acme.com" },
      { basis: "curator" },
    );
    const hit = await resolveDomainOrg(db as never, "acme.com");
    expect(hit?.id).toBe(org.id);
    expect(await resolveDomainOrg(db as never, "other.com")).toBeNull();
  });

  it("returns null for a domain aliased to a soft-deleted org (dangling alias)", async () => {
    const db = createTestDb();
    const { org } = await createStubOrg(
      db as never,
      { name: "Ghost Co", slug: "ghost-co", domain: "ghost.com" },
      { basis: "curator" },
    );
    await db.insert(domainAliases).values({ domain: "ghost.com-alias", orgId: org.id });
    await db
      .update(organizations)
      .set({ deletedAt: new Date().toISOString() })
      .where(eq(organizations.id, org.id));

    // resolveDomainOrg is live-org-only by design (the listing lane wants that
    // shape) — it does NOT see the aliased org once it's soft-deleted.
    expect(await resolveDomainOrg(db as never, "ghost.com-alias")).toBeNull();
  });
});

describe("createStubFromManifest — alias-existence guard fail-closed", () => {
  it("skips as org_exists when the aliased org is soft-deleted", async () => {
    const db = createTestDb();
    const { org } = await createStubOrg(
      db as never,
      { name: "Ghost Co", slug: "ghost-co-2", domain: "ghost2.com" },
      { basis: "curator" },
    );
    await db.insert(domainAliases).values({ domain: "ghost2-alias.com", orgId: org.id });
    await db
      .update(organizations)
      .set({ deletedAt: new Date().toISOString() })
      .where(eq(organizations.id, org.id));

    // Documents the intentional divergence: the helper says "no live org here"
    // but the guard must still refuse — an alias row means the domain was
    // deliberately mapped, and deleting the org must not silently reopen it.
    expect(await resolveDomainOrg(db as never, "ghost2-alias.com")).toBeNull();

    const result = await createStubFromManifest(db as never, "ghost2-alias.com");
    expect(result.skippedReason).toBe("org_exists");
    expect(result.created).toBe(false);
  });
});
