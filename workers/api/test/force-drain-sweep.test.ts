import { describe, it, expect } from "bun:test";
import { Database } from "bun:sqlite";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { applyMigrations } from "../../../tests/db-helper";
import { eq, desc } from "drizzle-orm";
import { organizations, sources, knowledgePages } from "@buildinternet/releases-core/schema";
import { cronRuns } from "../src/db/schema-cron";
import { forceDrainSweep, pickCandidates } from "../src/cron/force-drain-sweep";

/**
 * Exercises Phase 3 Part A of #514 (issue #518):
 *   - Force-drain picks up sources marked `unreliable` via playbook quirks.
 *   - Falls back to `last_fetched_at < now - FORCE_DRAIN_STALE_HOURS`.
 *   - Respects `FORCE_SWEEP_MAX_SESSIONS` cap.
 *   - Writes a `cron_runs` row with a note that distinguishes healthy-quiet
 *     from active drain.
 *   - Default off — skips when the flag isn't set.
 */

function mkDb() {
  const sqlite = new Database(":memory:");
  const db = drizzle(sqlite);
  applyMigrations(sqlite);
  return db;
}

function seedOrg(db: ReturnType<typeof mkDb>, id: string, notes: string | null = null) {
  db.insert(organizations).values({ id, name: id, slug: id }).run();
  if (notes !== null) {
    db.insert(knowledgePages)
      .values({ scope: "playbook", orgId: id, content: "", notes } as any)
      .run();
  }
}

function seedSource(
  db: ReturnType<typeof mkDb>,
  opts: {
    id: string;
    slug: string;
    orgId: string;
    type?: "scrape" | "agent";
    lastFetchedAt?: string | null;
    changeDetectedAt?: string | null;
    metadata?: Record<string, unknown>;
  },
) {
  db.insert(sources)
    .values({
      id: opts.id,
      slug: opts.slug,
      name: opts.slug,
      orgId: opts.orgId,
      type: opts.type ?? "scrape",
      url: `https://example.com/${opts.slug}`,
      metadata: JSON.stringify(opts.metadata ?? {}),
      lastFetchedAt: opts.lastFetchedAt ?? null,
      changeDetectedAt: opts.changeDetectedAt ?? null,
    } as any)
    .run();
}

const UNRELIABLE_NOTES = `---
fetchQuirks:
  claude:
    changeDetector: unreliable
    rationale: SSR nonces
---
`;

const ETAG_NOTES = `---
fetchQuirks:
  brex:
    changeDetector: etag
    rationale: ETag stable
---
`;

const NOW = new Date("2026-04-23T04:00:00.000Z");
const STALE = new Date(NOW.getTime() - 96 * 3600_000).toISOString(); // 96h old
const FRESH = new Date(NOW.getTime() - 1 * 3600_000).toISOString(); // 1h old

describe("pickCandidates", () => {
  it("picks sources whose playbook marks them unreliable", async () => {
    const db = mkDb();
    seedOrg(db, "org_anthropic", UNRELIABLE_NOTES);
    seedSource(db, {
      id: "src_claude",
      slug: "claude",
      orgId: "org_anthropic",
      lastFetchedAt: FRESH, // fresh, so only picked if unreliable
    });

    const { candidates, totalStranded } = await pickCandidates(db as any, {
      now: NOW,
      staleHours: 72,
      cap: 10,
    });

    expect(candidates.map((c) => c.slug)).toEqual(["claude"]);
    expect(candidates[0].reason).toBe("unreliable");
    expect(totalStranded).toBe(1);
  });

  it("picks sources whose last_fetched_at is older than the stale cutoff", async () => {
    const db = mkDb();
    seedOrg(db, "org_x");
    seedSource(db, {
      id: "src_old",
      slug: "old",
      orgId: "org_x",
      lastFetchedAt: STALE,
    });
    seedSource(db, {
      id: "src_fresh",
      slug: "fresh",
      orgId: "org_x",
      lastFetchedAt: FRESH,
    });

    const { candidates } = await pickCandidates(db as any, {
      now: NOW,
      staleHours: 72,
      cap: 10,
    });

    expect(candidates.map((c) => c.slug)).toEqual(["old"]);
    expect(candidates[0].reason).toBe("stale");
  });

  it("treats never-fetched sources as stale", async () => {
    const db = mkDb();
    seedOrg(db, "org_x");
    seedSource(db, { id: "src_new", slug: "new", orgId: "org_x", lastFetchedAt: null });

    const { candidates } = await pickCandidates(db as any, {
      now: NOW,
      staleHours: 72,
      cap: 10,
    });

    expect(candidates.map((c) => c.slug)).toEqual(["new"]);
    expect(candidates[0].reason).toBe("stale");
  });

  it("skips sources already flagged (changeDetectedAt set)", async () => {
    const db = mkDb();
    seedOrg(db, "org_x");
    seedSource(db, {
      id: "src_flagged",
      slug: "flagged",
      orgId: "org_x",
      lastFetchedAt: STALE,
      changeDetectedAt: NOW.toISOString(),
    });

    const { candidates } = await pickCandidates(db as any, {
      now: NOW,
      staleHours: 72,
      cap: 10,
    });

    expect(candidates).toHaveLength(0);
  });

  it("skips sources that have a feedUrl (they go through the normal cron)", async () => {
    const db = mkDb();
    seedOrg(db, "org_x");
    seedSource(db, {
      id: "src_feed",
      slug: "feed-src",
      orgId: "org_x",
      lastFetchedAt: STALE,
      metadata: { feedUrl: "https://example.com/rss.xml" },
    });

    const { candidates } = await pickCandidates(db as any, {
      now: NOW,
      staleHours: 72,
      cap: 10,
    });

    expect(candidates).toHaveLength(0);
  });

  it("includes agent-type sources alongside scrape", async () => {
    const db = mkDb();
    seedOrg(db, "org_x");
    seedSource(db, {
      id: "src_agent",
      slug: "agent-src",
      orgId: "org_x",
      type: "agent",
      lastFetchedAt: STALE,
    });

    const { candidates } = await pickCandidates(db as any, {
      now: NOW,
      staleHours: 72,
      cap: 10,
    });

    expect(candidates.map((c) => c.slug)).toEqual(["agent-src"]);
  });

  it("respects the cap and reports totalStranded", async () => {
    const db = mkDb();
    seedOrg(db, "org_x");
    for (let i = 0; i < 5; i++) {
      seedSource(db, {
        id: `src_${i}`,
        slug: `src-${i}`,
        orgId: "org_x",
        lastFetchedAt: STALE,
      });
    }

    const { candidates, totalStranded } = await pickCandidates(db as any, {
      now: NOW,
      staleHours: 72,
      cap: 2,
    });

    expect(candidates).toHaveLength(2);
    expect(totalStranded).toBe(5);
  });

  it("leaves non-unreliable, non-stale sources alone", async () => {
    const db = mkDb();
    seedOrg(db, "org_x", ETAG_NOTES);
    seedSource(db, {
      id: "src_brex",
      slug: "brex",
      orgId: "org_x",
      lastFetchedAt: FRESH,
    });

    const { candidates } = await pickCandidates(db as any, {
      now: NOW,
      staleHours: 72,
      cap: 10,
    });

    expect(candidates).toHaveLength(0);
  });
});

describe("forceDrainSweep", () => {
  it("flag off → no candidates examined, no cron_runs row", async () => {
    const db = mkDb();
    seedOrg(db, "org_x");
    seedSource(db, { id: "src_stale", slug: "stale", orgId: "org_x", lastFetchedAt: STALE });

    await forceDrainSweep({
      DB: null as any,
      CRON_ENABLED: "true",
      _drizzleOverride: db,
    });

    const rows = db.select().from(cronRuns).all();
    expect(rows).toHaveLength(0);

    // Source untouched
    const [after] = db.select().from(sources).where(eq(sources.id, "src_stale")).all();
    expect(after.changeDetectedAt).toBeNull();
  });

  it("flag on + stale source → sets changeDetectedAt, writes done row", async () => {
    const db = mkDb();
    seedOrg(db, "org_x");
    seedSource(db, { id: "src_stale", slug: "stale", orgId: "org_x", lastFetchedAt: STALE });

    await forceDrainSweep({
      DB: null as any,
      CRON_ENABLED: "true",
      FORCE_DRAIN_CRON_ENABLED: "true",
      _drizzleOverride: db,
    });

    const [run] = db.select().from(cronRuns).orderBy(desc(cronRuns.startedAt)).all();
    expect(run.status).toBe("done");
    expect(run.candidates).toBe(1);
    expect(run.notes).toContain("forced=1");
    expect(run.notes).toContain("stale=1");

    const [after] = db.select().from(sources).where(eq(sources.id, "src_stale")).all();
    expect(after.changeDetectedAt).not.toBeNull();
  });

  it("flag on + no candidates → writes a healthy-quiet cron_runs note", async () => {
    const db = mkDb();
    seedOrg(db, "org_x");
    // forceDrainSweep uses real wall-clock — seed against now() so the
    // "fresh" fixture stays inside the 72h threshold regardless of the
    // hardcoded NOW used by the pickCandidates-injected tests above.
    const realFresh = new Date(Date.now() - 1 * 3600_000).toISOString();
    seedSource(db, { id: "src_fresh", slug: "fresh", orgId: "org_x", lastFetchedAt: realFresh });

    await forceDrainSweep({
      DB: null as any,
      CRON_ENABLED: "true",
      FORCE_DRAIN_CRON_ENABLED: "true",
      _drizzleOverride: db,
    });

    const [run] = db.select().from(cronRuns).orderBy(desc(cronRuns.startedAt)).all();
    expect(run.status).toBe("done");
    expect(run.candidates).toBe(0);
    expect(run.notes).toBe("no stale/unreliable sources");
  });

  it("reports skippedOverCap when stranded set exceeds the cap", async () => {
    const db = mkDb();
    seedOrg(db, "org_x");
    for (let i = 0; i < 4; i++) {
      seedSource(db, {
        id: `src_${i}`,
        slug: `src-${i}`,
        orgId: "org_x",
        lastFetchedAt: STALE,
      });
    }

    await forceDrainSweep({
      DB: null as any,
      CRON_ENABLED: "true",
      FORCE_DRAIN_CRON_ENABLED: "true",
      FORCE_SWEEP_MAX_SESSIONS: "2",
      _drizzleOverride: db,
    });

    const [run] = db.select().from(cronRuns).orderBy(desc(cronRuns.startedAt)).all();
    expect(run.candidates).toBe(2);
    expect(run.skippedOverCap).toBe(2);
    expect(run.notes).toContain("stranded_total=4");

    const flagged = db
      .select()
      .from(sources)
      .all()
      .filter((s) => s.changeDetectedAt !== null);
    expect(flagged).toHaveLength(2);
  });

  it("CRON_ENABLED=false → skips even when FORCE_DRAIN_CRON_ENABLED=true", async () => {
    const db = mkDb();
    seedOrg(db, "org_x");
    seedSource(db, { id: "src_stale", slug: "stale", orgId: "org_x", lastFetchedAt: STALE });

    await forceDrainSweep({
      DB: null as any,
      CRON_ENABLED: "false",
      FORCE_DRAIN_CRON_ENABLED: "true",
      _drizzleOverride: db,
    });

    const rows = db.select().from(cronRuns).all();
    expect(rows).toHaveLength(0);
  });
});
