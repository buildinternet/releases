/**
 * GraphQL spike — proves the schema serves nested queries and that DataLoader
 * keeps relation fetches at one round-trip per layer regardless of fan-out.
 *
 * The N+1 assertion is the whole point of the spike: a query like
 * `orgs { products { sources { releases } } }` should issue 4 SELECTs (one per
 * layer) — not 4 + N_orgs + N_products + N_sources.
 */
import { describe, it, expect, beforeEach } from "bun:test";
import { Database } from "bun:sqlite";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { applyMigrations } from "../../../tests/db-helper";
import { organizations, products, releases, sources } from "@buildinternet/releases-core/schema";
import { releaseCoverage } from "../../../src/db/schema-coverage";
import { graphql } from "graphql";
import { schema } from "../src/graphql/schema.js";
import { createLoaders } from "../src/graphql/loaders.js";
import type { GraphQLContext } from "../src/graphql/builder.js";

type Db = ReturnType<typeof drizzle>;

function mkDb(): { db: Db; sqlite: Database; queryCount: () => number; reset: () => void } {
  const sqlite = new Database(":memory:");
  applyMigrations(sqlite);

  // Spy on every prepared SELECT — bun:sqlite's `Database.prepare` is the
  // single chokepoint drizzle uses, so wrapping it is enough.
  let count = 0;
  const origPrepare = sqlite.prepare.bind(sqlite);
  sqlite.prepare = ((sql: string) => {
    if (/^\s*select/i.test(sql)) count++;
    return origPrepare(sql);
  }) as typeof sqlite.prepare;

  const db = drizzle(sqlite);
  return {
    db,
    sqlite,
    queryCount: () => count,
    reset: () => {
      count = 0;
    },
  };
}

function ctx(db: Db): GraphQLContext {
  // Cast: workers expect D1Db but DataLoaders only need .select(); the test
  // drizzle handle satisfies the runtime shape.
  const d1Like = db as unknown as Parameters<typeof createLoaders>[0];
  return {
    db: d1Like,
    loaders: createLoaders(d1Like),
    isAdmin: false,
    mediaOrigin: "https://media.test",
  };
}

async function seed(db: Db) {
  const orgRows = [
    { id: "org_a", name: "Acme", slug: "acme" },
    { id: "org_b", name: "Beta", slug: "beta" },
  ];
  await db.insert(organizations).values(orgRows);

  await db.insert(products).values([
    { id: "prod_a1", name: "A1", slug: "a1", orgId: "org_a" },
    { id: "prod_a2", name: "A2", slug: "a2", orgId: "org_a" },
    { id: "prod_b1", name: "B1", slug: "b1", orgId: "org_b" },
  ]);

  await db.insert(sources).values([
    {
      id: "src_a1_1",
      name: "A1-1",
      slug: "a1-1",
      type: "github",
      url: "https://github.com/acme/a1",
      orgId: "org_a",
      productId: "prod_a1",
    },
    {
      id: "src_a2_1",
      name: "A2-1",
      slug: "a2-1",
      type: "github",
      url: "https://github.com/acme/a2",
      orgId: "org_a",
      productId: "prod_a2",
    },
    {
      id: "src_b1_1",
      name: "B1-1",
      slug: "b1-1",
      type: "feed",
      url: "https://beta.test/feed",
      orgId: "org_b",
      productId: "prod_b1",
    },
  ]);

  // 5 releases per source, descending publishedAt so ORDER BY DESC is observable.
  const releaseRows: Array<typeof releases.$inferInsert> = [];
  for (const src of ["src_a1_1", "src_a2_1", "src_b1_1"]) {
    for (let i = 0; i < 5; i++) {
      releaseRows.push({
        id: `rel_${src}_${i}`,
        sourceId: src,
        title: `${src} v${i}`,
        content: `body ${i}`,
        url: `https://example.com/${src}/${i}`,
        publishedAt: `2026-04-${String(20 - i).padStart(2, "0")}T00:00:00Z`,
      });
    }
  }
  await db.insert(releases).values(releaseRows);
}

describe("GraphQL spike", () => {
  let h: ReturnType<typeof mkDb>;

  beforeEach(async () => {
    h = mkDb();
    await seed(h.db);
    h.reset();
  });

  it("resolves a single org by slug", async () => {
    const result = await graphql({
      schema,
      source: `query { org(idOrSlug: "acme") { id name slug } }`,
      contextValue: ctx(h.db),
    });
    expect(result.errors).toBeUndefined();
    expect(result.data?.org).toEqual({ id: "org_a", name: "Acme", slug: "acme" });
  });

  it("resolves a deeply nested query in O(layers) SELECTs, not O(rows)", async () => {
    const query = `
      query {
        orgs(limit: 10) {
          items {
            id
            slug
            products {
              id
              sources {
                id
                releases(limit: 3) { id title }
              }
            }
          }
          pagination { page pageSize returned totalItems totalPages hasMore }
        }
      }
    `;
    const result = await graphql({ schema, source: query, contextValue: ctx(h.db) });
    expect(result.errors).toBeUndefined();
    const conn = (
      result.data as {
        orgs: {
          items: Array<{
            id: string;
            products: Array<{ sources: Array<{ releases: Array<{ id: string }> }> }>;
          }>;
          pagination: {
            page: number;
            pageSize: number;
            returned: number;
            totalItems: number;
            totalPages: number;
            hasMore: boolean;
          };
        };
      }
    ).orgs;
    expect(conn.items).toHaveLength(2);
    expect(conn.pagination).toMatchObject({
      page: 1,
      pageSize: 10,
      returned: 2,
      totalItems: 2,
      totalPages: 1,
      hasMore: false,
    });
    const flatReleases = conn.items.flatMap((o) =>
      o.products.flatMap((p) => p.sources.flatMap((s) => s.releases)),
    );
    // 3 sources × 3 releases each = 9. Confirms the per-source limit applied.
    expect(flatReleases).toHaveLength(9);

    // The whole point: layers, not row-fanout. Expected SELECTs:
    //   1. orgs root + count (parallelised — counts as one wave; tally allows up to 6)
    //   2. products by orgId (batched across both orgs)
    //   3. sources by productId (batched across all 3 products)
    //   4. releases by sourceId (batched across all 3 sources)
    // Anything > 6 means a relation fired one query per parent row.
    expect(h.queryCount()).toBeLessThanOrEqual(6);
  });

  it("only fetches `content` when the query selects it", async () => {
    // Field-selection win: omitting `content` from the selection set means
    // the resolver returns the column from the cached row but the client
    // never serialises it. (Drizzle still pulls the column in SELECT *; the
    // wire-size win is on the response, which is what the web app actually
    // pays for.) Verify the response shape excludes the field.
    const result = await graphql({
      schema,
      source: `query { release(idOrUrl: "rel_src_a1_1_0") { id title } }`,
      contextValue: ctx(h.db),
    });
    expect(result.errors).toBeUndefined();
    expect(result.data?.release).toEqual({ id: "rel_src_a1_1_0", title: "src_a1_1 v0" });
    expect(result.data?.release).not.toHaveProperty("content");
  });

  it("hides coverage-side releases (matches REST's releases_visible)", async () => {
    // Mark rel_src_a1_1_0 as covered by rel_src_a1_1_1. The view excludes it
    // from every read path; GraphQL must too, otherwise it's a loophole vs.
    // REST's `/v1/releases/:id` and `/v1/releases/latest`.
    await h.db.insert(releaseCoverage).values({
      coverageId: "rel_src_a1_1_0",
      canonicalId: "rel_src_a1_1_1",
      decidedBy: "test",
    });

    const direct = await graphql({
      schema,
      source: `query { release(idOrUrl: "rel_src_a1_1_0") { id } }`,
      contextValue: ctx(h.db),
    });
    expect(direct.errors).toBeUndefined();
    expect(direct.data?.release).toBeNull();

    const latest = await graphql({
      schema,
      source: `query { latestReleases(limit: 100) { items { id } nextCursor } }`,
      contextValue: ctx(h.db),
    });
    expect(latest.errors).toBeUndefined();
    const latestRows = (latest.data as { latestReleases: { items: Array<{ id: string }> } })
      .latestReleases.items;
    expect(latestRows.map((r) => r.id)).not.toContain("rel_src_a1_1_0");

    const nested = await graphql({
      schema,
      source: `query { source(id: "src_a1_1") { releases(limit: 50) { id } } }`,
      contextValue: ctx(h.db),
    });
    expect(nested.errors).toBeUndefined();
    const nestedSource = (nested.data as { source: { releases: Array<{ id: string }> } }).source;
    expect(nestedSource.releases.map((r) => r.id)).not.toContain("rel_src_a1_1_0");
  });

  it("latestReleases scopes correctly when filtered by org slug", async () => {
    const result = await graphql({
      schema,
      source: `query { latestReleases(orgIdOrSlug: "beta", limit: 10) { items { id } nextCursor } }`,
      contextValue: ctx(h.db),
    });
    expect(result.errors).toBeUndefined();
    const feed = (
      result.data as { latestReleases: { items: Array<{ id: string }>; nextCursor: string | null } }
    ).latestReleases;
    expect(feed.items).toHaveLength(5);
    expect(feed.items.every((r) => r.id.startsWith("rel_src_b1_1"))).toBe(true);
    expect(feed.nextCursor).toBeNull();
  });

  it("latestReleases paginates via opaque cursor without overlap", async () => {
    // 15 visible releases across 3 sources. Page size 6 → 6, 6, 3.
    const query = `
      query Page($cursor: String) {
        latestReleases(limit: 6, cursor: $cursor) { items { id } nextCursor }
      }
    `;
    const collected: string[] = [];
    let cursor: string | null = null;
    for (let i = 0; i < 5; i++) {
      // oxlint-disable-next-line no-await-in-loop -- each page depends on the previous cursor
      const r = await graphql({
        schema,
        source: query,
        variableValues: { cursor },
        contextValue: ctx(h.db),
      });
      expect(r.errors).toBeUndefined();
      const feed = (
        r.data as { latestReleases: { items: Array<{ id: string }>; nextCursor: string | null } }
      ).latestReleases;
      for (const row of feed.items) collected.push(row.id);
      if (!feed.nextCursor) break;
      cursor = feed.nextCursor;
    }
    expect(collected).toHaveLength(15);
    expect(new Set(collected).size).toBe(15);
  });

  it("cursor walk reaches releases with NULL publishedAt", async () => {
    // SQLite default sorts NULL last in DESC order. After paginating past all
    // dated rows, the cursor predicate must still reach NULL-published rows —
    // `lt(NULL, c.publishedAt)` is NULL not true, so without an explicit
    // isNull branch they'd be unreachable.
    await h.db.insert(releases).values({
      id: "rel_undated_1",
      sourceId: "src_a1_1",
      title: "undated entry",
      content: "no publish date",
      url: "https://example.com/undated/1",
      publishedAt: null,
    });

    const query = `
      query Page($cursor: String) {
        latestReleases(limit: 8, cursor: $cursor) { items { id publishedAt } nextCursor }
      }
    `;
    const collected: string[] = [];
    let cursor: string | null = null;
    for (let i = 0; i < 5; i++) {
      // oxlint-disable-next-line no-await-in-loop -- each page depends on the previous cursor
      const r = await graphql({
        schema,
        source: query,
        variableValues: { cursor },
        contextValue: ctx(h.db),
      });
      expect(r.errors).toBeUndefined();
      const feed = (
        r.data as {
          latestReleases: {
            items: Array<{ id: string; publishedAt: string | null }>;
            nextCursor: string | null;
          };
        }
      ).latestReleases;
      for (const row of feed.items) collected.push(row.id);
      if (!feed.nextCursor) break;
      cursor = feed.nextCursor;
    }
    expect(collected).toContain("rel_undated_1");
  });

  it("latestReleases drops sources whose type is in excludeSourceTypes", async () => {
    const result = await graphql({
      schema,
      source: `query {
        latestReleases(limit: 50, excludeSourceTypes: [github]) {
          items { id source { type } }
          nextCursor
        }
      }`,
      contextValue: ctx(h.db),
    });
    expect(result.errors).toBeUndefined();
    const feed = (
      result.data as {
        latestReleases: {
          items: Array<{ id: string; source: { type: string } }>;
          nextCursor: string | null;
        };
      }
    ).latestReleases;
    expect(feed.items).toHaveLength(5);
    expect(feed.items.every((r) => r.source.type === "feed")).toBe(true);
  });

  it("latestReleases drops releases dated in the future", async () => {
    // Sources occasionally publish a misdated entry (typo, scheduled-post slip);
    // without the guardrail it would sit at the top of the feed until the date
    // arrives. Seed one row dated a year out — it must not appear.
    await h.db.insert(releases).values({
      id: "rel_future_1",
      sourceId: "src_a1_1",
      title: "from the future",
      content: "should be hidden",
      url: "https://example.com/future/1",
      publishedAt: new Date(Date.now() + 365 * 24 * 60 * 60 * 1000).toISOString(),
    });

    const result = await graphql({
      schema,
      source: `query { latestReleases(limit: 100) { items { id } } }`,
      contextValue: ctx(h.db),
    });
    expect(result.errors).toBeUndefined();
    const ids = (
      result.data as { latestReleases: { items: Array<{ id: string }> } }
    ).latestReleases.items.map((r) => r.id);
    expect(ids).not.toContain("rel_future_1");
  });

  it("latestReleases rejects unknown source types in excludeSourceTypes", async () => {
    // Validation now lives at the schema layer — graphql-js coerces enum
    // values during parsing and rejects unknowns before the resolver runs.
    const r = await graphql({
      schema,
      source: `query { latestReleases(excludeSourceTypes: [nope]) { items { id } } }`,
      contextValue: ctx(h.db),
    });
    expect(r.errors).toBeDefined();
    expect(r.errors?.[0].message).toMatch(/SourceType/i);
  });

  it("Release.media parses JSON and resolves r2Url against the context origin", async () => {
    await h.db.insert(releases).values({
      id: "rel_with_media",
      sourceId: "src_a1_1",
      title: "media-bearing release",
      content: "screenshots inside",
      url: "https://example.com/media/1",
      publishedAt: "2026-04-25T00:00:00Z",
      media: JSON.stringify([
        { type: "image", url: "https://cdn.example/a.png", alt: "a", r2Key: "media/a.png" },
        { type: "image", url: "https://cdn.example/b.png" },
      ]),
    });

    const result = await graphql({
      schema,
      source: `query {
        release(idOrUrl: "rel_with_media") {
          media { type url alt r2Url }
        }
      }`,
      contextValue: ctx(h.db),
    });
    expect(result.errors).toBeUndefined();
    const media = (
      result.data as {
        release: {
          media: Array<{ type: string; url: string; alt: string | null; r2Url: string | null }>;
        };
      }
    ).release.media;
    expect(media).toHaveLength(2);
    expect(media[0]).toEqual({
      type: "image",
      url: "https://cdn.example/a.png",
      alt: "a",
      r2Url: "https://media.test/media/a.png",
    });
    // Second item has no r2Key → r2Url is null/undefined depending on resolver
    // (the helper omits the field when there's nothing to resolve).
    expect(media[1].r2Url ?? null).toBeNull();
  });

  it("Source.releases gives every batched source its own slice (no starvation)", async () => {
    // Regression for #757: the loader used to fetch `chunk.length * 50` rows
    // ordered globally by published_at, then split in memory. A source with
    // many recent releases would consume the whole window and shorter ones
    // batched alongside it returned []. The window-function path partitions
    // per source, so each gets up to 50 regardless of neighbors.
    const tallExtras: Array<typeof releases.$inferInsert> = [];
    for (let i = 0; i < 100; i++) {
      // Dated AFTER the seeded releases (2026-04-20 and earlier) so they sort
      // ahead under DESC and would crowd out the shorter source.
      tallExtras.push({
        id: `rel_tall_${i}`,
        sourceId: "src_a1_1",
        title: `tall ${i}`,
        content: `body ${i}`,
        url: `https://example.com/tall/${i}`,
        // ms-distinct timestamps so DESC ordering is deterministic.
        publishedAt: new Date(Date.UTC(2026, 4, 1) + i * 1000).toISOString(),
      });
    }
    await h.db.insert(releases).values(tallExtras);

    const result = await graphql({
      schema,
      // Both sources resolve in the SAME GraphQL request → DataLoader batches
      // them into one window-function query with `source_id IN (?, ?)`.
      source: `query {
        tall: source(id: "src_a1_1") { releases(limit: 50) { id } }
        short: source(id: "src_a2_1") { releases(limit: 50) { id } }
      }`,
      contextValue: ctx(h.db),
    });
    expect(result.errors).toBeUndefined();
    const data = result.data as {
      tall: { releases: Array<{ id: string }> };
      short: { releases: Array<{ id: string }> };
    };
    // Tall source caps at the loader ceiling (50); short source returns its 5
    // even though all 5 are older than every release on the tall source.
    expect(data.tall.releases).toHaveLength(50);
    expect(data.short.releases).toHaveLength(5);
    expect(data.short.releases.every((r) => r.id.startsWith("rel_src_a2_1"))).toBe(true);
  });

  it("rejects malformed cursors with a BAD_USER_INPUT error", async () => {
    const r = await graphql({
      schema,
      source: `query { latestReleases(cursor: "not-a-real-cursor!!!") { items { id } } }`,
      contextValue: ctx(h.db),
    });
    expect(r.errors).toBeDefined();
    expect(r.errors?.[0].extensions?.code).toBe("BAD_USER_INPUT");
  });
});
