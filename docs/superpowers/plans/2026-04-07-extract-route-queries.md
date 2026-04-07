# Extract Route Queries & Split Large Route Files

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Extract inline raw SQL from worker route files into shared query helpers, eliminating fragile table-alias patterns that cause bugs when mixed with Drizzle column refs.

**Architecture:** New `workers/api/src/queries/` directory holds D1-specific query helpers organized by domain (sources, orgs, search). Each exported function takes a `D1Db` instance and returns typed results. Route handlers become thin: validate input → call query → format response. Shared SQL fragments (suppression filter, hidden filter) live in a `shared.ts` module.

**Tech Stack:** Drizzle ORM (d1 driver), Hono route handlers, SQLite via Cloudflare D1

---

## File Structure

### New files

| File | Responsibility |
|------|---------------|
| `workers/api/src/queries/shared.ts` | Reusable SQL fragments: `notSuppressed`, `notDisabled` conditions; common row types |
| `workers/api/src/queries/sources.ts` | Query helpers for source list, source detail, source activity, release pagination |
| `workers/api/src/queries/orgs.ts` | Query helpers for org list, org detail, org activity, org release feed |
| `workers/api/src/queries/search.ts` | Query helpers for unified search (org/product/source/release FTS) |

### Modified files

| File | What changes |
|------|-------------|
| `workers/api/src/routes/sources.ts` | Replace inline SQL in GET /sources, GET /:slug, GET /:slug/activity with query helper calls |
| `workers/api/src/routes/orgs.ts` | Replace inline SQL in GET /orgs, GET /:slug, GET /:slug/activity, GET /:slug/releases with query helper calls |
| `workers/api/src/routes/search.ts` | Replace inline SQL in GET /search with query helper calls |

---

### Task 1: Create shared SQL fragments

**Files:**
- Create: `workers/api/src/queries/shared.ts`

- [ ] **Step 1: Create the shared module**

```typescript
import { sql } from "drizzle-orm";
import { sources, releases } from "@releases/db/schema.js";

/** Exclude hidden sources: (is_hidden = 0 OR is_hidden IS NULL) */
export const notDisabled = sql`(${sources.isHidden} = 0 OR ${sources.isHidden} IS NULL)`;

/** Exclude suppressed releases — for use in Drizzle WHERE clauses */
export const notSuppressed = sql`(${releases.suppressed} IS NULL OR ${releases.suppressed} = 0)`;

/** Exclude suppressed releases — for raw SQL using table alias `r` */
export const notSuppressedRaw = sql.raw(`(r.suppressed IS NULL OR r.suppressed = 0)`);

/** Common row type for source list items with release stats */
export type SourceWithStats = {
  id: string;
  slug: string;
  name: string;
  type: string;
  url: string;
  is_primary: number | null;
  release_count: number;
  latest_version_by_date: string | null;
  latest_date: string | null;
  latest_version_by_fetch: string | null;
  product_slug: string | null;
  product_name: string | null;
};

/** Common row type for org list items */
export type OrgListRow = {
  id: string;
  slug: string;
  name: string;
  domain: string | null;
  description: string | null;
  category: string | null;
  source_count: number;
  release_count: number;
  last_activity: string | null;
  recent_release_count: number;
};
```

- [ ] **Step 2: Commit**

```bash
git add workers/api/src/queries/shared.ts
git commit -m "refactor: add shared SQL fragments for route query extraction"
```

---

### Task 2: Extract source query helpers

**Files:**
- Create: `workers/api/src/queries/sources.ts`
- Modify: `workers/api/src/routes/sources.ts`

- [ ] **Step 1: Create source query helpers**

Create `workers/api/src/queries/sources.ts` with three query functions extracted from the route file. Each function takes a `D1Db` as first argument.

**`getSourcesWithStats`** — replaces the inline raw SQL at routes/sources.ts:103-132. Takes the already-built `whereClause` from Drizzle conditions and wraps the raw SQL query:

```typescript
import { sql, type SQL } from "drizzle-orm";
import type { D1Db } from "../db.js";
import { organizations, sources } from "@releases/db/schema.js";

export type SourceListRow = {
  id: string;
  slug: string;
  name: string;
  type: string;
  url: string;
  org_id: string | null;
  product_id: string | null;
  is_primary: number | null;
  is_hidden: number | null;
  metadata: string | null;
  last_fetched_at: string | null;
  fetch_priority: string | null;
  change_detected_at: string | null;
  org_slug: string | null;
  release_count: number;
  latest_version: string | null;
  latest_date: string | null;
};

export async function getSourcesWithStats(
  db: D1Db,
  whereClause?: SQL,
): Promise<SourceListRow[]> {
  return db.all<SourceListRow>(sql`
    SELECT
      sources.*,
      organizations.slug AS org_slug,
      (SELECT COUNT(*) FROM releases r WHERE r.source_id = sources.id AND (r.suppressed IS NULL OR r.suppressed = 0)) AS release_count,
      (SELECT r2.version FROM releases r2 WHERE r2.source_id = sources.id AND (r2.suppressed IS NULL OR r2.suppressed = 0) AND r2.published_at IS NOT NULL ORDER BY r2.published_at DESC LIMIT 1) AS latest_version,
      (SELECT r3.published_at FROM releases r3 WHERE r3.source_id = sources.id AND (r3.suppressed IS NULL OR r3.suppressed = 0) AND r3.published_at IS NOT NULL ORDER BY r3.published_at DESC LIMIT 1) AS latest_date
    FROM sources
    LEFT JOIN organizations ON organizations.id = sources.org_id
    ${whereClause ? sql`WHERE ${whereClause}` : sql``}
    ORDER BY sources.name
  `);
}
```

**`getSourceReleasesPaginated`** — replaces the inline raw SQL at routes/sources.ts:563-579:

```typescript
export type SourceReleaseRow = {
  id: string;
  version: string | null;
  title: string;
  content_summary: string | null;
  content: string;
  published_at: string | null;
  url: string | null;
  media: string | null;
};

export async function getSourceReleasesPaginated(
  db: D1Db,
  sourceId: string,
  pageSize: number,
  offset: number,
): Promise<SourceReleaseRow[]> {
  return db.all<SourceReleaseRow>(sql`
    SELECT id, version, title, content_summary, content, published_at, url, media
    FROM releases WHERE source_id = ${sourceId} AND (suppressed IS NULL OR suppressed = 0)
    ORDER BY
      CASE WHEN published_at IS NOT NULL THEN 0 ELSE 1 END,
      published_at DESC, fetched_at DESC
    LIMIT ${pageSize} OFFSET ${offset}
  `);
}
```

**`getSourceActivityBuckets`** — replaces the CTE query at routes/sources.ts:483-513:

```typescript
export type ActivityBucketRow = {
  week_start: string;
  cnt: number;
  earliest_version: string | null;
  latest_version: string | null;
};

export async function getSourceActivityBuckets(
  db: D1Db,
  sourceId: string,
  from: string,
  toExclusive: string,
): Promise<ActivityBucketRow[]> {
  return db.all<ActivityBucketRow>(sql`
    WITH bucketed AS (
      SELECT
        strftime('%Y-%m-%d', r.published_at, 'weekday 0', '-6 days') AS week_start,
        COUNT(*) AS cnt,
        MIN(CASE WHEN r.version IS NOT NULL THEN r.published_at || '|' || r.version END) AS earliest_tagged,
        MAX(CASE WHEN r.version IS NOT NULL THEN r.published_at || '|' || r.version END) AS latest_tagged
      FROM releases r
      WHERE
        r.source_id = ${sourceId}
        AND r.published_at IS NOT NULL
        AND (r.suppressed IS NULL OR r.suppressed = 0)
        AND r.published_at >= ${from}
        AND r.published_at < ${toExclusive}
      GROUP BY week_start
    )
    SELECT week_start, cnt,
      CASE WHEN earliest_tagged IS NOT NULL
        THEN SUBSTR(earliest_tagged, INSTR(earliest_tagged, '|') + 1)
        ELSE NULL END AS earliest_version,
      CASE WHEN latest_tagged IS NOT NULL
        THEN SUBSTR(latest_tagged, INSTR(latest_tagged, '|') + 1)
        ELSE NULL END AS latest_version
    FROM bucketed
    ORDER BY week_start
  `);
}
```

- [ ] **Step 2: Update routes/sources.ts GET /sources handler**

Replace the inline SQL at lines 103-132 with a call to `getSourcesWithStats`:

```typescript
// At top of file, add import:
import { getSourcesWithStats } from "../queries/sources.js";

// In the GET /sources handler, replace from line 103 to line 132:
// OLD:
//   const rows = await db.all<{...}>(sql`SELECT sources.*, ...`);
// NEW:
  const rows = await getSourcesWithStats(db, whereClause);
```

The rest of the handler (building `conditions`, mapping `rows` to `result`) stays unchanged.

- [ ] **Step 3: Update routes/sources.ts GET /sources/:slug handler**

Replace the inline release pagination SQL at lines 563-579 with `getSourceReleasesPaginated`:

```typescript
// Add to import:
import { getSourcesWithStats, getSourceReleasesPaginated } from "../queries/sources.js";

// In GET /sources/:slug handler, replace lines 563-579:
// OLD:
//   const releaseRows = await db.all<{...}>(sql`SELECT id, version, ...`);
// NEW:
  const releaseRows = await getSourceReleasesPaginated(db, src.id, pageSize, offset);
```

- [ ] **Step 4: Update routes/sources.ts GET /sources/:slug/activity handler**

Replace the CTE query at lines 483-513 with `getSourceActivityBuckets`:

```typescript
// Add to import:
import { getSourcesWithStats, getSourceReleasesPaginated, getSourceActivityBuckets } from "../queries/sources.js";

// In GET /sources/:slug/activity handler, replace lines 483-513:
// OLD:
//   const bucketRows = await db.all<{...}>(sql`WITH bucketed AS (...)`);
// NEW:
  const bucketRows = await getSourceActivityBuckets(db, src.id, from, toExclusive);
```

- [ ] **Step 5: Type-check**

Run: `npx tsc --noEmit`
Expected: No errors

- [ ] **Step 6: Commit**

```bash
git add workers/api/src/queries/sources.ts workers/api/src/routes/sources.ts
git commit -m "refactor: extract source route queries into shared helpers"
```

---

### Task 3: Extract org query helpers

**Files:**
- Create: `workers/api/src/queries/orgs.ts`
- Modify: `workers/api/src/routes/orgs.ts`

- [ ] **Step 1: Create org query helpers**

Create `workers/api/src/queries/orgs.ts` with four query functions.

**`getOrgsWithStats`** — replaces routes/orgs.ts:19-39:

```typescript
import { sql } from "drizzle-orm";
import type { D1Db } from "../db.js";
import type { OrgListRow } from "./shared.js";

export async function getOrgsWithStats(
  db: D1Db,
  cutoff30d: string,
): Promise<OrgListRow[]> {
  return db.all<OrgListRow>(sql`
    SELECT
      o.id, o.slug, o.name, o.domain, o.description, o.category,
      (SELECT COUNT(*) FROM sources s WHERE s.org_id = o.id) AS source_count,
      (SELECT COUNT(*) FROM releases r INNER JOIN sources s ON r.source_id = s.id WHERE s.org_id = o.id AND (r.suppressed IS NULL OR r.suppressed = 0)) AS release_count,
      (SELECT MAX(r.published_at) FROM releases r INNER JOIN sources s ON r.source_id = s.id WHERE s.org_id = o.id AND r.published_at IS NOT NULL) AS last_activity,
      (SELECT COUNT(*) FROM releases r INNER JOIN sources s ON r.source_id = s.id WHERE s.org_id = o.id AND r.published_at >= ${cutoff30d} AND (r.suppressed IS NULL OR r.suppressed = 0)) AS recent_release_count
    FROM organizations o
    ORDER BY o.name
  `);
}
```

**`getOrgSourcesWithStats`** — replaces routes/orgs.ts:87-112 (the sources subquery in org detail):

```typescript
import type { SourceWithStats } from "./shared.js";

export async function getOrgSourcesWithStats(
  db: D1Db,
  orgId: string,
): Promise<SourceWithStats[]> {
  return db.all<SourceWithStats>(sql`
    SELECT
      s.id, s.slug, s.name, s.type, s.url, s.is_primary,
      p.slug AS product_slug, p.name AS product_name,
      (SELECT COUNT(*) FROM releases r WHERE r.source_id = s.id AND (r.suppressed IS NULL OR r.suppressed = 0)) AS release_count,
      (SELECT r2.version FROM releases r2 WHERE r2.source_id = s.id AND r2.published_at IS NOT NULL AND (r2.suppressed IS NULL OR r2.suppressed = 0) ORDER BY r2.published_at DESC LIMIT 1) AS latest_version_by_date,
      (SELECT r3.published_at FROM releases r3 WHERE r3.source_id = s.id AND r3.published_at IS NOT NULL AND (r3.suppressed IS NULL OR r3.suppressed = 0) ORDER BY r3.published_at DESC LIMIT 1) AS latest_date,
      (SELECT r4.version FROM releases r4 WHERE r4.source_id = s.id AND (r4.suppressed IS NULL OR r4.suppressed = 0) ORDER BY r4.fetched_at DESC LIMIT 1) AS latest_version_by_fetch
    FROM sources s
    LEFT JOIN products p ON p.id = s.product_id
    WHERE s.org_id = ${orgId}
    ORDER BY s.name
  `);
}
```

**`getOrgActivityData`** — replaces the 4 parallel queries at routes/orgs.ts:473-569:

```typescript
export type OrgActivityBucketRow = {
  source_id: string;
  week_start: string;
  cnt: number;
  earliest_version: string | null;
  latest_version: string | null;
};

export type OrgSourceStatsRow = {
  source_id: string;
  total: number;
  oldest: string | null;
  latest_date: string | null;
};

export type SourceVersionRow = {
  source_id: string;
  version: string | null;
};

export async function getOrgActivityData(
  db: D1Db,
  orgId: string,
  sourceIds: string[],
  from: string,
  toExclusive: string,
): Promise<{
  bucketRows: OrgActivityBucketRow[];
  statsRows: OrgSourceStatsRow[];
  latestVersionRows: SourceVersionRow[];
  earliestVersionRows: SourceVersionRow[];
}> {
  const [bucketRows, statsRows, latestVersionRows, earliestVersionRows] = await Promise.all([
    db.all<OrgActivityBucketRow>(sql`
      WITH bucketed AS (
        SELECT
          s.id AS source_id,
          s.slug AS source_slug,
          strftime('%Y-%m-%d', r.published_at, 'weekday 0', '-6 days') AS week_start,
          COUNT(*) AS cnt,
          MIN(CASE WHEN r.version IS NOT NULL THEN r.published_at || '|' || r.version END) AS earliest_tagged,
          MAX(CASE WHEN r.version IS NOT NULL THEN r.published_at || '|' || r.version END) AS latest_tagged
        FROM releases r
        INNER JOIN sources s ON s.id = r.source_id
        WHERE
          s.org_id = ${orgId}
          AND r.published_at IS NOT NULL
          AND (r.suppressed IS NULL OR r.suppressed = 0)
          AND r.published_at >= ${from}
          AND r.published_at < ${toExclusive}
        GROUP BY s.id, week_start
      )
      SELECT source_id, week_start, cnt,
        CASE WHEN earliest_tagged IS NOT NULL
          THEN SUBSTR(earliest_tagged, INSTR(earliest_tagged, '|') + 1)
          ELSE NULL END AS earliest_version,
        CASE WHEN latest_tagged IS NOT NULL
          THEN SUBSTR(latest_tagged, INSTR(latest_tagged, '|') + 1)
          ELSE NULL END AS latest_version
      FROM bucketed
      ORDER BY source_slug, week_start
    `),

    db.all<OrgSourceStatsRow>(sql`
      SELECT
        s.id AS source_id,
        COUNT(*) AS total,
        MIN(r.published_at) AS oldest,
        MAX(r.published_at) AS latest_date
      FROM releases r
      INNER JOIN sources s ON s.id = r.source_id
      WHERE
        s.org_id = ${orgId}
        AND r.published_at IS NOT NULL
        AND (r.suppressed IS NULL OR r.suppressed = 0)
        AND r.published_at >= ${from}
        AND r.published_at < ${toExclusive}
      GROUP BY s.id
    `),

    db.all<SourceVersionRow>(sql`
      SELECT r.source_id, r.version
      FROM releases r
      INNER JOIN (
        SELECT source_id, MAX(published_at) AS max_date
        FROM releases
        WHERE source_id IN ${sourceIds}
          AND (suppressed IS NULL OR suppressed = 0)
          AND published_at IS NOT NULL
          AND published_at >= ${from}
          AND published_at < ${toExclusive}
        GROUP BY source_id
      ) latest ON r.source_id = latest.source_id AND r.published_at = latest.max_date
      WHERE (r.suppressed IS NULL OR r.suppressed = 0)
    `),

    db.all<SourceVersionRow>(sql`
      SELECT r.source_id, r.version
      FROM releases r
      INNER JOIN (
        SELECT source_id, MIN(published_at) AS min_date
        FROM releases
        WHERE source_id IN ${sourceIds}
          AND (suppressed IS NULL OR suppressed = 0)
          AND published_at IS NOT NULL
          AND published_at >= ${from}
          AND published_at < ${toExclusive}
        GROUP BY source_id
      ) earliest ON r.source_id = earliest.source_id AND r.published_at = earliest.min_date
      WHERE (r.suppressed IS NULL OR r.suppressed = 0)
    `),
  ]);

  return { bucketRows, statsRows, latestVersionRows, earliestVersionRows };
}
```

**`getOrgReleasesFeed`** — replaces the raw `.prepare()` query at routes/orgs.ts:673-688. This uses the D1 binding directly because it needs `stmt.bind()` for cursor-based pagination:

```typescript
export type OrgReleaseRow = {
  id: string;
  version: string | null;
  title: string;
  content: string;
  content_summary: string | null;
  published_at: string | null;
  url: string | null;
  media: string | null;
  source_slug: string;
  source_name: string;
  source_type: string;
};

export async function getOrgReleasesFeed(
  d1: D1Database,
  orgId: string,
  cursor: { cursorWhere: string; cursorBindings: string[] },
  limit: number,
): Promise<OrgReleaseRow[]> {
  const stmt = d1.prepare(`
    SELECT r.id, r.version, r.title, r.content, r.content_summary,
           r.published_at, r.fetched_at, r.url, r.media,
           s.slug AS source_slug, s.name AS source_name, s.type AS source_type
    FROM releases r
    INNER JOIN sources s ON s.id = r.source_id
    WHERE s.org_id = ?
      AND (r.suppressed IS NULL OR r.suppressed = 0)
      ${cursor.cursorWhere}
    ORDER BY
      CASE WHEN r.published_at IS NOT NULL THEN 0 ELSE 1 END,
      r.published_at DESC,
      r.fetched_at DESC,
      r.id DESC
    LIMIT ?
  `).bind(orgId, ...cursor.cursorBindings, limit);

  const { results } = await stmt.all<OrgReleaseRow>();
  return results;
}
```

- [ ] **Step 2: Update routes/orgs.ts GET /orgs handler**

Replace lines 19-39 with:

```typescript
// At top, add import:
import { getOrgsWithStats, getOrgSourcesWithStats, getOrgActivityData, getOrgReleasesFeed } from "../queries/orgs.js";

// In GET /orgs handler:
// OLD:
//   const rows = await db.all<{...}>(sql`SELECT o.id, o.slug, ...`);
// NEW:
  const rows = await getOrgsWithStats(db, cutoff30d);
```

- [ ] **Step 3: Update routes/orgs.ts GET /orgs/:slug handler**

Replace the `sourceRows` query in the Promise.all (lines 87-112) with:

```typescript
// In the Promise.all array, replace the db.all<{...}>(sql`...`) call with:
    getOrgSourcesWithStats(db, org.id),
```

Update the destructured variable name and downstream usage to match the `SourceWithStats` type. The field names (`release_count`, `latest_version_by_date`, etc.) are the same, so the existing mapping code at lines 136-148 works unchanged.

- [ ] **Step 4: Update routes/orgs.ts GET /orgs/:slug/activity handler**

Replace the 4 parallel queries at lines 473-569 with:

```typescript
  const { bucketRows, statsRows, latestVersionRows, earliestVersionRows } =
    await getOrgActivityData(db, org.id, sourceIds, from, toExclusive);
```

The rest of the handler (building maps, assembling response) stays unchanged.

- [ ] **Step 5: Update routes/orgs.ts GET /orgs/:slug/releases handler**

Replace the `.prepare()` query at lines 673-702 with:

```typescript
  const results = await getOrgReleasesFeed(c.env.DB, org.id, { cursorWhere, cursorBindings }, limit + 1);
```

The cursor parsing logic (lines 654-671) and response formatting (lines 704-743) stay in the route handler.

- [ ] **Step 6: Type-check**

Run: `npx tsc --noEmit`
Expected: No errors

- [ ] **Step 7: Commit**

```bash
git add workers/api/src/queries/orgs.ts workers/api/src/routes/orgs.ts
git commit -m "refactor: extract org route queries into shared helpers"
```

---

### Task 4: Extract search query helpers

**Files:**
- Create: `workers/api/src/queries/search.ts`
- Modify: `workers/api/src/routes/search.ts`

- [ ] **Step 1: Create search query helpers**

Create `workers/api/src/queries/search.ts`:

```typescript
import { sql } from "drizzle-orm";
import type { D1Db } from "../db.js";
import type {
  SearchOrgHit,
  SearchProductHit,
  SearchSourceHit,
  SearchReleaseHit,
} from "../../../../src/api/types.js";

export async function searchOrgs(db: D1Db, pattern: string, limit: number): Promise<SearchOrgHit[]> {
  return db.all<SearchOrgHit>(sql`
    SELECT DISTINCT o.slug, o.name, o.domain, NULL as avatarUrl, o.category
    FROM organizations o
    LEFT JOIN domain_aliases da ON da.org_id = o.id
    WHERE o.name LIKE ${pattern} OR o.slug LIKE ${pattern} OR o.domain LIKE ${pattern}
      OR da.domain LIKE ${pattern}
    ORDER BY o.name LIMIT ${limit}
  `);
}

export async function searchProducts(db: D1Db, pattern: string, limit: number): Promise<SearchProductHit[]> {
  return db.all<SearchProductHit>(sql`
    SELECT DISTINCT p.slug, p.name, o.slug as orgSlug, o.name as orgName, p.category
    FROM products p
    LEFT JOIN organizations o ON o.id = p.org_id
    LEFT JOIN domain_aliases da ON da.product_id = p.id
    WHERE p.name LIKE ${pattern} OR p.slug LIKE ${pattern} OR da.domain LIKE ${pattern}
    ORDER BY p.name LIMIT ${limit}
  `);
}

export async function searchSources(db: D1Db, pattern: string, limit: number): Promise<SearchSourceHit[]> {
  return db.all<SearchSourceHit>(sql`
    SELECT s.slug, s.name, s.type, o.slug as orgSlug, o.name as orgName,
           p.slug as productSlug
    FROM sources s
    LEFT JOIN organizations o ON o.id = s.org_id
    LEFT JOIN products p ON p.id = s.product_id
    WHERE (s.is_hidden = 0 OR s.is_hidden IS NULL)
      AND (s.name LIKE ${pattern} OR s.slug LIKE ${pattern} OR s.url LIKE ${pattern})
    ORDER BY s.name LIMIT ${limit}
  `);
}

export async function searchReleasesFts(
  db: D1Db,
  query: string,
  limit: number,
  offset: number,
): Promise<SearchReleaseHit[]> {
  return db.all<SearchReleaseHit>(sql`
    SELECT s.slug as sourceSlug, s.name as sourceName, o.slug as orgSlug,
           r.version, r.title,
           COALESCE(r.content_summary, SUBSTR(r.content, 1, 150)) as summary,
           r.published_at as publishedAt
    FROM releases_fts
    JOIN releases r ON r.rowid = releases_fts.rowid
    JOIN sources s ON s.id = r.source_id
    LEFT JOIN organizations o ON o.id = s.org_id
    WHERE releases_fts MATCH ${query}
      AND (r.suppressed IS NULL OR r.suppressed = 0)
      AND (s.is_hidden = 0 OR s.is_hidden IS NULL)
    ORDER BY rank LIMIT ${limit} OFFSET ${offset}
  `);
}

export async function searchReleasesFromMatchedEntities(
  db: D1Db,
  orgSlugs: string[],
  productSlugs: string[],
  limit: number,
): Promise<SearchReleaseHit[]> {
  const conditions = [];
  if (orgSlugs.length > 0) conditions.push(sql`o.slug IN (${sql.join(orgSlugs.map((s) => sql`${s}`), sql`, `)})`);
  if (productSlugs.length > 0) conditions.push(sql`p.slug IN (${sql.join(productSlugs.map((s) => sql`${s}`), sql`, `)})`);
  if (conditions.length === 0) return [];

  return db.all<SearchReleaseHit>(sql`
    SELECT s.slug as sourceSlug, s.name as sourceName, o.slug as orgSlug,
           r.version, r.title,
           COALESCE(r.content_summary, SUBSTR(r.content, 1, 150)) as summary,
           r.published_at as publishedAt
    FROM releases r
    JOIN sources s ON s.id = r.source_id
    LEFT JOIN organizations o ON o.id = s.org_id
    LEFT JOIN products p ON p.id = s.product_id
    WHERE (r.suppressed IS NULL OR r.suppressed = 0)
      AND (s.is_hidden = 0 OR s.is_hidden IS NULL)
      AND (${sql.join(conditions, sql` OR `)})
    ORDER BY r.published_at DESC LIMIT ${limit}
  `);
}
```

- [ ] **Step 2: Update routes/search.ts**

Replace the route handler body with calls to the query helpers:

```typescript
import {
  searchOrgs,
  searchProducts,
  searchSources,
  searchReleasesFts,
  searchReleasesFromMatchedEntities,
} from "../queries/search.js";

// In GET /search handler, replace lines 30-106 with:
  const [orgs, products, sources, ftsReleases] = await Promise.all([
    searchOrgs(db, pattern, limit),
    searchProducts(db, pattern, limit),
    searchSources(db, pattern, limit),
    searchReleasesFts(db, q, limit, offset).catch(() => [] as SearchReleaseHit[]),
  ]);

  let releases = ftsReleases;
  if (releases.length === 0 && (orgs.length > 0 || products.length > 0)) {
    releases = await searchReleasesFromMatchedEntities(
      db,
      orgs.map((o) => o.slug),
      products.map((p) => p.slug),
      limit,
    );
  }
```

Remove the now-unused `sql` import from drizzle-orm (it was only used for inline queries). Keep the remaining imports.

- [ ] **Step 3: Type-check**

Run: `npx tsc --noEmit`
Expected: No errors

- [ ] **Step 4: Commit**

```bash
git add workers/api/src/queries/search.ts workers/api/src/routes/search.ts
git commit -m "refactor: extract search route queries into shared helpers"
```

---

### Task 5: Clean up duplicate `notDisabled` definitions

**Files:**
- Modify: `workers/api/src/routes/sources.ts`

- [ ] **Step 1: Replace local `notDisabled` definitions in sources.ts**

The sources route file defines `notDisabled` locally in three places (lines 64-66, 164, 201). Import from `shared.ts` instead:

```typescript
// At top of file, add import:
import { notDisabled } from "../queries/shared.js";

// Remove the three inline definitions:
// Line 64-66: conditions.push(sql`(${sources.isHidden} = 0 OR ${sources.isHidden} IS NULL)`);
//   → conditions.push(notDisabled);
// Line 164: const notDisabled = sql`(${sources.isHidden} = 0 OR ${sources.isHidden} IS NULL)`;
//   → Remove this line, use imported notDisabled
// Line 201: const notDisabled = sql`(${sources.isHidden} = 0 OR ${sources.isHidden} IS NULL)`;
//   → Remove this line, use imported notDisabled
```

- [ ] **Step 2: Type-check**

Run: `npx tsc --noEmit`
Expected: No errors

- [ ] **Step 3: Commit**

```bash
git add workers/api/src/routes/sources.ts
git commit -m "refactor: deduplicate notDisabled SQL fragment in source routes"
```

---

### Task 6: Verify end-to-end

- [ ] **Step 1: Type-check the full project**

Run: `npx tsc --noEmit`
Expected: No errors

- [ ] **Step 2: Run existing tests**

Run: `bun test`
Expected: All tests pass (confirms no regressions in shared code)

- [ ] **Step 3: Smoke test against live API**

Run these CLI commands to verify the refactored queries return correct data:

```bash
bun src/index.ts list --json | head -20
bun src/index.ts list --query anthropic --json
bun src/index.ts list claude-code --json
bun src/index.ts stats --json
```

Expected: JSON output matches pre-refactor behavior. Source counts, latest versions, and dates should all be populated.

- [ ] **Step 4: Commit any final fixes if needed**

---

## Notes

- **No file splitting needed yet.** After query extraction, `sources.ts` drops from ~920 lines to ~700 (mostly CRUD handlers that are already clean). `orgs.ts` drops from ~770 to ~500. Both are manageable. If a future feature adds complexity, split then.
- **`notSuppressedRaw` in shared.ts** is there for future use but not consumed in this refactor. The raw SQL queries use inline `(r.suppressed IS NULL OR r.suppressed = 0)` because they reference the `r` alias. This is intentional — the shared fragment works for Drizzle WHERE clauses, not arbitrary raw SQL aliases.
- **The `getOrgReleasesFeed` function takes `D1Database`** (not `D1Db`) because it uses `.prepare().bind()` which is a D1 native API, not Drizzle. The caller passes `c.env.DB` directly.
