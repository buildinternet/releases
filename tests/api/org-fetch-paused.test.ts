/**
 * Tests for the per-org fetchPaused flag (#1057).
 *
 * Covers:
 *   1. queryDueSources excludes sources whose org has fetchPaused = true.
 *   2. queryCandidates excludes sources whose org has fetchPaused = true.
 *   3. PATCH /v1/orgs/:slug { fetchPaused: true } persists the flag.
 */
import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { Database } from "bun:sqlite";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { applyMigrations, createTestDb, type TestDatabase } from "../db-helper";
import { organizations, sources } from "@buildinternet/releases-core/schema";
import { queryDueSources } from "../../workers/api/src/cron/poll-fetch";
import { queryCandidates } from "../../workers/api/src/cron/scrape-agent-sweep";
import { orgRoutes } from "../../workers/api/src/routes/orgs.js";
import { makeJsonCaller } from "./route-test-helpers.js";

// ── queryDueSources ──────────────────────────────────────────────────────────

describe("queryDueSources: fetchPaused org filter", () => {
  it("excludes sources whose org has fetchPaused = true", async () => {
    const sqlite = new Database(":memory:");
    const db = drizzle(sqlite);
    applyMigrations(sqlite);

    const stale = "2020-01-01T00:00:00.000Z";

    // Two orgs: one paused, one not.
    await db
      .insert(organizations)
      .values([
        { id: "org_active", slug: "active-org", name: "Active" },
        { id: "org_paused", slug: "paused-org", name: "Paused", fetchPaused: true },
      ])
      .run();

    await db
      .insert(sources)
      .values([
        {
          id: "src_active",
          orgId: "org_active",
          name: "Active Source",
          slug: "active-src",
          type: "github",
          url: "https://github.com/active/repo",
          fetchPriority: "normal",
          lastPolledAt: stale,
          metadata: "{}",
        },
        {
          id: "src_paused",
          orgId: "org_paused",
          name: "Paused Org Source",
          slug: "paused-src",
          type: "github",
          url: "https://github.com/paused/repo",
          fetchPriority: "normal",
          lastPolledAt: stale,
          metadata: "{}",
        },
      ])
      .run();

    const due = await queryDueSources(db as any, new Date());
    const ids = due.map((s) => s.id);

    expect(ids).toContain("src_active");
    expect(ids).not.toContain("src_paused");
  });

  it("includes sources from orgs with fetchPaused = false", async () => {
    const sqlite = new Database(":memory:");
    const db = drizzle(sqlite);
    applyMigrations(sqlite);

    const stale = "2020-01-01T00:00:00.000Z";

    await db
      .insert(organizations)
      .values({ id: "org_a", slug: "org-a", name: "Org A", fetchPaused: false })
      .run();

    await db
      .insert(sources)
      .values({
        id: "src_a",
        orgId: "org_a",
        name: "Source A",
        slug: "src-a",
        type: "github",
        url: "https://github.com/a/repo",
        fetchPriority: "normal",
        lastPolledAt: stale,
        metadata: "{}",
      })
      .run();

    const due = await queryDueSources(db as any, new Date());
    expect(due.map((s) => s.id)).toContain("src_a");
  });
});

// ── queryCandidates ──────────────────────────────────────────────────────────

describe("queryCandidates: fetchPaused org filter", () => {
  it("excludes sources whose org has fetchPaused = true", async () => {
    const sqlite = new Database(":memory:");
    const db = drizzle(sqlite);
    applyMigrations(sqlite);

    await db
      .insert(organizations)
      .values([
        { id: "org_active", slug: "active-org", name: "Active" },
        { id: "org_paused", slug: "paused-org", name: "Paused", fetchPaused: true },
      ])
      .run();

    await db
      .insert(sources)
      .values([
        {
          id: "src_active",
          orgId: "org_active",
          name: "Active Scrape",
          slug: "active-scrape",
          type: "scrape",
          url: "https://active.com/changelog",
          changeDetectedAt: "2026-04-18T00:00:00Z",
          metadata: "{}",
        },
        {
          id: "src_paused",
          orgId: "org_paused",
          name: "Paused Scrape",
          slug: "paused-scrape",
          type: "scrape",
          url: "https://paused.com/changelog",
          changeDetectedAt: "2026-04-18T00:00:00Z",
          metadata: "{}",
        },
      ])
      .run();

    const result = await queryCandidates(db, { cap: 10 });
    const ids = result.rows.map((r) => r.id);

    expect(ids).toContain("src_active");
    expect(ids).not.toContain("src_paused");
  });
});

// ── PATCH /v1/orgs/:slug ─────────────────────────────────────────────────────

let testDb: TestDatabase;

beforeEach(() => {
  testDb = createTestDb();
});

afterEach(() => {
  testDb.cleanup();
});

function makeEnv(extra: Record<string, unknown> = {}) {
  return { DB: testDb.db as unknown as never, ...extra };
}

const call = makeJsonCaller(orgRoutes, makeEnv);

describe("PATCH /v1/orgs/:slug { fetchPaused }", () => {
  it("sets fetchPaused = true and persists it", async () => {
    await testDb.db.insert(organizations).values({
      id: "org_acme",
      name: "Acme",
      slug: "acme",
      discovery: "curated",
    });

    const res = await call("/orgs/acme", "PATCH", { fetchPaused: true });
    expect(res.status).toBe(200);

    const body = (await res.json()) as { fetchPaused: boolean };
    expect(body.fetchPaused).toBe(true);
  });

  it("sets fetchPaused = false (unpause)", async () => {
    await testDb.db.insert(organizations).values({
      id: "org_acme2",
      name: "Acme 2",
      slug: "acme2",
      discovery: "curated",
      fetchPaused: true,
    });

    const res = await call("/orgs/acme2", "PATCH", { fetchPaused: false });
    expect(res.status).toBe(200);

    const body = (await res.json()) as { fetchPaused: boolean };
    expect(body.fetchPaused).toBe(false);
  });
});
