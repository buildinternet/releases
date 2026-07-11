/**
 * GET /v1/sitemap/releases (#1181 scoped down, WS2): curated, importance-gated
 * release payload for the release sitemap. Every gate exclusion is covered
 * individually — fail-closed by construction (releases_visible + explicit
 * isHidden joins), so each test seeds exactly one disqualifying condition
 * against an otherwise-qualifying release.
 */
import { describe, it, expect } from "bun:test";
import { organizations, sources, releases } from "@buildinternet/releases-core/schema";
import { releaseCoverage } from "@releases/core-internal/schema-coverage";
import { sitemapRoutes } from "../src/routes/sitemap.js";
import {
  getSitemapReleases,
  RELEASE_SITEMAP_MIN_IMPORTANCE,
  SITEMAP_RELEASES_CAP,
} from "../src/queries/sitemap-releases.js";
import { createTestDb, createTestApp } from "./setup";

async function seedOrgAndSource(
  db: ReturnType<typeof createTestDb>,
  opts: { orgId?: string; orgHidden?: boolean; sourceId?: string; sourceHidden?: boolean } = {},
) {
  const orgId = opts.orgId ?? "org_acme";
  const sourceId = opts.sourceId ?? "src_acme";
  await db
    .insert(organizations)
    .values({
      id: orgId,
      slug: orgId.replace("org_", ""),
      name: "Acme",
      category: "cloud",
      isHidden: opts.orgHidden ?? false,
    })
    .onConflictDoNothing();
  await db
    .insert(sources)
    .values({
      id: sourceId,
      slug: sourceId.replace("src_", ""),
      name: "Acme Feed",
      type: "feed",
      url: `https://acme.test/${sourceId}`,
      orgId,
      isHidden: opts.sourceHidden ?? false,
    })
    .onConflictDoNothing();
  return { orgId, sourceId };
}

let counter = 0;
function releaseId(): string {
  counter += 1;
  // rel_ + 21 chars, positionally parsed elsewhere — doesn't matter for
  // these tests but keep the shape realistic.
  return `rel_sitemaptest${String(counter).padStart(6, "0")}`;
}

async function seedRelease(
  db: ReturnType<typeof createTestDb>,
  sourceId: string,
  overrides: Partial<{
    summary: string | null;
    importance: number | null;
    suppressed: boolean | null;
    publishedAt: string | null;
  }> = {},
) {
  const id = releaseId();
  // `??` would coalesce an explicit `null` override back to the default —
  // use `in` so a test that passes `{ summary: null }` actually seeds NULL.
  await db.insert(releases).values({
    id,
    sourceId,
    title: `Release ${id}`,
    content: "Body",
    summary: "summary" in overrides ? overrides.summary : "A qualifying summary.",
    importance: "importance" in overrides ? overrides.importance : RELEASE_SITEMAP_MIN_IMPORTANCE,
    suppressed: "suppressed" in overrides ? overrides.suppressed : false,
    publishedAt: "publishedAt" in overrides ? overrides.publishedAt : "2026-07-01T00:00:00Z",
  });
  return id;
}

describe("getSitemapReleases gate exclusions", () => {
  it("includes a release that passes every gate", async () => {
    const db = createTestDb();
    const { sourceId } = await seedOrgAndSource(db);
    const id = await seedRelease(db, sourceId);

    const { rows } = await getSitemapReleases(db);
    expect(rows.map((r) => r.id)).toContain(id);
  });

  it("excludes a suppressed release", async () => {
    const db = createTestDb();
    const { sourceId } = await seedOrgAndSource(db);
    const id = await seedRelease(db, sourceId, { suppressed: true });

    const { rows } = await getSitemapReleases(db);
    expect(rows.map((r) => r.id)).not.toContain(id);
  });

  it("excludes a coverage-side release", async () => {
    const db = createTestDb();
    const { sourceId } = await seedOrgAndSource(db);
    const canonicalId = await seedRelease(db, sourceId);
    const coverageId = await seedRelease(db, sourceId);
    await db.insert(releaseCoverage).values({
      coverageId,
      canonicalId,
      decidedBy: "test",
    });

    const { rows } = await getSitemapReleases(db);
    const ids = rows.map((r) => r.id);
    expect(ids).toContain(canonicalId);
    expect(ids).not.toContain(coverageId);
  });

  it("excludes a release on a hidden org", async () => {
    const db = createTestDb();
    const { sourceId } = await seedOrgAndSource(db, { orgId: "org_hidden", orgHidden: true });
    const id = await seedRelease(db, sourceId);

    const { rows } = await getSitemapReleases(db);
    expect(rows.map((r) => r.id)).not.toContain(id);
  });

  it("excludes a release on a hidden source", async () => {
    const db = createTestDb();
    const { sourceId } = await seedOrgAndSource(db, {
      sourceId: "src_hidden",
      sourceHidden: true,
    });
    const id = await seedRelease(db, sourceId);

    const { rows } = await getSitemapReleases(db);
    expect(rows.map((r) => r.id)).not.toContain(id);
  });

  it("excludes a release on an on-demand-discovery org (organizations_public join)", async () => {
    const db = createTestDb();
    const orgId = "org_ondemand";
    const sourceId = "src_ondemand";
    await db.insert(organizations).values({
      id: orgId,
      slug: "ondemand-co",
      name: "OnDemand Co",
      category: "cloud",
      discovery: "on_demand",
    });
    await db.insert(sources).values({
      id: sourceId,
      slug: "ondemand-feed",
      name: "OnDemand Feed",
      type: "feed",
      url: "https://ondemand.test/feed",
      orgId,
    });
    const id = await seedRelease(db, sourceId);

    const { rows } = await getSitemapReleases(db);
    expect(rows.map((r) => r.id)).not.toContain(id);
  });

  it("excludes a release with an empty summary", async () => {
    const db = createTestDb();
    const { sourceId } = await seedOrgAndSource(db);
    const emptyId = await seedRelease(db, sourceId, { summary: "" });
    const nullId = await seedRelease(db, sourceId, { summary: null });

    const { rows } = await getSitemapReleases(db);
    const ids = rows.map((r) => r.id);
    expect(ids).not.toContain(emptyId);
    expect(ids).not.toContain(nullId);
  });

  it("excludes importance below the threshold; includes it at the boundary (>=)", async () => {
    const db = createTestDb();
    const { sourceId } = await seedOrgAndSource(db);
    const belowId = await seedRelease(db, sourceId, {
      importance: RELEASE_SITEMAP_MIN_IMPORTANCE - 1,
    });
    const atId = await seedRelease(db, sourceId, { importance: RELEASE_SITEMAP_MIN_IMPORTANCE });
    const aboveId = await seedRelease(db, sourceId, {
      importance: RELEASE_SITEMAP_MIN_IMPORTANCE + 1,
    });
    const nullId = await seedRelease(db, sourceId, { importance: null });

    const { rows } = await getSitemapReleases(db);
    const ids = rows.map((r) => r.id);
    expect(ids).not.toContain(belowId);
    expect(ids).not.toContain(nullId);
    expect(ids).toContain(atId);
    expect(ids).toContain(aboveId);
  });

  it("orders by published_at DESC", async () => {
    const db = createTestDb();
    const { sourceId } = await seedOrgAndSource(db);
    const older = await seedRelease(db, sourceId, { publishedAt: "2026-01-01T00:00:00Z" });
    const newer = await seedRelease(db, sourceId, { publishedAt: "2026-06-01T00:00:00Z" });
    const middle = await seedRelease(db, sourceId, { publishedAt: "2026-03-01T00:00:00Z" });

    const { rows } = await getSitemapReleases(db);
    const ids = rows.map((r) => r.id).filter((id) => [older, newer, middle].includes(id));
    expect(ids).toEqual([newer, middle, older]);
  });

  it("excludes a release on an on-demand-discovery source", async () => {
    const db = createTestDb();
    const { orgId } = await seedOrgAndSource(db);
    const sourceId = "src_ondemandsrc";
    await db.insert(sources).values({
      id: sourceId,
      slug: "ondemand-src",
      name: "On-demand Source",
      type: "feed",
      url: "https://acme.test/ondemand-src",
      orgId,
      discovery: "on_demand",
    });
    const id = await seedRelease(db, sourceId);

    const { rows } = await getSitemapReleases(db);
    expect(rows.map((r) => r.id)).not.toContain(id);
  });

  it("caps via the injectable cap and keeps the newest rows", async () => {
    const db = createTestDb();
    const { sourceId } = await seedOrgAndSource(db);
    const ids: string[] = [];
    for (let i = 0; i < 5; i++) {
      ids.push(await seedRelease(db, sourceId, { publishedAt: `2026-01-1${i}T00:00:00Z` }));
    }
    const { rows, capped } = await getSitemapReleases(db, 3);
    expect(capped).toBe(true);
    expect(rows).toHaveLength(3);
    // published_at DESC → the three NEWEST survive the trim.
    expect(rows.map((r) => r.id)).toEqual([ids[4], ids[3], ids[2]]);
  });

  it("does not cap when under the limit", async () => {
    const db = createTestDb();
    const { sourceId } = await seedOrgAndSource(db);
    for (let i = 0; i < 5; i++) {
      await seedRelease(db, sourceId, { publishedAt: `2026-01-${10 + i}T00:00:00Z` });
    }
    const { rows, capped } = await getSitemapReleases(db);
    expect(capped).toBe(false);
    expect(rows.length).toBeGreaterThanOrEqual(5);
  });

  it("caps at SITEMAP_RELEASES_CAP rows when more qualify", async () => {
    const db = createTestDb();
    const { sourceId } = await seedOrgAndSource(db);
    const total = SITEMAP_RELEASES_CAP + 5;
    const values = Array.from({ length: total }, (_, i) => ({
      id: `rel_capbulk${String(i).padStart(10, "0")}`,
      sourceId,
      title: `Bulk ${i}`,
      content: "Body",
      summary: "A qualifying summary.",
      importance: RELEASE_SITEMAP_MIN_IMPORTANCE,
      suppressed: false,
      // Spread across distinct timestamps so DESC ordering is well-defined.
      publishedAt: new Date(2026, 0, 1, 0, 0, i).toISOString(),
    }));
    // bun:sqlite has no D1 100-bind chunk limit, but batch anyway to keep a
    // single statement reasonable.
    const BATCH = 500;
    for (let i = 0; i < values.length; i += BATCH) {
      await db.insert(releases).values(values.slice(i, i + BATCH));
    }

    const { rows, capped, totalMatched } = await getSitemapReleases(db);
    expect(capped).toBe(true);
    expect(rows).toHaveLength(SITEMAP_RELEASES_CAP);
    expect(totalMatched).toBeGreaterThan(SITEMAP_RELEASES_CAP);
  }, 20000);
});

describe("GET /v1/sitemap/releases route", () => {
  it("returns only qualifying releases in the wire shape", async () => {
    const db = createTestDb();
    const { sourceId } = await seedOrgAndSource(db);
    const qualifying = await seedRelease(db, sourceId);
    await seedRelease(db, sourceId, { summary: null });

    const app = createTestApp(db, sitemapRoutes);
    const res = await app(new Request("https://x/v1/sitemap/releases"));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { releases: { id: string; fetchedAt: string }[] };
    const ids = body.releases.map((r) => r.id);
    expect(ids).toContain(qualifying);
    expect(ids).toHaveLength(1);
    expect(body.releases[0]).toHaveProperty("fetchedAt");
  });
});
