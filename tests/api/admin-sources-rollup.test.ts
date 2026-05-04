/**
 * GET /v1/admin/sources/orgs-rollup — server-side per-org staleness rollup
 * that backs the status dashboard's Orgs tab. Filters: ?filter=all|stale|dormant
 * and ?q= against org slug.
 */

import { describe, it, expect, beforeEach } from "bun:test";
import { Database } from "bun:sqlite";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { Hono } from "hono";
import { applyMigrations } from "../db-helper";
import { organizations, sources, releases } from "@buildinternet/releases-core/schema";
import { adminSourcesRoutes } from "../../workers/api/src/routes/admin-sources";
import type { OrgsRollupResponse } from "@buildinternet/releases-api-types";

const DAY_MS = 86400_000;
const STALE_DAYS = 90;

function mkDb() {
  const sqlite = new Database(":memory:");
  const db = drizzle(sqlite);
  applyMigrations(sqlite);
  return db;
}

function mkApp(db: ReturnType<typeof mkDb>) {
  const app = new Hono();
  app.use("*", async (c, next) => {
    (c as any).set("db", db);
    await next();
  });
  app.route("/", adminSourcesRoutes);
  return app;
}

async function seedOrg(
  db: ReturnType<typeof mkDb>,
  args: {
    slug: string;
    /** ISO timestamps for the latest release on each source. `null` = never released. */
    sources: Array<string | null>;
  },
) {
  const [org] = await db
    .insert(organizations)
    .values({ slug: args.slug, name: args.slug })
    .returning();

  const insertedSources = await Promise.all(
    args.sources.map((_, i) =>
      db
        .insert(sources)
        .values({
          orgId: org.id,
          slug: `${args.slug}-${i}`,
          name: `${args.slug} ${i}`,
          type: "github",
          url: `https://example.com/${args.slug}/${i}`,
        })
        .returning(),
    ),
  );

  const releaseRows = args.sources
    .map((latest, i) => {
      if (!latest) return null;
      const src = insertedSources[i][0];
      return {
        id: `rel_${args.slug}_${i}`,
        sourceId: src.id,
        title: `r${i}`,
        url: `${src.url}/r/${i}`,
        content: "x",
        publishedAt: latest,
      };
    })
    .filter((r): r is NonNullable<typeof r> => r != null);
  if (releaseRows.length > 0) {
    await db.insert(releases).values(releaseRows);
  }
  return org;
}

describe("GET /v1/admin/sources/orgs-rollup", () => {
  let db: ReturnType<typeof mkDb>;
  beforeEach(() => {
    db = mkDb();
  });

  it("groups by org with sourceCount, staleCount, and most-recent release", async () => {
    const now = Date.now();
    const fresh = new Date(now - 1 * DAY_MS).toISOString();
    const stale = new Date(now - (STALE_DAYS + 5) * DAY_MS).toISOString();

    // active: 2 fresh sources
    await seedOrg(db, { slug: "active-org", sources: [fresh, fresh] });
    // partial: 1 fresh + 1 stale
    await seedOrg(db, { slug: "partial-org", sources: [fresh, stale] });
    // dormant: every source stale (one stale, one never)
    await seedOrg(db, { slug: "dormant-org", sources: [stale, null] });

    const app = mkApp(db);
    const res = await app.request("/admin/sources/orgs-rollup");
    expect(res.status).toBe(200);
    const body = (await res.json()) as OrgsRollupResponse;

    const bySlug = Object.fromEntries(body.items.map((r) => [r.orgSlug, r]));
    expect(bySlug["active-org"].sourceCount).toBe(2);
    expect(bySlug["active-org"].staleCount).toBe(0);
    expect(bySlug["active-org"].allStale).toBe(false);

    expect(bySlug["partial-org"].sourceCount).toBe(2);
    expect(bySlug["partial-org"].staleCount).toBe(1);
    expect(bySlug["partial-org"].allStale).toBe(false);

    expect(bySlug["dormant-org"].sourceCount).toBe(2);
    expect(bySlug["dormant-org"].staleCount).toBe(2);
    expect(bySlug["dormant-org"].allStale).toBe(true);

    expect(body.meta.staleDays).toBe(STALE_DAYS);
    expect(body.meta.totalOrgs).toBe(3);
    expect(body.meta.dormantOrgs).toBe(1);
    expect(body.meta.anyStaleOrgs).toBe(2);
  });

  it("default sort puts dormant orgs first", async () => {
    const now = Date.now();
    const fresh = new Date(now - 1 * DAY_MS).toISOString();
    const stale = new Date(now - (STALE_DAYS + 5) * DAY_MS).toISOString();

    await seedOrg(db, { slug: "zzz-active", sources: [fresh] });
    await seedOrg(db, { slug: "aaa-dormant", sources: [stale] });
    await seedOrg(db, { slug: "mmm-active", sources: [fresh] });

    const app = mkApp(db);
    const res = await app.request("/admin/sources/orgs-rollup");
    const body = (await res.json()) as OrgsRollupResponse;
    expect(body.items[0].orgSlug).toBe("aaa-dormant");
  });

  it("filter=dormant narrows to all-stale orgs", async () => {
    const now = Date.now();
    const fresh = new Date(now - 1 * DAY_MS).toISOString();
    const stale = new Date(now - (STALE_DAYS + 5) * DAY_MS).toISOString();

    await seedOrg(db, { slug: "active-org", sources: [fresh] });
    await seedOrg(db, { slug: "partial-org", sources: [fresh, stale] });
    await seedOrg(db, { slug: "dormant-org", sources: [stale] });

    const app = mkApp(db);
    const res = await app.request("/admin/sources/orgs-rollup?filter=dormant");
    const body = (await res.json()) as OrgsRollupResponse;
    expect(body.items.map((r) => r.orgSlug)).toEqual(["dormant-org"]);
    // meta is computed across the unfiltered rollup so the dashboard can
    // render bucket counts without firing extra requests.
    expect(body.meta.totalOrgs).toBe(3);
  });

  it("filter=stale includes orgs with any stale source", async () => {
    const now = Date.now();
    const fresh = new Date(now - 1 * DAY_MS).toISOString();
    const stale = new Date(now - (STALE_DAYS + 5) * DAY_MS).toISOString();

    await seedOrg(db, { slug: "active-org", sources: [fresh] });
    await seedOrg(db, { slug: "partial-org", sources: [fresh, stale] });
    await seedOrg(db, { slug: "dormant-org", sources: [stale] });

    const app = mkApp(db);
    const res = await app.request("/admin/sources/orgs-rollup?filter=stale");
    const body = (await res.json()) as OrgsRollupResponse;
    expect(body.items.map((r) => r.orgSlug).toSorted()).toEqual(["dormant-org", "partial-org"]);
  });

  it("?q= filters by org slug substring", async () => {
    const now = Date.now();
    const fresh = new Date(now - 1 * DAY_MS).toISOString();
    await seedOrg(db, { slug: "vercel-corp", sources: [fresh] });
    await seedOrg(db, { slug: "verda-co", sources: [fresh] });
    await seedOrg(db, { slug: "openai", sources: [fresh] });

    const app = mkApp(db);
    const res = await app.request("/admin/sources/orgs-rollup?q=ver");
    const body = (await res.json()) as OrgsRollupResponse;
    expect(body.items.map((r) => r.orgSlug).toSorted()).toEqual(["vercel-corp", "verda-co"]);
  });

  it("paginates and reports totalItems", async () => {
    const now = Date.now();
    const fresh = new Date(now - 1 * DAY_MS).toISOString();
    await Promise.all(
      Array.from({ length: 5 }, (_, i) =>
        seedOrg(db, { slug: `org-${String(i).padStart(2, "0")}`, sources: [fresh] }),
      ),
    );

    const app = mkApp(db);
    const res = await app.request("/admin/sources/orgs-rollup?page=1&limit=2");
    const body = (await res.json()) as OrgsRollupResponse;
    expect(body.items).toHaveLength(2);
    expect(body.pagination.page).toBe(1);
    expect(body.pagination.pageSize).toBe(2);
    expect(body.pagination.totalItems).toBe(5);
    expect(body.pagination.hasMore).toBe(true);
  });
});
