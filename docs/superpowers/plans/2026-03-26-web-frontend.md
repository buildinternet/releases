# Web Frontend Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a read-only JSON API to the CLI and a Next.js frontend for browsing orgs, sources, and releases at releases.sh.

**Architecture:** Two components — (1) a new `api` CLI command that starts a Bun HTTP server with read-only endpoints against the existing SQLite DB, and (2) a Next.js 15 app in `web/` that fetches from that API using Server Components. The API provides 6 endpoints: stats, orgs list, org detail, sources list, source detail, and search.

**Tech Stack:** Bun HTTP server (API), Next.js 15 + App Router + Tailwind CSS (frontend), existing Drizzle ORM + SQLite (data layer)

**Spec:** `docs/superpowers/specs/2026-03-26-web-frontend-design.md`

---

## File Structure

### API (in existing CLI)

| File                        | Purpose                                                      |
| --------------------------- | ------------------------------------------------------------ |
| `src/api/server.ts`         | Bun HTTP server: routing, CORS, error handling               |
| `src/api/routes/stats.ts`   | `GET /api/stats` handler                                     |
| `src/api/routes/orgs.ts`    | `GET /api/orgs` and `GET /api/orgs/:slug` handlers           |
| `src/api/routes/sources.ts` | `GET /api/sources` and `GET /api/sources/:slug` handlers     |
| `src/api/routes/search.ts`  | `GET /api/search` handler                                    |
| `src/api/metrics.ts`        | Shared activity metrics computation (last 30 days, avg/week) |
| `src/cli/commands/api.ts`   | Commander registration for `api` command                     |
| `src/db/queries.ts`         | New query helpers added to existing file                     |

### Frontend (new `web/` directory)

| File                                          | Purpose                                                |
| --------------------------------------------- | ------------------------------------------------------ |
| `web/package.json`                            | Next.js project config                                 |
| `web/next.config.ts`                          | Next.js configuration                                  |
| `web/tailwind.config.ts`                      | Tailwind with stone color palette                      |
| `web/tsconfig.json`                           | TypeScript config                                      |
| `web/src/app/layout.tsx`                      | Root layout with header, system font, global styles    |
| `web/src/app/page.tsx`                        | Homepage: search, stats, org grid, independent sources |
| `web/src/app/[orgSlug]/page.tsx`              | Org detail page with sidebar                           |
| `web/src/app/[orgSlug]/[sourceSlug]/page.tsx` | Source detail page with sidebar (org-affiliated)       |
| `web/src/app/source/[slug]/page.tsx`          | Source detail page (independent, redirects if has org) |
| `web/src/app/search/page.tsx`                 | Search results page                                    |
| `web/src/lib/api.ts`                          | API client — typed fetch wrappers for all endpoints    |
| `web/src/components/header.tsx`               | Site header with nav                                   |
| `web/src/components/sidebar.tsx`              | Metadata sidebar (reused on org + source pages)        |
| `web/src/components/source-card.tsx`          | Source card (reused on homepage + org page)            |
| `web/src/components/release-item.tsx`         | Release list item                                      |
| `web/src/components/pagination.tsx`           | Pagination controls                                    |
| `web/src/components/source-type-icon.tsx`     | GitHub/RSS/globe icon at low opacity                   |
| `web/src/components/search-bar.tsx`           | Search input with navigation                           |

---

## Chunk 1: API Server

### Task 1: API Server Skeleton and Stats Endpoint

**Files:**

- Create: `src/api/server.ts`
- Create: `src/api/routes/stats.ts`
- Create: `src/cli/commands/api.ts`
- Modify: `src/cli/program.ts`

- [ ] **Step 1: Create the API server with routing, CORS, and error handling**

Create `src/api/server.ts`:

```typescript
import { getDb } from "../db/connection.js";
import { handleStats } from "./routes/stats.js";
import { handleOrgs, handleOrgDetail } from "./routes/orgs.js";
import { handleSources, handleSourceDetail } from "./routes/sources.js";
import { handleSearch } from "./routes/search.js";
import { log } from "../lib/logger.js";

export interface ApiError {
  error: string;
  message: string;
}

function jsonResponse(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "Content-Type": "application/json",
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type",
    },
  });
}

function errorResponse(error: string, message: string, status: number): Response {
  return jsonResponse({ error, message }, status);
}

function matchRoute(pathname: string, pattern: string): Record<string, string> | null {
  const patternParts = pattern.split("/");
  const pathParts = pathname.split("/");
  if (patternParts.length !== pathParts.length) return null;
  const params: Record<string, string> = {};
  for (let i = 0; i < patternParts.length; i++) {
    if (patternParts[i].startsWith(":")) {
      params[patternParts[i].slice(1)] = pathParts[i];
    } else if (patternParts[i] !== pathParts[i]) {
      return null;
    }
  }
  return params;
}

export function startApiServer(port: number) {
  // Ensure DB is initialized before handling requests
  getDb();

  const server = Bun.serve({
    port,
    fetch: async (req) => {
      const url = new URL(req.url);
      const { pathname, searchParams } = url;

      // CORS preflight
      if (req.method === "OPTIONS") {
        return jsonResponse(null, 204);
      }

      if (req.method !== "GET") {
        return errorResponse("method_not_allowed", "Only GET requests are supported", 405);
      }

      try {
        // Route matching
        if (pathname === "/api/stats") {
          return jsonResponse(handleStats());
        }

        if (pathname === "/api/orgs") {
          return jsonResponse(handleOrgs());
        }

        const orgParams = matchRoute(pathname, "/api/orgs/:slug");
        if (orgParams) {
          const result = handleOrgDetail(orgParams.slug);
          if (!result)
            return errorResponse("not_found", `No organization with slug '${orgParams.slug}'`, 404);
          return jsonResponse(result);
        }

        if (pathname === "/api/sources") {
          return jsonResponse(handleSources(searchParams));
        }

        const sourceParams = matchRoute(pathname, "/api/sources/:slug");
        if (sourceParams) {
          const page = parseInt(searchParams.get("page") ?? "1", 10);
          const pageSize = parseInt(searchParams.get("pageSize") ?? "20", 10);
          if (isNaN(page) || page < 1 || isNaN(pageSize) || pageSize < 1 || pageSize > 100) {
            return errorResponse("bad_request", "Invalid page or pageSize parameter", 400);
          }
          const result = handleSourceDetail(sourceParams.slug, page, pageSize);
          if (!result)
            return errorResponse("not_found", `No source with slug '${sourceParams.slug}'`, 404);
          return jsonResponse(result);
        }

        if (pathname === "/api/search") {
          const q = searchParams.get("q");
          if (!q || q.trim() === "") {
            return errorResponse("bad_request", "Missing required query parameter 'q'", 400);
          }
          const limit = parseInt(searchParams.get("limit") ?? "20", 10);
          const offset = parseInt(searchParams.get("offset") ?? "0", 10);
          return jsonResponse(handleSearch(q, limit, offset));
        }

        return errorResponse("not_found", `No route matches ${pathname}`, 404);
      } catch (err) {
        log.error(`API error: ${err}`);
        return errorResponse("internal_error", "An unexpected error occurred", 500);
      }
    },
  });

  log.info(`API server listening on http://localhost:${server.port}`);
  return server;
}
```

- [ ] **Step 2: Create the stats route**

Create `src/api/routes/stats.ts`:

```typescript
import { count } from "drizzle-orm";
import { getDb } from "../../db/connection.js";
import { organizations, sources, releases } from "../../db/schema.js";

export function handleStats() {
  const db = getDb();
  const [orgCount] = db.select({ n: count() }).from(organizations).all();
  const [sourceCount] = db.select({ n: count() }).from(sources).all();
  const [releaseCount] = db.select({ n: count() }).from(releases).all();

  return {
    orgs: orgCount.n,
    sources: sourceCount.n,
    releases: releaseCount.n,
  };
}
```

- [ ] **Step 3: Create the CLI command**

Create `src/cli/commands/api.ts`:

```typescript
import { Command } from "commander";
import { startApiServer } from "../../api/server.js";

export function registerApiCommand(program: Command) {
  program
    .command("api")
    .description("Start the read-only JSON API server")
    .option("--port <port>", "Port to listen on", "3456")
    .action((opts: { port: string }) => {
      const port = parseInt(opts.port, 10) || parseInt(process.env.RELEASED_API_PORT ?? "3456", 10);
      startApiServer(port);
    });
}
```

- [ ] **Step 4: Register the command in program.ts**

Add to `src/cli/program.ts`:

1. Add import at the top with the other imports:

```typescript
import { registerApiCommand } from "./commands/api.js";
```

2. Add registration after `registerStatsCommand(program);` (the last existing registration):

```typescript
registerApiCommand(program);
```

- [ ] **Step 5: Test manually**

Run: `bun src/index.ts api`
Expected: Server starts on port 3456, `curl http://localhost:3456/api/stats` returns JSON with org/source/release counts.

- [ ] **Step 6: Commit**

```bash
git add src/api/ src/cli/commands/api.ts src/cli/program.ts
git commit -m "Add API server skeleton with stats endpoint"
```

### Task 2: Activity Metrics Helper

**Files:**

- Create: `src/api/metrics.ts`

- [ ] **Step 1: Create the shared metrics computation module**

Create `src/api/metrics.ts`:

```typescript
import { eq, gte, count, min, and, sql } from "drizzle-orm";
import { getDb } from "../db/connection.js";
import { releases, sources } from "../db/schema.js";
import { daysAgoIso } from "../lib/dates.js";

interface ActivityMetrics {
  releasesLast30Days: number;
  avgReleasesPerWeek: number;
}

/** Compute activity metrics for a single source */
export function getSourceMetrics(sourceId: string): ActivityMetrics {
  const db = getDb();
  const cutoff = daysAgoIso(30);

  const [recent] = db
    .select({ n: count() })
    .from(releases)
    .where(and(eq(releases.sourceId, sourceId), gte(releases.publishedAt, cutoff)))
    .all();

  const [totals] = db
    .select({
      total: count(),
      oldest: min(releases.publishedAt),
    })
    .from(releases)
    .where(and(eq(releases.sourceId, sourceId), sql`${releases.publishedAt} IS NOT NULL`))
    .all();

  return {
    releasesLast30Days: recent.n,
    avgReleasesPerWeek: computeAvgPerWeek(totals.total, totals.oldest),
  };
}

/** Compute activity metrics for all sources in an org */
export function getOrgMetrics(orgId: string): ActivityMetrics {
  const db = getDb();
  const cutoff = daysAgoIso(30);

  // Get all source IDs for the org
  const orgSources = db
    .select({ id: sources.id })
    .from(sources)
    .where(eq(sources.orgId, orgId))
    .all();

  if (orgSources.length === 0) {
    return { releasesLast30Days: 0, avgReleasesPerWeek: 0 };
  }

  const sourceIds = orgSources.map((s) => s.id);

  const [recent] = db
    .select({ n: count() })
    .from(releases)
    .where(
      and(
        sql`${releases.sourceId} IN (${sql.join(
          sourceIds.map((id) => sql`${id}`),
          sql`, `,
        )})`,
        gte(releases.publishedAt, cutoff),
      ),
    )
    .all();

  const [totals] = db
    .select({
      total: count(),
      oldest: min(releases.publishedAt),
    })
    .from(releases)
    .where(
      and(
        sql`${releases.sourceId} IN (${sql.join(
          sourceIds.map((id) => sql`${id}`),
          sql`, `,
        )})`,
        sql`${releases.publishedAt} IS NOT NULL`,
      ),
    )
    .all();

  return {
    releasesLast30Days: recent.n,
    avgReleasesPerWeek: computeAvgPerWeek(totals.total, totals.oldest),
  };
}

function computeAvgPerWeek(totalReleases: number, oldestPublishedAt: string | null): number {
  if (totalReleases === 0 || !oldestPublishedAt) return 0;

  const oldestDate = new Date(oldestPublishedAt);
  const now = new Date();
  const weeks = (now.getTime() - oldestDate.getTime()) / (7 * 24 * 60 * 60 * 1000);

  // If less than 1 week, use total count as the rate
  if (weeks < 1) return totalReleases;

  return Math.round((totalReleases / weeks) * 10) / 10;
}
```

- [ ] **Step 2: Test manually**

This module is used by the route handlers in the next tasks. Verify it compiles:
Run: `npx tsc --noEmit`

- [ ] **Step 3: Commit**

```bash
git add src/api/metrics.ts
git commit -m "Add shared activity metrics computation"
```

### Task 3: Orgs Endpoints

**Files:**

- Create: `src/api/routes/orgs.ts`

- [ ] **Step 1: Create the orgs route handlers**

Create `src/api/routes/orgs.ts`:

```typescript
import { eq, desc, count, max, sql, and } from "drizzle-orm";
import { getDb } from "../../db/connection.js";
import { organizations, orgAccounts, sources, releases } from "../../db/schema.js";
import { getOrgMetrics } from "../metrics.js";

export function handleOrgs() {
  const db = getDb();

  const rows = db
    .select({
      slug: organizations.slug,
      name: organizations.name,
      domain: organizations.domain,
      id: organizations.id,
    })
    .from(organizations)
    .orderBy(organizations.name)
    .all();

  return rows.map((org) => {
    const [srcCount] = db
      .select({ n: count() })
      .from(sources)
      .where(eq(sources.orgId, org.id))
      .all();

    const [relCount] = db
      .select({ n: count() })
      .from(releases)
      .innerJoin(sources, eq(releases.sourceId, sources.id))
      .where(eq(sources.orgId, org.id))
      .all();

    const [latest] = db
      .select({ maxDate: max(releases.publishedAt) })
      .from(releases)
      .innerJoin(sources, eq(releases.sourceId, sources.id))
      .where(and(eq(sources.orgId, org.id), sql`${releases.publishedAt} IS NOT NULL`))
      .all();

    return {
      slug: org.slug,
      name: org.name,
      domain: org.domain,
      sourceCount: srcCount.n,
      releaseCount: relCount.n,
      lastActivity: latest.maxDate ?? null,
    };
  });
}

export function handleOrgDetail(slug: string) {
  const db = getDb();

  const [org] = db.select().from(organizations).where(eq(organizations.slug, slug)).all();

  if (!org) return null;

  const accounts = db
    .select({ platform: orgAccounts.platform, handle: orgAccounts.handle })
    .from(orgAccounts)
    .where(eq(orgAccounts.orgId, org.id))
    .all();

  const orgSources = db
    .select()
    .from(sources)
    .where(eq(sources.orgId, org.id))
    .orderBy(sources.name)
    .all();

  const sourcesWithStats = orgSources.map((src) => {
    const [relCount] = db
      .select({ n: count() })
      .from(releases)
      .where(eq(releases.sourceId, src.id))
      .all();

    // Latest release with non-null publishedAt
    const [latest] = db
      .select({
        version: releases.version,
        publishedAt: releases.publishedAt,
      })
      .from(releases)
      .where(and(eq(releases.sourceId, src.id), sql`${releases.publishedAt} IS NOT NULL`))
      .orderBy(desc(releases.publishedAt))
      .limit(1)
      .all();

    // Fallback: most recently fetched if no dated releases
    const latestVersion =
      latest?.version ??
      (() => {
        const [fallback] = db
          .select({ version: releases.version })
          .from(releases)
          .where(eq(releases.sourceId, src.id))
          .orderBy(desc(releases.fetchedAt))
          .limit(1)
          .all();
        return fallback?.version ?? null;
      })();

    return {
      slug: src.slug,
      name: src.name,
      type: src.type,
      releaseCount: relCount.n,
      latestVersion,
      latestDate: latest?.publishedAt ?? null,
    };
  });

  const metrics = getOrgMetrics(org.id);
  const [totalReleases] = db
    .select({ n: count() })
    .from(releases)
    .innerJoin(sources, eq(releases.sourceId, sources.id))
    .where(eq(sources.orgId, org.id))
    .all();

  return {
    slug: org.slug,
    name: org.name,
    domain: org.domain,
    sourceCount: orgSources.length,
    releaseCount: totalReleases.n,
    releasesLast30Days: metrics.releasesLast30Days,
    avgReleasesPerWeek: metrics.avgReleasesPerWeek,
    trackingSince: org.createdAt,
    accounts,
    sources: sourcesWithStats,
  };
}
```

- [ ] **Step 2: Test manually**

Run: `bun src/index.ts api`
Test:

- `curl http://localhost:3456/api/orgs` — returns array of orgs
- `curl http://localhost:3456/api/orgs/<a-real-slug>` — returns org detail
- `curl http://localhost:3456/api/orgs/nonexistent` — returns 404

- [ ] **Step 3: Commit**

```bash
git add src/api/routes/orgs.ts
git commit -m "Add orgs list and detail API endpoints"
```

### Task 4: Sources Endpoints

**Files:**

- Create: `src/api/routes/sources.ts`

- [ ] **Step 1: Create the sources route handlers**

Create `src/api/routes/sources.ts`:

```typescript
import { eq, desc, count, and, sql, isNull } from "drizzle-orm";
import { getDb } from "../../db/connection.js";
import { sources, releases, organizations } from "../../db/schema.js";
import { getSourceMetrics } from "../metrics.js";

export function handleSources(searchParams: URLSearchParams) {
  const db = getDb();
  const independent = searchParams.get("independent") === "true";

  const query = independent
    ? db.select().from(sources).where(isNull(sources.orgId))
    : db.select().from(sources);

  const rows = query.orderBy(sources.name).all();

  return rows.map((src) => {
    const [relCount] = db
      .select({ n: count() })
      .from(releases)
      .where(eq(releases.sourceId, src.id))
      .all();

    const [latest] = db
      .select({ version: releases.version, publishedAt: releases.publishedAt })
      .from(releases)
      .where(and(eq(releases.sourceId, src.id), sql`${releases.publishedAt} IS NOT NULL`))
      .orderBy(desc(releases.publishedAt))
      .limit(1)
      .all();

    // Get org slug if exists
    let orgSlug: string | null = null;
    if (src.orgId) {
      const [org] = db
        .select({ slug: organizations.slug })
        .from(organizations)
        .where(eq(organizations.id, src.orgId))
        .all();
      orgSlug = org?.slug ?? null;
    }

    return {
      slug: src.slug,
      name: src.name,
      type: src.type,
      url: src.url,
      orgSlug,
      releaseCount: relCount.n,
      latestVersion: latest?.version ?? null,
      latestDate: latest?.publishedAt ?? null,
    };
  });
}

export function handleSourceDetail(slug: string, page: number, pageSize: number) {
  const db = getDb();

  const [src] = db.select().from(sources).where(eq(sources.slug, slug)).all();
  if (!src) return null;

  // Get org info
  let org: { slug: string; name: string } | null = null;
  if (src.orgId) {
    const [orgRow] = db
      .select({ slug: organizations.slug, name: organizations.name })
      .from(organizations)
      .where(eq(organizations.id, src.orgId))
      .all();
    org = orgRow ?? null;
  }

  // Total release count
  const [relCount] = db
    .select({ n: count() })
    .from(releases)
    .where(eq(releases.sourceId, src.id))
    .all();

  // Paginated releases: dated first (newest), then undated (newest fetched)
  const offset = (page - 1) * pageSize;
  const releaseRows = db.all<{
    version: string | null;
    title: string;
    content_summary: string | null;
    content: string;
    published_at: string | null;
    url: string | null;
  }>(sql`
    SELECT version, title, content_summary, content, published_at, url
    FROM releases
    WHERE source_id = ${src.id}
    ORDER BY
      CASE WHEN published_at IS NOT NULL THEN 0 ELSE 1 END,
      published_at DESC,
      fetched_at DESC
    LIMIT ${pageSize}
    OFFSET ${offset}
  `);

  const releasesFormatted = releaseRows.map((r) => ({
    version: r.version,
    title: r.title,
    summary:
      r.content_summary ?? (r.content.length > 150 ? r.content.slice(0, 150) + "..." : r.content),
    publishedAt: r.published_at,
    url: r.url,
  }));

  // Latest version (non-null publishedAt preferred)
  const [latest] = db
    .select({ version: releases.version, publishedAt: releases.publishedAt })
    .from(releases)
    .where(and(eq(releases.sourceId, src.id), sql`${releases.publishedAt} IS NOT NULL`))
    .orderBy(desc(releases.publishedAt))
    .limit(1)
    .all();

  const latestVersion =
    latest?.version ??
    (() => {
      const [fallback] = db
        .select({ version: releases.version })
        .from(releases)
        .where(eq(releases.sourceId, src.id))
        .orderBy(desc(releases.fetchedAt))
        .limit(1)
        .all();
      return fallback?.version ?? null;
    })();

  const metrics = getSourceMetrics(src.id);
  const totalPages = Math.ceil(relCount.n / pageSize);

  return {
    slug: src.slug,
    name: src.name,
    type: src.type,
    url: src.url,
    org,
    releaseCount: relCount.n,
    releasesLast30Days: metrics.releasesLast30Days,
    avgReleasesPerWeek: metrics.avgReleasesPerWeek,
    latestVersion,
    latestDate: latest?.publishedAt ?? null,
    trackingSince: src.createdAt,
    releases: releasesFormatted,
    pagination: {
      page,
      pageSize,
      totalPages,
      totalItems: relCount.n,
    },
  };
}
```

- [ ] **Step 2: Test manually**

Run: `bun src/index.ts api`
Test:

- `curl http://localhost:3456/api/sources?independent=true` — returns sources without orgs
- `curl http://localhost:3456/api/sources/<a-real-slug>` — returns source detail with releases
- `curl http://localhost:3456/api/sources/<slug>?page=2` — returns page 2

- [ ] **Step 3: Commit**

```bash
git add src/api/routes/sources.ts
git commit -m "Add sources list and detail API endpoints"
```

### Task 5: Search Endpoint

**Files:**

- Create: `src/api/routes/search.ts`
- Modify: `src/db/fts.ts` (extend to support offset)

- [ ] **Step 1: Extend FTS to support offset and return source info**

Add to `src/db/fts.ts` a new function:

```typescript
export interface SearchApiResult {
  sourceSlug: string;
  sourceName: string;
  orgSlug: string | null;
  version: string | null;
  title: string;
  summary: string;
  publishedAt: string | null;
}

export function searchReleasesForApi(
  query: string,
  limit: number,
  offset: number,
): SearchApiResult[] {
  const db = getDb();
  return db.all<SearchApiResult>(sql`
    SELECT
      s.slug as sourceSlug,
      s.name as sourceName,
      o.slug as orgSlug,
      r.version,
      r.title,
      COALESCE(r.content_summary, SUBSTR(r.content, 1, 150)) as summary,
      r.published_at as publishedAt
    FROM releases_fts
    JOIN releases r ON r.rowid = releases_fts.rowid
    JOIN sources s ON s.id = r.source_id
    LEFT JOIN organizations o ON o.id = s.org_id
    WHERE releases_fts MATCH ${query}
    ORDER BY rank
    LIMIT ${limit}
    OFFSET ${offset}
  `);
}
```

- [ ] **Step 2: Create the search route**

Create `src/api/routes/search.ts`:

```typescript
import { searchReleasesForApi } from "../../db/fts.js";

export function handleSearch(q: string, limit: number, offset: number) {
  const results = searchReleasesForApi(q, limit, offset);
  return {
    query: q,
    results,
  };
}
```

- [ ] **Step 3: Test manually**

Run: `bun src/index.ts api`
Test: `curl "http://localhost:3456/api/search?q=<a-term-you-have-data-for>"`

- [ ] **Step 4: Verify all endpoints compile**

Run: `npx tsc --noEmit`

- [ ] **Step 5: Commit**

```bash
git add src/api/routes/search.ts src/db/fts.ts
git commit -m "Add search API endpoint with FTS5 join"
```

---

## Chunk 2: Next.js Frontend Setup

### Task 6: Scaffold Next.js App

**Files:**

- Create: `web/package.json`
- Create: `web/next.config.ts`
- Create: `web/tailwind.config.ts`
- Create: `web/tsconfig.json`
- Create: `web/postcss.config.mjs`
- Create: `web/src/app/globals.css`
- Create: `web/src/app/layout.tsx`

- [ ] **Step 1: Create `web/package.json`**

```json
{
  "name": "released-web",
  "version": "0.1.0",
  "private": true,
  "scripts": {
    "dev": "next dev --turbopack",
    "build": "next build",
    "start": "next start"
  },
  "dependencies": {
    "next": "^15.3.0",
    "react": "^19.1.0",
    "react-dom": "^19.1.0"
  },
  "devDependencies": {
    "@tailwindcss/postcss": "^4.1.0",
    "@types/node": "^22.0.0",
    "@types/react": "^19.1.0",
    "@types/react-dom": "^19.1.0",
    "tailwindcss": "^4.1.0",
    "typescript": "^5.8.0"
  }
}
```

- [ ] **Step 2: Create `web/next.config.ts`**

```typescript
import type { NextConfig } from "next";

const nextConfig: NextConfig = {};

export default nextConfig;
```

- [ ] **Step 3: Create `web/tsconfig.json`**

```json
{
  "compilerOptions": {
    "target": "ES2017",
    "lib": ["dom", "dom.iterable", "esnext"],
    "allowJs": true,
    "skipLibCheck": true,
    "strict": true,
    "noEmit": true,
    "esModuleInterop": true,
    "module": "esnext",
    "moduleResolution": "bundler",
    "resolveJsonModule": true,
    "isolatedModules": true,
    "jsx": "preserve",
    "incremental": true,
    "plugins": [{ "name": "next" }],
    "paths": { "@/*": ["./src/*"] }
  },
  "include": ["next-env.d.ts", "**/*.ts", "**/*.tsx", ".next/types/**/*.ts"],
  "exclude": ["node_modules"]
}
```

- [ ] **Step 4: Create `web/postcss.config.mjs`**

```javascript
const config = {
  plugins: {
    "@tailwindcss/postcss": {},
  },
};

export default config;
```

- [ ] **Step 5: Create `web/src/app/globals.css`**

```css
@import "tailwindcss";
```

- [ ] **Step 6: Create `web/src/app/layout.tsx`**

```tsx
import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "released",
  description:
    "Release notes, indexed. Track changelogs across the tools and libraries you depend on.",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body
        className="bg-stone-50 text-stone-900 antialiased"
        style={{ fontFamily: "system-ui, -apple-system, sans-serif" }}
      >
        {children}
      </body>
    </html>
  );
}
```

- [ ] **Step 7: Install dependencies and verify**

```bash
cd web && bun install && bun run dev
```

Expected: Next.js starts on port 3000 with a blank page.

- [ ] **Step 8: Commit**

```bash
git add web/
git commit -m "Scaffold Next.js frontend app"
```

### Task 7: API Client and Shared Components

**Files:**

- Create: `web/src/lib/api.ts`
- Create: `web/src/components/header.tsx`
- Create: `web/src/components/source-type-icon.tsx`
- Create: `web/src/components/source-card.tsx`
- Create: `web/src/components/release-item.tsx`
- Create: `web/src/components/pagination.tsx`
- Create: `web/src/components/sidebar.tsx`
- Create: `web/src/components/search-bar.tsx`

- [ ] **Step 1: Create API client**

Create `web/src/lib/api.ts`:

```typescript
const API_URL = process.env.RELEASED_API_URL ?? "http://localhost:3456";

async function fetchApi<T>(path: string): Promise<T> {
  const res = await fetch(`${API_URL}${path}`, { next: { revalidate: 60 } });
  if (!res.ok) {
    throw new Error(`API error: ${res.status} ${res.statusText}`);
  }
  return res.json();
}

export interface Stats {
  orgs: number;
  sources: number;
  releases: number;
}

export interface OrgListItem {
  slug: string;
  name: string;
  domain: string | null;
  sourceCount: number;
  releaseCount: number;
  lastActivity: string | null;
}

export interface OrgDetail {
  slug: string;
  name: string;
  domain: string | null;
  sourceCount: number;
  releaseCount: number;
  releasesLast30Days: number;
  avgReleasesPerWeek: number;
  trackingSince: string;
  accounts: { platform: string; handle: string }[];
  sources: SourceListItem[];
}

export interface SourceListItem {
  slug: string;
  name: string;
  type: string;
  url?: string;
  orgSlug?: string | null;
  releaseCount: number;
  latestVersion: string | null;
  latestDate: string | null;
}

export interface SourceDetail {
  slug: string;
  name: string;
  type: string;
  url: string;
  org: { slug: string; name: string } | null;
  releaseCount: number;
  releasesLast30Days: number;
  avgReleasesPerWeek: number;
  latestVersion: string | null;
  latestDate: string | null;
  trackingSince: string;
  releases: ReleaseItem[];
  pagination: { page: number; pageSize: number; totalPages: number; totalItems: number };
}

export interface ReleaseItem {
  version: string | null;
  title: string;
  summary: string;
  publishedAt: string | null;
  url: string | null;
}

export interface SearchResult {
  sourceSlug: string;
  sourceName: string;
  orgSlug: string | null;
  version: string | null;
  title: string;
  summary: string;
  publishedAt: string | null;
}

export interface SearchResponse {
  query: string;
  results: SearchResult[];
}

export const api = {
  stats: () => fetchApi<Stats>("/api/stats"),
  orgs: () => fetchApi<OrgListItem[]>("/api/orgs"),
  orgDetail: (slug: string) => fetchApi<OrgDetail>(`/api/orgs/${slug}`),
  sources: (independent?: boolean) =>
    fetchApi<SourceListItem[]>(`/api/sources${independent ? "?independent=true" : ""}`),
  sourceDetail: (slug: string, page = 1, pageSize = 20) =>
    fetchApi<SourceDetail>(`/api/sources/${slug}?page=${page}&pageSize=${pageSize}`),
  search: (q: string, limit = 20, offset = 0) =>
    fetchApi<SearchResponse>(
      `/api/search?q=${encodeURIComponent(q)}&limit=${limit}&offset=${offset}`,
    ),
};
```

- [ ] **Step 2: Create header component**

Create `web/src/components/header.tsx`:

```tsx
import Link from "next/link";

export function Header() {
  return (
    <header className="border-b border-stone-200 px-6 py-4 flex items-center justify-between">
      <Link href="/" className="font-bold text-lg tracking-tight text-stone-900">
        released
      </Link>
      <nav className="flex gap-5 text-sm text-stone-500">
        <Link href="/" className="hover:text-stone-700">
          Browse
        </Link>
        <Link href="/search" className="hover:text-stone-700">
          Search
        </Link>
      </nav>
    </header>
  );
}
```

- [ ] **Step 3: Create source type icon component**

Create `web/src/components/source-type-icon.tsx`:

```tsx
export function SourceTypeIcon({ type, size = 16 }: { type: string; size?: number }) {
  if (type === "github") {
    return (
      <svg
        width={size}
        height={size}
        viewBox="0 0 24 24"
        fill="currentColor"
        className="text-stone-900 opacity-25"
      >
        <path d="M12 0c-6.626 0-12 5.373-12 12 0 5.302 3.438 9.8 8.207 11.387.599.111.793-.261.793-.577v-2.234c-3.338.726-4.033-1.416-4.033-1.416-.546-1.387-1.333-1.756-1.333-1.756-1.089-.745.083-.729.083-.729 1.205.084 1.839 1.237 1.839 1.237 1.07 1.834 2.807 1.304 3.492.997.107-.775.418-1.305.762-1.604-2.665-.305-5.467-1.334-5.467-5.931 0-1.311.469-2.381 1.236-3.221-.124-.303-.535-1.524.117-3.176 0 0 1.008-.322 3.301 1.23.957-.266 1.983-.399 3.003-.404 1.02.005 2.047.138 3.006.404 2.291-1.552 3.297-1.23 3.297-1.23.653 1.653.242 2.874.118 3.176.77.84 1.235 1.911 1.235 3.221 0 4.609-2.807 5.624-5.479 5.921.43.372.823 1.102.823 2.222v3.293c0 .319.192.694.801.576 4.765-1.589 8.199-6.086 8.199-11.386 0-6.627-5.373-12-12-12z" />
      </svg>
    );
  }

  if (type === "feed") {
    return (
      <svg
        width={size}
        height={size}
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
        className="text-stone-900 opacity-25"
      >
        <path d="M4 11a9 9 0 0 1 9 9" />
        <path d="M4 4a16 16 0 0 1 16 16" />
        <circle cx="5" cy="19" r="1" />
      </svg>
    );
  }

  // scrape / default: globe
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      className="text-stone-900 opacity-25"
    >
      <circle cx="12" cy="12" r="10" />
      <path d="M2 12h20" />
      <path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z" />
    </svg>
  );
}
```

- [ ] **Step 4: Create source card component**

Create `web/src/components/source-card.tsx`:

```tsx
import Link from "next/link";
import { SourceTypeIcon } from "./source-type-icon";
import type { SourceListItem } from "@/lib/api";

function formatDate(iso: string | null) {
  if (!iso) return null;
  return new Date(iso).toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
  });
}

function hostname(url?: string) {
  if (!url) return null;
  try {
    return new URL(url).hostname;
  } catch {
    return null;
  }
}

export function SourceCard({ source, orgSlug }: { source: SourceListItem; orgSlug?: string }) {
  const href = orgSlug ? `/${orgSlug}/${source.slug}` : `/source/${source.slug}`;

  return (
    <Link
      href={href}
      className="block bg-white border border-stone-200 rounded-lg p-4 hover:border-stone-300 transition-colors"
    >
      <div className="flex justify-between items-center">
        <span className="font-semibold text-[15px] text-stone-900">{source.name}</span>
        <SourceTypeIcon type={source.type} />
      </div>
      {source.url && <div className="text-[13px] text-stone-500 mt-1">{hostname(source.url)}</div>}
      <div className="text-xs text-stone-400 mt-2">
        {source.latestVersion && <>Latest: {source.latestVersion}</>}
        {source.latestDate && <> · {formatDate(source.latestDate)}</>}
        {source.releaseCount > 0 && <> · {source.releaseCount} releases</>}
      </div>
    </Link>
  );
}
```

- [ ] **Step 5: Create release item component**

Create `web/src/components/release-item.tsx`:

```tsx
import type { ReleaseItem } from "@/lib/api";

function formatDate(iso: string | null) {
  if (!iso) return null;
  return new Date(iso).toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
  });
}

export function ReleaseListItem({ release }: { release: ReleaseItem }) {
  return (
    <div className="border-b border-stone-200 py-4 first:pt-0 last:border-b-0">
      <div className="flex justify-between items-baseline mb-1">
        <span className="font-semibold text-[15px] text-stone-900">{release.version ?? "—"}</span>
        <span className="text-xs text-stone-400 whitespace-nowrap ml-4">
          {formatDate(release.publishedAt)}
        </span>
      </div>
      <div className="text-sm text-stone-600 mb-1">{release.title}</div>
      <p className="text-[13px] text-stone-500 leading-relaxed">{release.summary}</p>
    </div>
  );
}
```

- [ ] **Step 6: Create pagination component**

Create `web/src/components/pagination.tsx`:

```tsx
import Link from "next/link";

interface PaginationProps {
  page: number;
  totalPages: number;
  basePath: string;
}

export function Pagination({ page, totalPages, basePath }: PaginationProps) {
  if (totalPages <= 1) return null;

  const pages: number[] = [];
  for (let i = Math.max(1, page - 2); i <= Math.min(totalPages, page + 2); i++) {
    pages.push(i);
  }

  function href(p: number) {
    return p === 1 ? basePath : `${basePath}?page=${p}`;
  }

  return (
    <div className="mt-4 pt-4 border-t border-stone-200 flex justify-center gap-2 text-sm">
      {page > 1 ? (
        <Link href={href(page - 1)} className="text-stone-500 hover:text-stone-700">
          Previous
        </Link>
      ) : (
        <span className="text-stone-300">Previous</span>
      )}

      {pages.map((p) => (
        <Link
          key={p}
          href={href(p)}
          className={
            p === page
              ? "font-semibold text-stone-900 bg-stone-100 px-2 py-0.5 rounded"
              : "text-stone-500 hover:text-stone-700 px-2 py-0.5"
          }
        >
          {p}
        </Link>
      ))}

      {page < totalPages ? (
        <Link href={href(page + 1)} className="text-stone-500 hover:text-stone-700">
          Next
        </Link>
      ) : (
        <span className="text-stone-300">Next</span>
      )}
    </div>
  );
}
```

- [ ] **Step 7: Create sidebar component**

Create `web/src/components/sidebar.tsx`:

```tsx
import Link from "next/link";
import { SourceTypeIcon } from "./source-type-icon";

interface SidebarItem {
  label: string;
  value: string | number | null;
  large?: boolean;
  subtitle?: string;
  link?: string;
}

interface SidebarSection {
  items: SidebarItem[];
}

interface SidebarProps {
  sections: SidebarSection[];
  accounts?: { platform: string; handle: string }[];
}

export function Sidebar({ sections, accounts }: SidebarProps) {
  return (
    <div className="w-[200px] shrink-0">
      {sections.map((section, si) => (
        <div key={si} className={si > 0 ? "border-t border-stone-200 pt-5" : ""}>
          {section.items.map((item, ii) => (
            <div key={ii} className="mb-6">
              <div className="text-[11px] font-semibold uppercase tracking-wider text-stone-400 mb-1.5">
                {item.label}
              </div>
              {item.link ? (
                <Link
                  href={item.link}
                  className="text-sm font-medium text-stone-900 hover:text-stone-600"
                >
                  {String(item.value)}
                </Link>
              ) : (
                <>
                  <div
                    className={
                      item.large
                        ? "text-[22px] font-bold text-stone-900"
                        : "text-sm font-medium text-stone-900"
                    }
                  >
                    {item.value ?? "—"}
                  </div>
                  {item.subtitle && (
                    <div className="text-xs text-stone-400 mt-0.5">{item.subtitle}</div>
                  )}
                </>
              )}
            </div>
          ))}
        </div>
      ))}

      {accounts && accounts.length > 0 && (
        <div className="border-t border-stone-200 pt-5 mb-6">
          <div className="text-[11px] font-semibold uppercase tracking-wider text-stone-400 mb-1.5">
            Accounts
          </div>
          <div className="space-y-1.5">
            {accounts.map((acc, i) => (
              <div key={i} className="flex items-center gap-1.5 text-[13px] text-stone-600">
                <SourceTypeIcon type={acc.platform} size={13} />
                <span>{acc.handle}</span>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
```

- [ ] **Step 8: Create search bar component**

Create `web/src/components/search-bar.tsx`:

```tsx
"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

export function SearchBar({ defaultValue }: { defaultValue?: string }) {
  const router = useRouter();
  const [query, setQuery] = useState(defaultValue ?? "");

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (query.trim()) {
      router.push(`/search?q=${encodeURIComponent(query.trim())}`);
    }
  }

  return (
    <form onSubmit={handleSubmit} className="max-w-[480px] mx-auto">
      <input
        type="text"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        placeholder="Search releases..."
        className="w-full bg-white border border-stone-300 rounded-lg px-4 py-2.5 text-sm text-stone-900 placeholder:text-stone-400 outline-none focus:border-stone-400 transition-colors"
      />
    </form>
  );
}
```

- [ ] **Step 9: Commit**

```bash
git add web/src/lib/ web/src/components/
git commit -m "Add API client and shared UI components"
```

---

## Chunk 3: Frontend Pages

### Task 8: Homepage

**Files:**

- Create: `web/src/app/page.tsx`

- [ ] **Step 1: Create the homepage**

Create `web/src/app/page.tsx`:

```tsx
import { api } from "@/lib/api";
import { Header } from "@/components/header";
import { SearchBar } from "@/components/search-bar";
import { SourceCard } from "@/components/source-card";
import Link from "next/link";

export default async function HomePage() {
  const [stats, orgs, independentSources] = await Promise.all([
    api.stats(),
    api.orgs(),
    api.sources(true),
  ]);

  return (
    <div className="min-h-screen">
      <Header />

      {/* Hero */}
      <div className="pt-12 pb-8 text-center px-6">
        <h1 className="text-[28px] font-bold tracking-tight text-stone-900 mb-2">
          Release notes, indexed
        </h1>
        <p className="text-[15px] text-stone-500 mb-6">
          Track changelogs across the tools and libraries you depend on.
        </p>
        <SearchBar />
        <div className="flex justify-center gap-8 mt-5 text-[13px] text-stone-400">
          <span>
            <strong className="text-stone-600">{stats.orgs}</strong> orgs
          </span>
          <span>
            <strong className="text-stone-600">{stats.sources}</strong> sources
          </span>
          <span>
            <strong className="text-stone-600">{stats.releases.toLocaleString()}</strong> releases
          </span>
        </div>
      </div>

      <div className="max-w-4xl mx-auto px-6 pb-12">
        {/* Organizations */}
        {orgs.length > 0 && (
          <div className="mb-8">
            <div className="text-xs font-semibold uppercase tracking-wider text-stone-400 mb-3">
              Organizations
            </div>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
              {orgs.map((org) => (
                <Link
                  key={org.slug}
                  href={`/${org.slug}`}
                  className="bg-white border border-stone-200 rounded-lg px-4 py-3.5 hover:border-stone-300 transition-colors"
                >
                  <div className="flex justify-between items-start">
                    <div>
                      <div className="font-semibold text-sm text-stone-900">{org.name}</div>
                      {org.domain && (
                        <div className="text-xs text-stone-400 mt-0.5">{org.domain}</div>
                      )}
                    </div>
                    <div className="text-xs text-stone-500 bg-stone-100 px-2 py-0.5 rounded">
                      {org.sourceCount} sources
                    </div>
                  </div>
                </Link>
              ))}
            </div>
          </div>
        )}

        {/* Independent Projects */}
        {independentSources.length > 0 && (
          <div>
            <div className="text-xs font-semibold uppercase tracking-wider text-stone-400 mb-3">
              Independent Projects
            </div>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
              {independentSources.map((source) => (
                <SourceCard key={source.slug} source={source} />
              ))}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
```

- [ ] **Step 2: Test manually**

Start the API: `bun src/index.ts api`
Start the frontend: `cd web && bun run dev`
Open `http://localhost:3000` — should see homepage with real data.

- [ ] **Step 3: Commit**

```bash
git add web/src/app/page.tsx
git commit -m "Add homepage with org grid and independent sources"
```

### Task 9: Org Detail Page

**Files:**

- Create: `web/src/app/[orgSlug]/page.tsx`

- [ ] **Step 1: Create the org page**

Create `web/src/app/[orgSlug]/page.tsx`:

```tsx
import { notFound } from "next/navigation";
import { api } from "@/lib/api";
import { Header } from "@/components/header";
import { SourceCard } from "@/components/source-card";
import { Sidebar } from "@/components/sidebar";
import Link from "next/link";

function formatDate(iso: string | null) {
  if (!iso) return "—";
  return new Date(iso).toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
  });
}

export default async function OrgPage({ params }: { params: Promise<{ orgSlug: string }> }) {
  const { orgSlug } = await params;

  let org;
  try {
    org = await api.orgDetail(orgSlug);
  } catch {
    notFound();
  }

  const sidebarSections = [
    {
      items: [
        ...(org.domain ? [{ label: "Domain", value: org.domain }] : []),
        { label: "Sources", value: org.sourceCount, large: true },
        { label: "Total Releases", value: org.releaseCount, large: true },
      ],
    },
    {
      items: [
        { label: "Last 30 Days", value: org.releasesLast30Days, large: true, subtitle: "releases" },
        { label: "Avg per Week", value: org.avgReleasesPerWeek, large: true, subtitle: "releases" },
      ],
    },
    {
      items: [{ label: "Tracking Since", value: formatDate(org.trackingSince) }],
    },
  ];

  return (
    <div className="min-h-screen">
      <Header />

      <div className="max-w-4xl mx-auto px-6">
        {/* Breadcrumb */}
        <div className="pt-5 text-[13px] text-stone-400">
          <Link href="/" className="hover:text-stone-600">
            Home
          </Link>
          <span className="mx-1.5">/</span>
          <span className="text-stone-600 font-medium">{org.name}</span>
        </div>

        {/* Title */}
        <h1 className="text-[28px] font-bold tracking-tight text-stone-900 mt-4">{org.name}</h1>

        {/* Two-column layout */}
        <div className="flex gap-10 mt-6 pb-12">
          {/* Left: Sources */}
          <div className="flex-1 min-w-0 space-y-2">
            {org.sources.map((source) => (
              <SourceCard key={source.slug} source={source} orgSlug={org.slug} />
            ))}
          </div>

          {/* Right: Sidebar */}
          <Sidebar sections={sidebarSections} accounts={org.accounts} />
        </div>
      </div>
    </div>
  );
}
```

- [ ] **Step 2: Test manually**

Navigate to `http://localhost:3000/<an-org-slug>` — should see org page with sidebar and source cards.

- [ ] **Step 3: Commit**

```bash
git add web/src/app/\[orgSlug\]/page.tsx
git commit -m "Add org detail page with sidebar layout"
```

### Task 10: Source Detail Page (Org-Affiliated)

**Files:**

- Create: `web/src/app/[orgSlug]/[sourceSlug]/page.tsx`

- [ ] **Step 1: Create the source page**

Create `web/src/app/[orgSlug]/[sourceSlug]/page.tsx`:

```tsx
import { notFound, redirect } from "next/navigation";
import { api } from "@/lib/api";
import { Header } from "@/components/header";
import { SourceTypeIcon } from "@/components/source-type-icon";
import { ReleaseListItem } from "@/components/release-item";
import { Pagination } from "@/components/pagination";
import { Sidebar } from "@/components/sidebar";
import Link from "next/link";

function formatDate(iso: string | null) {
  if (!iso) return "—";
  return new Date(iso).toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
  });
}

export default async function SourcePage({
  params,
  searchParams,
}: {
  params: Promise<{ orgSlug: string; sourceSlug: string }>;
  searchParams: Promise<{ page?: string }>;
}) {
  const { orgSlug, sourceSlug } = await params;
  const { page: pageParam } = await searchParams;
  const page = parseInt(pageParam ?? "1", 10) || 1;

  let source;
  try {
    source = await api.sourceDetail(sourceSlug, page);
  } catch {
    notFound();
  }

  // Redirect if org slug doesn't match
  if (source.org && source.org.slug !== orgSlug) {
    redirect(`/${source.org.slug}/${source.slug}`);
  }
  if (!source.org) {
    redirect(`/source/${source.slug}`);
  }

  const sidebarSections = [
    {
      items: [{ label: "Releases", value: source.releaseCount, large: true }],
    },
    {
      items: [
        {
          label: "Last 30 Days",
          value: source.releasesLast30Days,
          large: true,
          subtitle: "releases",
        },
        {
          label: "Avg per Week",
          value: source.avgReleasesPerWeek,
          large: true,
          subtitle: "releases",
        },
      ],
    },
    {
      items: [
        { label: "Latest", value: source.latestVersion, subtitle: formatDate(source.latestDate) },
        ...(source.org
          ? [{ label: "Organization", value: source.org.name, link: `/${source.org.slug}` }]
          : []),
        { label: "Source", value: new URL(source.url).hostname },
        { label: "Tracking Since", value: formatDate(source.trackingSince) },
      ],
    },
  ];

  return (
    <div className="min-h-screen">
      <Header />

      <div className="max-w-4xl mx-auto px-6">
        {/* Breadcrumb */}
        <div className="pt-5 text-[13px] text-stone-400">
          <Link href={`/${source.org.slug}`} className="hover:text-stone-600">
            {source.org.name}
          </Link>
          <span className="mx-1.5">/</span>
          <span className="text-stone-600 font-medium">{source.name}</span>
        </div>

        {/* Title */}
        <div className="flex items-center gap-2.5 mt-4">
          <h1 className="text-[28px] font-bold tracking-tight text-stone-900">{source.name}</h1>
          <SourceTypeIcon type={source.type} size={18} />
        </div>

        {/* Two-column layout */}
        <div className="flex gap-10 mt-6 pb-12">
          {/* Left: Releases */}
          <div className="flex-1 min-w-0">
            {source.releases.map((release, i) => (
              <ReleaseListItem key={i} release={release} />
            ))}
            <Pagination
              page={source.pagination.page}
              totalPages={source.pagination.totalPages}
              basePath={`/${orgSlug}/${sourceSlug}`}
            />
          </div>

          {/* Right: Sidebar */}
          <Sidebar sections={sidebarSections} />
        </div>
      </div>
    </div>
  );
}
```

- [ ] **Step 2: Test manually**

Navigate to `http://localhost:3000/<org-slug>/<source-slug>` — should see source page with releases and sidebar.

- [ ] **Step 3: Commit**

```bash
git add web/src/app/\[orgSlug\]/\[sourceSlug\]/page.tsx
git commit -m "Add source detail page with releases and sidebar"
```

### Task 11: Independent Source Page

**Files:**

- Create: `web/src/app/source/[slug]/page.tsx`

- [ ] **Step 1: Create the independent source page**

Create `web/src/app/source/[slug]/page.tsx`:

```tsx
import { notFound, redirect } from "next/navigation";
import { api } from "@/lib/api";
import { Header } from "@/components/header";
import { SourceTypeIcon } from "@/components/source-type-icon";
import { ReleaseListItem } from "@/components/release-item";
import { Pagination } from "@/components/pagination";
import { Sidebar } from "@/components/sidebar";
import Link from "next/link";

function formatDate(iso: string | null) {
  if (!iso) return "—";
  return new Date(iso).toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
  });
}

export default async function IndependentSourcePage({
  params,
  searchParams,
}: {
  params: Promise<{ slug: string }>;
  searchParams: Promise<{ page?: string }>;
}) {
  const { slug } = await params;
  const { page: pageParam } = await searchParams;
  const page = parseInt(pageParam ?? "1", 10) || 1;

  let source;
  try {
    source = await api.sourceDetail(slug, page);
  } catch {
    notFound();
  }

  // If this source has an org, redirect to the canonical URL
  if (source.org) {
    redirect(`/${source.org.slug}/${source.slug}`);
  }

  const sidebarSections = [
    {
      items: [{ label: "Releases", value: source.releaseCount, large: true }],
    },
    {
      items: [
        {
          label: "Last 30 Days",
          value: source.releasesLast30Days,
          large: true,
          subtitle: "releases",
        },
        {
          label: "Avg per Week",
          value: source.avgReleasesPerWeek,
          large: true,
          subtitle: "releases",
        },
      ],
    },
    {
      items: [
        { label: "Latest", value: source.latestVersion, subtitle: formatDate(source.latestDate) },
        { label: "Source", value: new URL(source.url).hostname },
        { label: "Tracking Since", value: formatDate(source.trackingSince) },
      ],
    },
  ];

  return (
    <div className="min-h-screen">
      <Header />

      <div className="max-w-4xl mx-auto px-6">
        {/* Breadcrumb */}
        <div className="pt-5 text-[13px] text-stone-400">
          <Link href="/" className="hover:text-stone-600">
            Home
          </Link>
          <span className="mx-1.5">/</span>
          <span className="text-stone-600 font-medium">{source.name}</span>
        </div>

        {/* Title */}
        <div className="flex items-center gap-2.5 mt-4">
          <h1 className="text-[28px] font-bold tracking-tight text-stone-900">{source.name}</h1>
          <SourceTypeIcon type={source.type} size={18} />
        </div>

        {/* Two-column layout */}
        <div className="flex gap-10 mt-6 pb-12">
          <div className="flex-1 min-w-0">
            {source.releases.map((release, i) => (
              <ReleaseListItem key={i} release={release} />
            ))}
            <Pagination
              page={source.pagination.page}
              totalPages={source.pagination.totalPages}
              basePath={`/source/${slug}`}
            />
          </div>

          <Sidebar sections={sidebarSections} />
        </div>
      </div>
    </div>
  );
}
```

- [ ] **Step 2: Commit**

```bash
git add web/src/app/source/
git commit -m "Add independent source page with org redirect"
```

### Task 12: Search Page

**Files:**

- Create: `web/src/app/search/page.tsx`

- [ ] **Step 1: Create the search results page**

Create `web/src/app/search/page.tsx`:

```tsx
import { api } from "@/lib/api";
import { Header } from "@/components/header";
import { SearchBar } from "@/components/search-bar";
import Link from "next/link";

function formatDate(iso: string | null) {
  if (!iso) return null;
  return new Date(iso).toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
  });
}

export default async function SearchPage({
  searchParams,
}: {
  searchParams: Promise<{ q?: string }>;
}) {
  const { q } = await searchParams;

  let results = null;
  if (q && q.trim()) {
    try {
      results = await api.search(q);
    } catch {
      results = { query: q, results: [] };
    }
  }

  return (
    <div className="min-h-screen">
      <Header />

      <div className="max-w-2xl mx-auto px-6 pt-12 pb-12">
        <h1 className="text-[28px] font-bold tracking-tight text-stone-900 mb-6 text-center">
          Search
        </h1>
        <SearchBar defaultValue={q} />

        {results && (
          <div className="mt-8">
            {results.results.length === 0 ? (
              <p className="text-center text-stone-400 text-sm">No results for &ldquo;{q}&rdquo;</p>
            ) : (
              <div>
                {results.results.map((r, i) => {
                  const href = r.orgSlug
                    ? `/${r.orgSlug}/${r.sourceSlug}`
                    : `/source/${r.sourceSlug}`;
                  return (
                    <div
                      key={i}
                      className="border-b border-stone-200 py-4 first:pt-0 last:border-b-0"
                    >
                      <div className="flex justify-between items-baseline mb-1">
                        <div className="flex items-baseline gap-2">
                          {r.version && (
                            <span className="font-semibold text-[15px] text-stone-900">
                              {r.version}
                            </span>
                          )}
                          <span className="text-sm text-stone-600">{r.title}</span>
                        </div>
                        <span className="text-xs text-stone-400 whitespace-nowrap ml-4">
                          {formatDate(r.publishedAt)}
                        </span>
                      </div>
                      <p className="text-[13px] text-stone-500 mb-1">{r.summary}</p>
                      <Link href={href} className="text-xs text-stone-400 hover:text-stone-600">
                        {r.sourceName}
                      </Link>
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
```

- [ ] **Step 2: Test manually**

Navigate to `http://localhost:3000/search?q=<term>` — should see search results.

- [ ] **Step 3: Commit**

```bash
git add web/src/app/search/
git commit -m "Add search results page"
```

### Task 13: Final Verification and Type Check

- [ ] **Step 1: Type check the API**

Run: `npx tsc --noEmit` from the project root.
Expected: No errors.

- [ ] **Step 2: Type check the frontend**

Run: `cd web && npx tsc --noEmit`
Expected: No errors.

- [ ] **Step 3: End-to-end smoke test**

Start both:

```bash
bun src/index.ts api &
cd web && bun run dev
```

Verify:

- Homepage loads with real data
- Clicking an org navigates to org page with sidebar
- Clicking a source navigates to source page with releases
- Search works
- Pagination works
- Independent source route works
- 404 page for nonexistent slugs

- [ ] **Step 4: Commit any fixes**

```bash
git add -A
git commit -m "Fix any type or rendering issues from smoke test"
```
