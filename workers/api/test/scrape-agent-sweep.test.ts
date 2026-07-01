import { describe, it, expect } from "bun:test";
import { Database } from "bun:sqlite";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { applyMigrations } from "../../../tests/db-helper";
import { organizations, sources } from "@buildinternet/releases-core/schema";
import { queryCandidates, scrapeAgentSweep } from "../src/cron/scrape-agent-sweep";

/**
 * `queryCandidates` selects the flagged scrape/agent sources the sweep drains.
 *
 * Two starvation-prevention invariants (see the sweep-starvation incident,
 * 2026-05-31): candidates are ordered by `last_fetched_at ASC` (the source we've
 * gone longest WITHOUT actually fetching wins, never-fetched first), NOT by
 * `change_detected_at` — a page whose validator flaps on every poll keeps
 * re-stamping `change_detected_at = now` and would otherwise sort to the back of
 * the queue forever under a binding cap. And Firecrawl-owned sources are
 * excluded (they're fetched by their monitor, mirroring the poll cron).
 */

function mkDb() {
  const sqlite = new Database(":memory:");
  const db = drizzle(sqlite);
  applyMigrations(sqlite);
  return db;
}

function seedOrg(db: ReturnType<typeof mkDb>, id: string) {
  db.insert(organizations).values({ id, name: id, slug: id }).run();
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
      // The sweep only considers flagged sources; default every fixture flagged.
      changeDetectedAt: opts.changeDetectedAt ?? "2026-05-31T12:00:00.000Z",
    } as any)
    .run();
}

const OLD = "2026-05-01T00:00:00.000Z";
const RECENT = "2026-05-30T00:00:00.000Z";

describe("queryCandidates ordering", () => {
  it("orders by last_fetched_at ascending — most stale first, never-fetched first", async () => {
    const db = mkDb();
    seedOrg(db, "org_x");
    seedSource(db, { id: "src_recent", slug: "recent", orgId: "org_x", lastFetchedAt: RECENT });
    seedSource(db, { id: "src_old", slug: "old", orgId: "org_x", lastFetchedAt: OLD });
    seedSource(db, { id: "src_never", slug: "never", orgId: "org_x", lastFetchedAt: null });

    const { rows } = await queryCandidates(db as any, { cap: 10 });
    expect(rows.map((r) => r.slug)).toEqual(["never", "old", "recent"]);
  });

  it("keeps the most-stale sources under a binding cap (does not keep the freshest)", async () => {
    const db = mkDb();
    seedOrg(db, "org_x");
    seedSource(db, { id: "src_recent", slug: "recent", orgId: "org_x", lastFetchedAt: RECENT });
    seedSource(db, { id: "src_old", slug: "old", orgId: "org_x", lastFetchedAt: OLD });
    seedSource(db, { id: "src_never", slug: "never", orgId: "org_x", lastFetchedAt: null });

    const { rows, skippedOverCap } = await queryCandidates(db as any, { cap: 2 });
    expect(rows.map((r) => r.slug)).toEqual(["never", "old"]);
    expect(skippedOverCap).toBe(1);
  });
});

describe("queryCandidates firecrawl exclusion", () => {
  it("excludes sources whose monitor is owned by Firecrawl", async () => {
    const db = mkDb();
    seedOrg(db, "org_x");
    seedSource(db, { id: "src_normal", slug: "normal", orgId: "org_x", lastFetchedAt: OLD });
    seedSource(db, {
      id: "src_fc",
      slug: "firecrawl-owned",
      orgId: "org_x",
      lastFetchedAt: OLD,
      metadata: { firecrawl: { enabled: true, monitorId: "mon_1" } },
    });

    const { rows } = await queryCandidates(db as any, { cap: 10 });
    expect(rows.map((r) => r.slug)).toEqual(["normal"]);
  });
});

describe("scrapeAgentSweep supersession", () => {
  it("early-returns without querying when superseded by the OrgActor", async () => {
    const db = mkDb();
    seedOrg(db, "org_x");
    seedSource(db, { id: "src_x", slug: "src-x", orgId: "org_x" }); // flagged by default — would normally be a candidate
    let dispatched = 0;
    await scrapeAgentSweep({
      DB: {} as D1Database,
      _drizzleOverride: db,
      SCRAPE_AGENT_CRON_ENABLED: "true",
      supersededByActor: true,
      DISCOVERY_WORKER: {
        fetch: async () => {
          dispatched++;
          return new Response("{}");
        },
      } as any,
      RELEASES_API_KEY: "k",
    } as any);
    expect(dispatched).toBe(0);
  });
});
