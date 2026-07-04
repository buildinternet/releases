import { describe, it, expect } from "bun:test";
import { Database } from "bun:sqlite";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { applyMigrations } from "../db-helper";
import { sources, organizations } from "@buildinternet/releases-core/schema";
import { queryCandidates } from "../../workers/api/src/lib/drain-candidates";

function seed() {
  const sqlite = new Database(":memory:");
  const db = drizzle(sqlite);
  applyMigrations(sqlite);

  db.insert(organizations)
    .values([
      { id: "org_a", name: "Org A", slug: "a", category: "developer-tools" },
      { id: "org_b", name: "Org B", slug: "b", category: "developer-tools" },
    ])
    .run();

  db.insert(sources)
    .values([
      // Eligible: scrape, flagged, no feedUrl, not paused, not hidden
      {
        id: "src_1",
        name: "S1",
        slug: "s-1",
        type: "scrape",
        url: "https://a.com/changelog",
        orgId: "org_a",
        changeDetectedAt: "2026-04-18T00:00:00Z",
        metadata: JSON.stringify({ noFeedFound: true }),
      },
      {
        id: "src_2",
        name: "S2",
        slug: "s-2",
        type: "scrape",
        url: "https://b.com/changelog",
        orgId: "org_b",
        changeDetectedAt: "2026-04-17T00:00:00Z",
        metadata: "{}",
      },
      // Ineligible: has feedUrl
      {
        id: "src_3",
        name: "S3",
        slug: "s-3",
        type: "scrape",
        url: "https://a.com/releases",
        orgId: "org_a",
        changeDetectedAt: "2026-04-18T00:00:00Z",
        metadata: JSON.stringify({ feedUrl: "https://a.com/rss.xml", feedType: "rss" }),
      },
      // Ineligible: paused
      {
        id: "src_4",
        name: "S4",
        slug: "s-4",
        type: "scrape",
        url: "https://a.com/notes",
        orgId: "org_a",
        changeDetectedAt: "2026-04-18T00:00:00Z",
        fetchPriority: "paused",
        metadata: "{}",
      },
      // Ineligible: not flagged
      {
        id: "src_5",
        name: "S5",
        slug: "s-5",
        type: "scrape",
        url: "https://a.com/news",
        orgId: "org_a",
        changeDetectedAt: null,
        metadata: "{}",
      },
      // Ineligible: github type
      {
        id: "src_6",
        name: "S6",
        slug: "s-6",
        type: "github",
        url: "https://github.com/a/b",
        orgId: "org_a",
        changeDetectedAt: "2026-04-18T00:00:00Z",
        metadata: "{}",
      },
      // Ineligible: hidden
      {
        id: "src_7",
        name: "S7",
        slug: "s-7",
        type: "scrape",
        url: "https://a.com/hidden",
        orgId: "org_a",
        changeDetectedAt: "2026-04-18T00:00:00Z",
        isHidden: true,
        metadata: "{}",
      },
    ])
    .run();

  return db;
}

describe("queryCandidates", () => {
  it("returns only eligible rows, ordered by changeDetectedAt ASC, under the cap", async () => {
    const db = seed();
    const result = await queryCandidates(db, { cap: 10 });
    // src_2 has changeDetectedAt 2026-04-17 (older) → comes first under ASC
    expect(result.rows.map((r) => r.id)).toEqual(["src_2", "src_1"]);
    expect(result.skippedOverCap).toBe(0);
  });

  it("slices to cap and sets skippedOverCap when more than cap matched", async () => {
    const db = seed();
    const result = await queryCandidates(db, { cap: 1 });
    expect(result.rows.length).toBe(1);
    expect(result.rows[0].id).toBe("src_2"); // oldest flagged first under ASC
    expect(result.skippedOverCap).toBe(1);
  });

  it("returns empty when nothing is flagged", async () => {
    const sqlite = new Database(":memory:");
    const db = drizzle(sqlite);
    applyMigrations(sqlite);
    const result = await queryCandidates(db, { cap: 10 });
    expect(result.rows).toEqual([]);
    expect(result.skippedOverCap).toBe(0);
  });
});

/**
 * Two starvation-prevention invariants (see the sweep-starvation incident,
 * 2026-05-31): candidates are ordered by `last_fetched_at ASC` (the source we've
 * gone longest WITHOUT actually fetching wins, never-fetched first), NOT by
 * `change_detected_at` — a page whose validator flaps on every poll keeps
 * re-stamping `change_detected_at = now` and would otherwise sort to the back of
 * the queue forever under a binding cap. And Firecrawl-owned sources are
 * excluded (they're fetched by their monitor, mirroring the poll cron).
 */

function mkOrderingDb() {
  const sqlite = new Database(":memory:");
  const db = drizzle(sqlite);
  applyMigrations(sqlite);
  return db;
}

function seedOrderingOrg(db: ReturnType<typeof mkOrderingDb>, id: string) {
  db.insert(organizations).values({ id, name: id, slug: id }).run();
}

function seedOrderingSource(
  db: ReturnType<typeof mkOrderingDb>,
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
      // Drain candidates must be flagged; default every fixture to flagged.
      changeDetectedAt: opts.changeDetectedAt ?? "2026-05-31T12:00:00.000Z",
    } as any)
    .run();
}

const OLD = "2026-05-01T00:00:00.000Z";
const RECENT = "2026-05-30T00:00:00.000Z";

describe("queryCandidates ordering", () => {
  it("orders by last_fetched_at ascending — most stale first, never-fetched first", async () => {
    const db = mkOrderingDb();
    seedOrderingOrg(db, "org_x");
    seedOrderingSource(db, {
      id: "src_recent",
      slug: "recent",
      orgId: "org_x",
      lastFetchedAt: RECENT,
    });
    seedOrderingSource(db, {
      id: "src_old",
      slug: "old",
      orgId: "org_x",
      lastFetchedAt: OLD,
    });
    seedOrderingSource(db, {
      id: "src_never",
      slug: "never",
      orgId: "org_x",
      lastFetchedAt: null,
    });

    const { rows } = await queryCandidates(db as any, { cap: 10 });
    expect(rows.map((r) => r.slug)).toEqual(["never", "old", "recent"]);
  });

  it("keeps the most-stale sources under a binding cap (does not keep the freshest)", async () => {
    const db = mkOrderingDb();
    seedOrderingOrg(db, "org_x");
    seedOrderingSource(db, {
      id: "src_recent",
      slug: "recent",
      orgId: "org_x",
      lastFetchedAt: RECENT,
    });
    seedOrderingSource(db, {
      id: "src_old",
      slug: "old",
      orgId: "org_x",
      lastFetchedAt: OLD,
    });
    seedOrderingSource(db, {
      id: "src_never",
      slug: "never",
      orgId: "org_x",
      lastFetchedAt: null,
    });

    const { rows, skippedOverCap } = await queryCandidates(db as any, { cap: 2 });
    expect(rows.map((r) => r.slug)).toEqual(["never", "old"]);
    expect(skippedOverCap).toBe(1);
  });
});

describe("queryCandidates firecrawl exclusion", () => {
  it("excludes sources whose monitor is owned by Firecrawl", async () => {
    const db = mkOrderingDb();
    seedOrderingOrg(db, "org_x");
    seedOrderingSource(db, {
      id: "src_normal",
      slug: "normal",
      orgId: "org_x",
      lastFetchedAt: OLD,
    });
    seedOrderingSource(db, {
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
