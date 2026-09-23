import { describe, it, expect, beforeEach } from "bun:test";
import { createTestApp } from "./setup";
import { createTestDb, type TestDb } from "../../../tests/db-helper";
import { organizations, sources, fetchLog } from "@buildinternet/releases-core/schema";
import { getStuckSources } from "../src/queries/stuck-sources.js";
import { adminSourcesRoutes } from "../src/routes/admin-sources.js";
import type { D1Db } from "../src/db.js";
import type { FetchLogStatus } from "@buildinternet/releases-core/schema";
import type { StuckSourcesResponse } from "@buildinternet/releases-api-types";

let logCounter = 0;

// Reset the shared fetch_log id counter so ids are deterministic per test.
beforeEach(() => {
  logCounter = 0;
});

async function addOrg(db: TestDb, id: string, slug: string): Promise<void> {
  await db.insert(organizations).values({ id, slug, name: slug, category: "developer-tools" });
}

async function addSource(
  db: TestDb,
  id: string,
  orgId: string,
  slug: string,
  opts: Partial<{
    type: "github" | "scrape" | "feed" | "agent";
    fetchPriority: "normal" | "low" | "paused";
    isPrimary: boolean;
    isHidden: boolean;
    deletedAt: string;
    lastFetchedAt: string;
  }> = {},
): Promise<void> {
  await db.insert(sources).values({
    id,
    orgId,
    slug,
    name: slug,
    url: `https://${slug}.test/changelog`,
    type: opts.type ?? "scrape",
    fetchPriority: opts.fetchPriority ?? "normal",
    isPrimary: opts.isPrimary ?? false,
    isHidden: opts.isHidden ?? false,
    deletedAt: opts.deletedAt ?? null,
    lastFetchedAt: opts.lastFetchedAt ?? null,
  });
}

async function addLog(
  db: TestDb,
  sourceId: string,
  status: FetchLogStatus,
  createdAt: string,
  opts: Partial<{ error: string | null; errorCategory: string }> = {},
): Promise<void> {
  await db.insert(fetchLog).values({
    id: `fl_${++logCounter}`,
    sourceId,
    status,
    releasesFound: 0,
    releasesInserted: 0,
    error: opts.error ?? (status === "error" ? "boom" : null),
    errorCategory: opts.errorCategory ?? null,
    createdAt,
  });
}

/** Ascending ISO timestamp: higher `day` = more recent. */
function ts(day: number): string {
  return new Date(Date.UTC(2026, 4, day, 1, 0, 0)).toISOString();
}

/** Seed N consecutive error rows for a source, most recent last. */
async function addErrorStreak(
  db: TestDb,
  sourceId: string,
  n: number,
  startDay = 1,
): Promise<void> {
  for (let i = 0; i < n; i++) {
    // oxlint-disable-next-line no-await-in-loop -- sequential seed inserts
    await addLog(db, sourceId, "error", ts(startDay + i), { error: `fail ${i}` });
  }
}

describe("getStuckSources", () => {
  it("flags a source whose recent attempts are all errors and never succeeded", async () => {
    const { db } = createTestDb();
    await addOrg(db, "org_fb", "firebase");
    await addSource(db, "src_rn", "org_fb", "release-notes", { type: "scrape" });
    await addErrorStreak(db, "src_rn", 4);

    const { items, totalItems } = await getStuckSources(db as unknown as D1Db);

    expect(totalItems).toBe(1);
    expect(items).toHaveLength(1);
    const s = items[0];
    expect(s.sourceSlug).toBe("release-notes");
    expect(s.orgSlug).toBe("firebase");
    expect(s.type).toBe("scrape");
    expect(s.recentAttempts).toBe(4);
    expect(s.recentErrors).toBe(4);
    expect(s.lastSuccessAt).toBeNull();
    expect(s.lastError).toBe("fail 3");
  });

  it("does not flag a source that was reachable within the window", async () => {
    const { db } = createTestDb();
    await addOrg(db, "org_a", "acme");
    await addSource(db, "src_ok", "org_a", "acme-feed");
    await addErrorStreak(db, "src_ok", 3, 1);
    await addLog(db, "src_ok", "no_change", ts(10)); // most recent = reachable

    const { items } = await getStuckSources(db as unknown as D1Db);

    expect(items).toHaveLength(0);
  });

  it("does not flag a source with fewer than minAttempts error rows", async () => {
    const { db } = createTestDb();
    await addOrg(db, "org_a", "acme");
    await addSource(db, "src_new", "org_a", "acme-new");
    await addErrorStreak(db, "src_new", 2); // below default minAttempts=3

    const { items } = await getStuckSources(db as unknown as D1Db);

    expect(items).toHaveLength(0);
  });

  it("excludes already-paused sources by default and includes them with includePaused", async () => {
    const { db } = createTestDb();
    await addOrg(db, "org_a", "acme");
    await addSource(db, "src_paused", "org_a", "acme-paused", { fetchPriority: "paused" });
    await addErrorStreak(db, "src_paused", 4);

    const def = await getStuckSources(db as unknown as D1Db);
    expect(def.items).toHaveLength(0);

    const incl = await getStuckSources(db as unknown as D1Db, { includePaused: true });
    expect(incl.items).toHaveLength(1);
    expect(incl.items[0].fetchPriority).toBe("paused");
  });

  it("includes a stuck source with NULL fetch_priority in the default view", async () => {
    const { db } = createTestDb();
    await addOrg(db, "org_a", "acme");
    // fetch_priority is nullable; a NULL row must not be dropped by the
    // not-paused predicate (NULL != 'paused' is NULL, not TRUE).
    await db.insert(sources).values({
      id: "src_null",
      orgId: "org_a",
      slug: "acme-null",
      name: "acme-null",
      url: "https://acme-null.test/changelog",
      type: "scrape",
      fetchPriority: null,
    });
    await addErrorStreak(db, "src_null", 4);

    const { items } = await getStuckSources(db as unknown as D1Db);

    expect(items).toHaveLength(1);
    expect(items[0].sourceSlug).toBe("acme-null");
    expect(items[0].fetchPriority).toBe("normal"); // NULL → defaulted in the row mapping
  });

  it("excludes soft-deleted sources", async () => {
    const { db } = createTestDb();
    await addOrg(db, "org_a", "acme");
    await addSource(db, "src_del", "org_a", "acme-del", { deletedAt: ts(20) });
    await addErrorStreak(db, "src_del", 4);

    const { items } = await getStuckSources(db as unknown as D1Db);

    expect(items).toHaveLength(0);
  });

  it("ignores dry_run rows when evaluating the window", async () => {
    const { db } = createTestDb();
    await addOrg(db, "org_a", "acme");
    await addSource(db, "src_dry", "org_a", "acme-dry");
    await addErrorStreak(db, "src_dry", 3, 1);
    // Manual dry-run probes are the most-recent rows but must not count as reachability.
    await addLog(db, "src_dry", "dry_run", ts(10));
    await addLog(db, "src_dry", "dry_run", ts(11));

    const { items } = await getStuckSources(db as unknown as D1Db);

    expect(items).toHaveLength(1);
    expect(items[0].recentAttempts).toBe(3);
    expect(items[0].recentErrors).toBe(3);
  });

  it("reports lastSuccessAt from full history even when the streak fills the window", async () => {
    const { db } = createTestDb();
    await addOrg(db, "org_a", "acme");
    await addSource(db, "src_old", "org_a", "acme-old");
    await addLog(db, "src_old", "success", ts(1)); // old success, outside the 5-row window
    await addErrorStreak(db, "src_old", 6, 2); // 6 errors push the success out of the window

    const { items } = await getStuckSources(db as unknown as D1Db);

    expect(items).toHaveLength(1);
    expect(items[0].recentAttempts).toBe(5); // capped at the window
    expect(items[0].recentErrors).toBe(5);
    expect(items[0].lastSuccessAt).toBe(ts(1));
  });

  it("orders never-succeeded sources ahead of previously-succeeded ones", async () => {
    const { db } = createTestDb();
    await addOrg(db, "org_a", "acme");
    await addSource(db, "src_never", "org_a", "acme-never");
    await addErrorStreak(db, "src_never", 4, 1);
    await addSource(db, "src_was_ok", "org_a", "acme-was-ok");
    await addLog(db, "src_was_ok", "success", ts(1));
    await addErrorStreak(db, "src_was_ok", 6, 2);

    const { items } = await getStuckSources(db as unknown as D1Db);

    expect(items).toHaveLength(2);
    expect(items[0].sourceSlug).toBe("acme-never");
    expect(items[1].sourceSlug).toBe("acme-was-ok");
  });
});

describe("GET /v1/admin/sources/stuck", () => {
  it("wraps stuck sources in a ListResponse with meta", async () => {
    const { db } = createTestDb();
    await addOrg(db, "org_fb", "firebase");
    await addSource(db, "src_rn", "org_fb", "release-notes", { type: "scrape" });
    await addErrorStreak(db, "src_rn", 4);
    const app = createTestApp(db, adminSourcesRoutes);

    const res = await app(new Request("https://x.test/v1/admin/sources/stuck"));
    expect(res.status).toBe(200);
    const body = (await res.json()) as StuckSourcesResponse;

    expect(body.items).toHaveLength(1);
    expect(body.items[0].sourceSlug).toBe("release-notes");
    expect(body.meta).toEqual({ window: 5, minAttempts: 3, includePaused: false });
    expect(body.pagination.page).toBe(1);
    expect(body.pagination.totalItems).toBe(1);
  });

  it("includes paused sources and echoes the flag when includePaused=true", async () => {
    const { db } = createTestDb();
    await addOrg(db, "org_a", "acme");
    await addSource(db, "src_p", "org_a", "acme-paused", { fetchPriority: "paused" });
    await addErrorStreak(db, "src_p", 4);
    const app = createTestApp(db, adminSourcesRoutes);

    const off = await app(new Request("https://x.test/v1/admin/sources/stuck"));
    expect(((await off.json()) as StuckSourcesResponse).items).toHaveLength(0);

    const on = await app(new Request("https://x.test/v1/admin/sources/stuck?includePaused=true"));
    const body = (await on.json()) as StuckSourcesResponse;
    expect(body.items).toHaveLength(1);
    expect(body.meta.includePaused).toBe(true);
  });

  it("honors and echoes window/minAttempts query params", async () => {
    const { db } = createTestDb();
    await addOrg(db, "org_a", "acme");
    await addSource(db, "src_two", "org_a", "acme-two");
    await addErrorStreak(db, "src_two", 2); // only 2 errors

    const app = createTestApp(db, adminSourcesRoutes);
    // Default minAttempts=3 → not flagged.
    const def = await app(new Request("https://x.test/v1/admin/sources/stuck"));
    expect(((await def.json()) as StuckSourcesResponse).items).toHaveLength(0);

    // Lowering minAttempts to 2 flags it.
    const res = await app(
      new Request("https://x.test/v1/admin/sources/stuck?window=3&minAttempts=2"),
    );
    const body = (await res.json()) as StuckSourcesResponse;
    expect(body.items).toHaveLength(1);
    expect(body.meta).toEqual({ window: 3, minAttempts: 2, includePaused: false });
  });
});

/**
 * Seed N consecutive rows of a single status for a source, most recent last.
 * `opts` (when given) is applied to every row — pass `{ error: null }` to seed a
 * degraded row that carries no error message; otherwise each row gets a distinct
 * `"<status> <i>"` error so lastError assertions stay stable.
 */
async function addStatusStreak(
  db: TestDb,
  sourceId: string,
  status: FetchLogStatus,
  n: number,
  startDay = 1,
  opts?: Partial<{ error: string | null; errorCategory: string }>,
): Promise<void> {
  for (let i = 0; i < n; i++) {
    // oxlint-disable-next-line no-await-in-loop -- sequential seed inserts
    await addLog(db, sourceId, status, ts(startDay + i), opts ?? { error: `${status} ${i}` });
  }
}

// The bonus from #1360: crawl_timeout / blocked are "middle" states the stuck
// query previously ignored — a chronically degraded crawl source surfaced (it
// passes the recent_ok=0 gate) but reported recentErrors=0, reading as healthy.
// They now count as failed/degraded attempts so the count is truthful and the
// recent_errors-DESC ranking is correct.
describe("getStuckSources — crawl_timeout / blocked degraded states", () => {
  it("counts an all-crawl_timeout window toward recentErrors", async () => {
    const { db } = createTestDb();
    await addOrg(db, "org_c", "crawler");
    await addSource(db, "src_ct", "org_c", "crawl-index", { type: "scrape" });
    await addStatusStreak(db, "src_ct", "crawl_timeout", 4);

    const { items } = await getStuckSources(db as unknown as D1Db);

    expect(items).toHaveLength(1);
    expect(items[0].sourceSlug).toBe("crawl-index");
    expect(items[0].recentAttempts).toBe(4);
    expect(items[0].recentErrors).toBe(4); // was 0 before the fix
    expect(items[0].lastError).toBe("crawl_timeout 3");
  });

  it("counts an all-blocked window toward recentErrors", async () => {
    const { db } = createTestDb();
    await addOrg(db, "org_b", "blocked-org");
    await addSource(db, "src_bl", "org_b", "blocked-src", { type: "scrape" });
    await addStatusStreak(db, "src_bl", "blocked", 3);

    const { items } = await getStuckSources(db as unknown as D1Db);

    expect(items).toHaveLength(1);
    expect(items[0].recentAttempts).toBe(3);
    expect(items[0].recentErrors).toBe(3);
  });

  it("counts a mixed error + crawl_timeout window fully toward recentErrors", async () => {
    const { db } = createTestDb();
    await addOrg(db, "org_m", "mixed");
    await addSource(db, "src_mx", "org_m", "mixed-src", { type: "scrape" });
    await addLog(db, "src_mx", "error", ts(1), { error: "boom" });
    await addLog(db, "src_mx", "crawl_timeout", ts(2), { error: "timed out" });
    await addLog(db, "src_mx", "blocked", ts(3), { error: "challenge" });

    const { items } = await getStuckSources(db as unknown as D1Db, { minAttempts: 3 });

    expect(items).toHaveLength(1);
    expect(items[0].recentAttempts).toBe(3);
    expect(items[0].recentErrors).toBe(3);
  });

  it("does NOT flag a source that mixes success with crawl_timeout (membership unchanged)", async () => {
    const { db } = createTestDb();
    await addOrg(db, "org_p", "partial");
    await addSource(db, "src_pt", "org_p", "partial-src", { type: "scrape" });
    await addStatusStreak(db, "src_pt", "crawl_timeout", 3, 1);
    await addLog(db, "src_pt", "success", ts(10)); // reachable within the window

    const { items } = await getStuckSources(db as unknown as D1Db);

    expect(items).toHaveLength(0);
  });

  it("counts crawl_timeout rows even when their error column is null", async () => {
    // The count keys off `status`, not the error message — a degraded row with
    // no error text must still count, and lastError stays null.
    const { db } = createTestDb();
    await addOrg(db, "org_n", "null-err");
    await addSource(db, "src_ce", "org_n", "null-err-src", { type: "scrape" });
    await addStatusStreak(db, "src_ce", "crawl_timeout", 4, 1, { error: null });

    const { items } = await getStuckSources(db as unknown as D1Db);

    expect(items).toHaveLength(1);
    expect(items[0].recentAttempts).toBe(4);
    expect(items[0].recentErrors).toBe(4);
    expect(items[0].lastError).toBeNull();
  });
});
