import { describe, it, expect } from "bun:test";
import { createTestDb, type TestDb } from "../../../tests/db-helper";
import { organizations, sources } from "@buildinternet/releases-core/schema";
import { getProviderHealth } from "../src/queries/provider-health.js";
import type { D1Db } from "../src/db.js";

async function addOrg(db: TestDb, id: string, slug: string): Promise<void> {
  await db.insert(organizations).values({ id, slug, name: slug, category: "developer-tools" });
}

async function addSource(
  db: TestDb,
  id: string,
  orgId: string,
  slug: string,
  opts: Partial<{
    fetchPriority: "normal" | "low" | "paused";
    isHidden: boolean;
    deletedAt: string;
    lastFetchedAt: string | null;
    createdAt: string;
  }> = {},
): Promise<void> {
  await db.insert(sources).values({
    id,
    orgId,
    slug,
    name: slug,
    url: `https://${slug}.test/changelog`,
    type: "scrape",
    fetchPriority: opts.fetchPriority ?? "normal",
    isHidden: opts.isHidden ?? false,
    deletedAt: opts.deletedAt ?? null,
    lastFetchedAt: opts.lastFetchedAt ?? null,
    createdAt: opts.createdAt ?? daysAgo(365),
  });
}

/** ISO timestamp N days before "now" at query time. */
function daysAgo(n: number): string {
  return new Date(Date.now() - n * 86_400_000).toISOString();
}

describe("getProviderHealth", () => {
  it("treats a source with a recent last_fetched_at as healthy even with no new releases", async () => {
    const { db } = createTestDb();
    await addOrg(db, "org_a", "acme");
    // Fetched an hour ago, checked and found nothing new — healthy-but-quiet,
    // not the same thing as broken. This is the single most important
    // distinction the health scan has to get right (see #2168 postmortem).
    await addSource(db, "src_1", "org_a", "acme-changelog", { lastFetchedAt: daysAgo(0) });

    const result = await getProviderHealth(db as unknown as D1Db);

    expect(result.totalActiveSources).toBe(1);
    expect(result.overdueSources).toBe(0);
    expect(result.items).toHaveLength(0);
  });

  it("flags a source whose last_fetched_at has frozen past the overdue threshold", async () => {
    const { db } = createTestDb();
    await addOrg(db, "org_a", "acme");
    // Last successfully checked 6 days ago and never since — this is the
    // exact shape of the 2026-07-23 outage: last_fetched_at stopped moving
    // while nothing else in the UI necessarily looked different yet.
    await addSource(db, "src_1", "org_a", "acme-changelog", { lastFetchedAt: daysAgo(6) });

    const result = await getProviderHealth(db as unknown as D1Db);

    expect(result.totalActiveSources).toBe(1);
    expect(result.overdueSources).toBe(1);
    expect(result.items).toHaveLength(1);
    expect(result.items[0].sourceSlug).toBe("acme-changelog");
    expect(result.items[0].daysSinceFetched).toBeGreaterThanOrEqual(6);
  });

  it("uses created_at as the clock for a never-fetched source, not flagging it before onboarding age passes the threshold", async () => {
    const { db } = createTestDb();
    await addOrg(db, "org_a", "acme");
    await addSource(db, "src_new", "org_a", "brand-new", {
      lastFetchedAt: null,
      createdAt: daysAgo(1),
    });

    const result = await getProviderHealth(db as unknown as D1Db);

    expect(result.overdueSources).toBe(0);
    expect(result.items).toHaveLength(0);
  });

  it("flags a never-fetched source once it has been sitting unfetched long enough", async () => {
    const { db } = createTestDb();
    await addOrg(db, "org_a", "acme");
    await addSource(db, "src_old", "org_a", "old-and-unfetched", {
      lastFetchedAt: null,
      createdAt: daysAgo(10),
    });

    const result = await getProviderHealth(db as unknown as D1Db);

    expect(result.overdueSources).toBe(1);
    expect(result.items[0].lastFetchedAt).toBeNull();
  });

  it("excludes paused sources — they're expected to sit still", async () => {
    const { db } = createTestDb();
    await addOrg(db, "org_a", "acme");
    await addSource(db, "src_paused", "org_a", "paused-source", {
      fetchPriority: "paused",
      lastFetchedAt: daysAgo(30),
    });

    const result = await getProviderHealth(db as unknown as D1Db);

    expect(result.totalActiveSources).toBe(0);
    expect(result.overdueSources).toBe(0);
    expect(result.items).toHaveLength(0);
  });

  it("excludes hidden sources", async () => {
    const { db } = createTestDb();
    await addOrg(db, "org_a", "acme");
    await addSource(db, "src_hidden", "org_a", "hidden-source", {
      isHidden: true,
      lastFetchedAt: daysAgo(30),
    });

    const result = await getProviderHealth(db as unknown as D1Db);

    expect(result.totalActiveSources).toBe(0);
    expect(result.items).toHaveLength(0);
  });

  it("excludes soft-deleted sources", async () => {
    const { db } = createTestDb();
    await addOrg(db, "org_a", "acme");
    await addSource(db, "src_deleted", "org_a", "deleted-source", {
      deletedAt: daysAgo(1),
      lastFetchedAt: daysAgo(30),
    });

    const result = await getProviderHealth(db as unknown as D1Db);

    expect(result.totalActiveSources).toBe(0);
    expect(result.items).toHaveLength(0);
  });

  it("counts distinct overdue orgs separately from total active orgs — the systemic-outage signal", async () => {
    const { db } = createTestDb();
    await addOrg(db, "org_a", "acme");
    await addOrg(db, "org_b", "beta");
    await addSource(db, "src_a1", "org_a", "acme-1", { lastFetchedAt: daysAgo(6) });
    await addSource(db, "src_a2", "org_a", "acme-2", { lastFetchedAt: daysAgo(6) });
    await addSource(db, "src_b1", "org_b", "beta-1", { lastFetchedAt: daysAgo(0) });

    const result = await getProviderHealth(db as unknown as D1Db);

    expect(result.totalOrgs).toBe(2);
    expect(result.overdueOrgs).toBe(1);
    expect(result.overdueSources).toBe(2);
  });

  it("respects a custom overdueDays threshold", async () => {
    const { db } = createTestDb();
    await addOrg(db, "org_a", "acme");
    await addSource(db, "src_1", "org_a", "acme-changelog", { lastFetchedAt: daysAgo(2) });

    const strict = await getProviderHealth(db as unknown as D1Db, { overdueDays: 1 });
    expect(strict.overdueSources).toBe(1);

    const lenient = await getProviderHealth(db as unknown as D1Db, { overdueDays: 5 });
    expect(lenient.overdueSources).toBe(0);
  });

  it("orders overdue sources by days-since-fetched descending", async () => {
    const { db } = createTestDb();
    await addOrg(db, "org_a", "acme");
    await addSource(db, "src_worse", "org_a", "worse", { lastFetchedAt: daysAgo(20) });
    await addSource(db, "src_worst", "org_a", "worst", { lastFetchedAt: daysAgo(40) });

    const result = await getProviderHealth(db as unknown as D1Db);

    expect(result.items.map((i) => i.sourceSlug)).toEqual(["worst", "worse"]);
  });
});
