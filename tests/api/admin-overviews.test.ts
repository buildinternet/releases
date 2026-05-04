import { describe, it, expect, beforeEach } from "bun:test";
import { Database } from "bun:sqlite";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { Hono } from "hono";
import { applyMigrations } from "../db-helper";
import {
  organizations,
  sources,
  releases,
  knowledgePages,
} from "@buildinternet/releases-core/schema";
import { adminOverviewsRoutes } from "../../workers/api/src/routes/admin-overviews";
import { newKnowledgePageId } from "../../workers/api/src/utils";
import type {
  OverviewManifestResponse,
  OverviewManifestRow,
} from "@buildinternet/releases-api-types";

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
  app.route("/", adminOverviewsRoutes);
  return app;
}

const DAY_MS = 86400_000;

async function seedOrg(
  db: ReturnType<typeof mkDb>,
  args: {
    slug: string;
    name?: string;
    discovery?: "curated" | "agent" | "on_demand";
    /** ISO timestamps for releases attached to a single source on the org. */
    releaseDates?: string[];
    overviewUpdatedAt?: string;
    overviewGeneratedAt?: string;
    sourceHidden?: boolean;
  },
) {
  const [org] = await db
    .insert(organizations)
    .values({
      slug: args.slug,
      name: args.name ?? args.slug,
      discovery: args.discovery ?? "curated",
    })
    .returning();

  const [src] = await db
    .insert(sources)
    .values({
      orgId: org.id,
      slug: `${args.slug}-src`,
      name: `${args.slug} src`,
      type: "github",
      url: `https://github.com/${args.slug}/x`,
      isHidden: !!args.sourceHidden,
    })
    .returning();

  if (args.releaseDates?.length) {
    await db.insert(releases).values(
      args.releaseDates.map((publishedAt, i) => ({
        id: `rel_${args.slug}_${i}`,
        sourceId: src.id,
        title: `r${i}`,
        url: `https://github.com/${args.slug}/x/releases/${i}`,
        content: "x",
        publishedAt,
      })),
    );
  }

  if (args.overviewUpdatedAt || args.overviewGeneratedAt) {
    await db.insert(knowledgePages).values({
      id: newKnowledgePageId(),
      scope: "org",
      orgId: org.id,
      content: "prior overview",
      releaseCount: 1,
      generatedAt: args.overviewGeneratedAt ?? args.overviewUpdatedAt!,
      updatedAt: args.overviewUpdatedAt ?? args.overviewGeneratedAt!,
    });
  }

  return org;
}

describe("GET /v1/admin/overviews", () => {
  let db: ReturnType<typeof mkDb>;

  beforeEach(() => {
    db = mkDb();
  });

  it("returns every org with staleness classification when no filters set", async () => {
    const now = Date.now();
    // missing overview, has activity
    await seedOrg(db, {
      slug: "missing-org",
      releaseDates: [new Date(now - 1 * DAY_MS).toISOString()],
    });
    // overview newer than every release → fresh
    await seedOrg(db, {
      slug: "fresh-org",
      releaseDates: [new Date(now - 10 * DAY_MS).toISOString()],
      overviewUpdatedAt: new Date(now - 1 * DAY_MS).toISOString(),
    });
    // overview older than the latest release → behind
    await seedOrg(db, {
      slug: "behind-org",
      releaseDates: [new Date(now - 1 * DAY_MS).toISOString()],
      overviewUpdatedAt: new Date(now - 10 * DAY_MS).toISOString(),
    });

    const app = mkApp(db);
    const res = await app.request("/admin/overviews");
    expect(res.status).toBe(200);

    const body = (await res.json()) as OverviewManifestResponse;
    expect(body.items).toHaveLength(3);
    const bySlug = Object.fromEntries(body.items.map((r) => [r.orgSlug, r]));
    expect(bySlug["missing-org"].staleness).toBe("missing");
    expect(bySlug["fresh-org"].staleness).toBe("fresh");
    expect(bySlug["behind-org"].staleness).toBe("behind");
    expect(bySlug["behind-org"].releasesSinceOverview).toBe(1);
    expect(bySlug["fresh-org"].releasesSinceOverview).toBe(0);

    // No format=plan → no action / needsFetch fields.
    expect(bySlug["missing-org"].action).toBeUndefined();
    expect(bySlug["missing-org"].needsFetch).toBeUndefined();

    // Pagination envelope shape.
    expect(body.pagination.page).toBe(1);
    expect(body.pagination.returned).toBe(3);
    expect(body.pagination.totalItems).toBe(3);
  });

  it("filters to behind rows older than staleDays", async () => {
    const now = Date.now();
    await seedOrg(db, {
      slug: "fresh-org",
      releaseDates: [new Date(now - 1 * DAY_MS).toISOString()],
      overviewUpdatedAt: new Date(now - 1 * DAY_MS).toISOString(),
    });
    await seedOrg(db, {
      slug: "behind-recent",
      releaseDates: [new Date(now - 1 * DAY_MS).toISOString()],
      overviewUpdatedAt: new Date(now - 5 * DAY_MS).toISOString(),
    });
    await seedOrg(db, {
      slug: "behind-old",
      releaseDates: [new Date(now - 1 * DAY_MS).toISOString()],
      overviewUpdatedAt: new Date(now - 30 * DAY_MS).toISOString(),
    });

    const app = mkApp(db);
    const res = await app.request("/admin/overviews?staleDays=14");
    const body = (await res.json()) as OverviewManifestResponse;
    expect(body.items.map((r) => r.orgSlug).toSorted()).toEqual(["behind-old"]);
  });

  it("includes missing rows when missing=true", async () => {
    const now = Date.now();
    await seedOrg(db, {
      slug: "missing-org",
      releaseDates: [new Date(now - 1 * DAY_MS).toISOString()],
    });
    await seedOrg(db, {
      slug: "fresh-org",
      releaseDates: [new Date(now - 1 * DAY_MS).toISOString()],
      overviewUpdatedAt: new Date(now - 1 * DAY_MS).toISOString(),
    });

    const app = mkApp(db);
    const res = await app.request("/admin/overviews?missing=true");
    const body = (await res.json()) as OverviewManifestResponse;
    expect(body.items.map((r) => r.orgSlug)).toEqual(["missing-org"]);
  });

  it("hasActivity=true drops orgs with zero recent releases", async () => {
    const now = Date.now();
    // recent activity
    await seedOrg(db, {
      slug: "active-org",
      releaseDates: [new Date(now - 1 * DAY_MS).toISOString()],
    });
    // last release is older than the 30-day cutoff → recentReleaseCount=0
    await seedOrg(db, {
      slug: "stale-org",
      releaseDates: [new Date(now - 60 * DAY_MS).toISOString()],
    });

    const app = mkApp(db);
    const res = await app.request("/admin/overviews?missing=true&hasActivity=true");
    const body = (await res.json()) as OverviewManifestResponse;
    expect(body.items.map((r) => r.orgSlug)).toEqual(["active-org"]);
  });

  it("format=plan adds action and needsFetch hints", async () => {
    const now = Date.now();
    await seedOrg(db, {
      slug: "missing-active",
      releaseDates: [new Date(now - 1 * DAY_MS).toISOString()],
    });
    await seedOrg(db, {
      slug: "behind-active",
      releaseDates: [new Date(now - 1 * DAY_MS).toISOString()],
      overviewUpdatedAt: new Date(now - 30 * DAY_MS).toISOString(),
    });
    await seedOrg(db, {
      slug: "fresh-active",
      releaseDates: [new Date(now - 1 * DAY_MS).toISOString()],
      overviewUpdatedAt: new Date(now - 1 * DAY_MS).toISOString(),
    });
    // active sources but ingest is lagging — needsFetch should be true
    await seedOrg(db, {
      slug: "lagging",
      releaseDates: [new Date(now - 30 * DAY_MS).toISOString()],
    });
    // Exact 7-day boundary — `>= NEEDS_FETCH_LAG_DAYS` means this counts as lagged.
    // Subtract a small fudge so floating-point drift can't tip the comparison.
    await seedOrg(db, {
      slug: "seven-day",
      releaseDates: [new Date(now - 7 * DAY_MS - 1000).toISOString()],
    });

    const app = mkApp(db);
    const res = await app.request("/admin/overviews?format=plan");
    const body = (await res.json()) as OverviewManifestResponse;
    const bySlug = Object.fromEntries(body.items.map((r) => [r.orgSlug, r]));

    expect(bySlug["missing-active"].action).toBe("missing");
    expect(bySlug["behind-active"].action).toBe("refresh");
    expect(bySlug["fresh-active"].action).toBe("skip");

    expect(bySlug["missing-active"].needsFetch).toBe(false);
    expect(bySlug["lagging"].needsFetch).toBe(true);
    expect(bySlug["seven-day"].needsFetch).toBe(true);
  });

  it("400s on negative staleDays", async () => {
    const app = mkApp(db);
    const res = await app.request("/admin/overviews?staleDays=-3");
    expect(res.status).toBe(400);
  });

  it("paginates via page + limit", async () => {
    const now = Date.now();
    await Promise.all(
      ["a-org", "b-org", "c-org", "d-org"].map((slug) =>
        seedOrg(db, { slug, releaseDates: [new Date(now - 1 * DAY_MS).toISOString()] }),
      ),
    );

    const app = mkApp(db);
    const res = await app.request("/admin/overviews?page=2&limit=2");
    const body = (await res.json()) as OverviewManifestResponse;
    expect(body.items.map((r: OverviewManifestRow) => r.orgSlug)).toEqual(["c-org", "d-org"]);
    expect(body.pagination.page).toBe(2);
    expect(body.pagination.totalItems).toBe(4);
  });
});
