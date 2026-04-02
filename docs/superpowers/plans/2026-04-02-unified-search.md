# Unified Search Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the release-only FTS search with a unified endpoint that returns matching orgs, products, sources, and releases in a single response.

**Architecture:** The API worker's `GET /search` endpoint runs three parallel queries — LIKE on orgs/products/sources and FTS on releases — then merges results into a typed multi-section response. The CLI and web app both consume the same shape. When an org or product matches, the response includes its recent releases even if the query doesn't appear in release text (cascading enrichment).

**Tech Stack:** Hono (API worker), SQLite/D1 (LIKE + FTS5), TypeScript shared types, Next.js (web), Commander (CLI)

---

## File Map

| File | Action | Responsibility |
|------|--------|---------------|
| `src/api/types.ts` | Modify | Add unified search response types |
| `workers/api/src/routes/search.ts` | Modify | Replace single FTS query with multi-type search |
| `src/api/client.ts` | Modify | Update `searchReleasesRemote` → `unifiedSearch` |
| `src/db/queries.ts` | Modify | Update remote search function to return new shape |
| `src/db/fts.ts` | Modify | Update `searchReleasesForApi` return type |
| `src/cli/commands/search.ts` | Modify | Display multi-type results, add `--type` flag |
| `web/src/lib/api.ts` | Modify | Update `api.search` return type |
| `web/src/app/search/page.tsx` | Modify | Render org/product/source matches above releases |
| `tests/cli/search-unified.test.ts` | Create | CLI roundtrip tests for unified search |

---

### Task 1: Define unified search types

**Files:**
- Modify: `src/api/types.ts:141-156`

- [ ] **Step 1: Replace SearchResult and SearchResponse types**

Open `src/api/types.ts` and replace the `// ── Search ──` section (lines 141-156) with:

```typescript
// ── Search ──

export interface SearchOrgHit {
  slug: string;
  name: string;
  domain: string | null;
  avatarUrl: string | null;
  category: string | null;
}

export interface SearchProductHit {
  slug: string;
  name: string;
  orgSlug: string | null;
  orgName: string | null;
  category: string | null;
}

export interface SearchSourceHit {
  slug: string;
  name: string;
  type: string;
  orgSlug: string | null;
  orgName: string | null;
  productSlug: string | null;
}

export interface SearchReleaseHit {
  sourceSlug: string;
  sourceName: string;
  orgSlug: string | null;
  version: string | null;
  title: string;
  summary: string;
  publishedAt: string | null;
}

export interface UnifiedSearchResponse {
  query: string;
  orgs: SearchOrgHit[];
  products: SearchProductHit[];
  sources: SearchSourceHit[];
  releases: SearchReleaseHit[];
}

/** @deprecated Use UnifiedSearchResponse */
export type SearchResult = SearchReleaseHit;
/** @deprecated Use UnifiedSearchResponse */
export interface SearchResponse {
  query: string;
  results: SearchResult[];
}
```

- [ ] **Step 2: Verify type-check passes**

Run: `npx tsc --noEmit`
Expected: Clean pass (deprecated aliases preserve backward compat)

- [ ] **Step 3: Commit**

```bash
git add src/api/types.ts
git commit -m "feat(search): define unified multi-type search response types"
```

---

### Task 2: Update the API worker search endpoint

**Files:**
- Modify: `workers/api/src/routes/search.ts`

- [ ] **Step 1: Rewrite the search route handler**

Replace the entire contents of `workers/api/src/routes/search.ts` with:

```typescript
import { Hono } from "hono";
import { sql } from "drizzle-orm";
import { createDb } from "../db.js";
import type { Env } from "../index.js";
import type {
  SearchOrgHit,
  SearchProductHit,
  SearchSourceHit,
  SearchReleaseHit,
} from "../../../../src/api/types.js";

export const searchRoutes = new Hono<Env>();

searchRoutes.get("/search", async (c) => {
  const q = c.req.query("q") ?? "";
  if (!q) {
    return c.json(
      { error: "bad_request", message: "Missing required query parameter: q" },
      400,
    );
  }

  const limit = parseInt(c.req.query("limit") ?? "20", 10);
  const offset = parseInt(c.req.query("offset") ?? "0", 10);
  const db = createDb(c.env.DB);
  const pattern = `%${q}%`;

  // Run entity LIKE queries and release FTS in parallel
  const [orgs, products, sources, releases] = await Promise.all([
    // ── Orgs: match on name, slug, domain ──
    db.all<SearchOrgHit>(sql`
      SELECT slug, name, domain, avatar_url as avatarUrl, category
      FROM organizations
      WHERE name LIKE ${pattern} OR slug LIKE ${pattern} OR domain LIKE ${pattern}
      ORDER BY name
      LIMIT ${limit}
    `),

    // ── Products: match on name, slug ──
    db.all<SearchProductHit>(sql`
      SELECT p.slug, p.name, o.slug as orgSlug, o.name as orgName, p.category
      FROM products p
      LEFT JOIN organizations o ON o.id = p.org_id
      WHERE p.name LIKE ${pattern} OR p.slug LIKE ${pattern}
      ORDER BY p.name
      LIMIT ${limit}
    `),

    // ── Sources: match on name, slug, URL ──
    db.all<SearchSourceHit>(sql`
      SELECT s.slug, s.name, s.type, o.slug as orgSlug, o.name as orgName,
             p.slug as productSlug
      FROM sources s
      LEFT JOIN organizations o ON o.id = s.org_id
      LEFT JOIN products p ON p.id = s.product_id
      WHERE (s.is_hidden = 0 OR s.is_hidden IS NULL)
        AND (s.name LIKE ${pattern} OR s.slug LIKE ${pattern} OR s.url LIKE ${pattern})
      ORDER BY s.name
      LIMIT ${limit}
    `),

    // ── Releases: FTS match ──
    (async () => {
      try {
        return await db.all<SearchReleaseHit>(sql`
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
          WHERE releases_fts MATCH ${q}
            AND (r.suppressed IS NULL OR r.suppressed = 0)
            AND (s.is_hidden = 0 OR s.is_hidden IS NULL)
          ORDER BY rank
          LIMIT ${limit}
          OFFSET ${offset}
        `);
      } catch {
        return [];
      }
    })(),
  ]);

  // ── Cascading enrichment: if orgs/products matched but releases didn't ──
  // include recent releases from matched entities
  if (releases.length === 0 && (orgs.length > 0 || products.length > 0)) {
    const orgSlugs = orgs.map((o) => o.slug);
    const productSlugs = products.map((p) => p.slug);

    if (orgSlugs.length > 0 || productSlugs.length > 0) {
      const cascaded = await db.all<SearchReleaseHit>(sql`
        SELECT
          s.slug as sourceSlug,
          s.name as sourceName,
          o.slug as orgSlug,
          r.version,
          r.title,
          COALESCE(r.content_summary, SUBSTR(r.content, 1, 150)) as summary,
          r.published_at as publishedAt
        FROM releases r
        JOIN sources s ON s.id = r.source_id
        LEFT JOIN organizations o ON o.id = s.org_id
        LEFT JOIN products p ON p.id = s.product_id
        WHERE (r.suppressed IS NULL OR r.suppressed = 0)
          AND (s.is_hidden = 0 OR s.is_hidden IS NULL)
          AND (o.slug IN (${sql.join(orgSlugs.map((s) => sql`${s}`), sql`, `)})
               OR p.slug IN (${sql.join(productSlugs.length > 0 ? productSlugs.map((s) => sql`${s}`) : [sql`''`], sql`, `)}))
        ORDER BY r.published_at DESC
        LIMIT ${limit}
      `);
      releases.push(...cascaded);
    }
  }

  return c.json({ query: q, orgs, products, sources, releases });
});
```

- [ ] **Step 2: Verify the worker type-checks**

Run: `cd workers/api && npx tsc --noEmit`
Expected: Clean pass

- [ ] **Step 3: Commit**

```bash
git add workers/api/src/routes/search.ts
git commit -m "feat(search): unified multi-type search endpoint with cascading enrichment"
```

---

### Task 3: Update the CLI API client

**Files:**
- Modify: `src/api/client.ts:197-206`
- Modify: `src/db/queries.ts:942-952`

- [ ] **Step 1: Add unifiedSearch to the API client**

In `src/api/client.ts`, find the `searchReleasesRemote` function (around line 197) and add a new function below it:

```typescript
export async function unifiedSearch(
  query: string,
  limit: number,
  opts?: { org?: string },
): Promise<UnifiedSearchResponse> {
  const params = new URLSearchParams({ q: query, limit: String(limit) });
  if (opts?.org) params.set("org", opts.org);
  return get<UnifiedSearchResponse>(`/api/search?${params}`);
}
```

Add the import for `UnifiedSearchResponse` to the existing import from `./types.js` at the top of the file.

- [ ] **Step 2: Add the remote-aware wrapper in queries.ts**

In `src/db/queries.ts`, below the existing `searchReleasesRemote` function (around line 952), add:

```typescript
export async function unifiedSearch(
  query: string,
  limit: number,
  opts?: { org?: string },
): Promise<import("../api/types.js").UnifiedSearchResponse> {
  return apiClient.unifiedSearch(query, limit, opts);
}
```

- [ ] **Step 3: Verify type-check passes**

Run: `npx tsc --noEmit`
Expected: Clean pass

- [ ] **Step 4: Commit**

```bash
git add src/api/client.ts src/db/queries.ts
git commit -m "feat(search): add unified search client and query wrapper"
```

---

### Task 4: Update the local FTS path

**Files:**
- Modify: `src/db/fts.ts:42-79`

The local-mode FTS function `searchReleasesForApi` is used by the local API server (`src/api/routes/search.ts`). Update it to return the unified shape.

- [ ] **Step 1: Rewrite searchReleasesForApi to return unified shape**

In `src/db/fts.ts`, replace the `searchReleasesForApi` function and its `SearchApiResult` interface (lines 42-79) with:

```typescript
export interface LocalUnifiedSearchResult {
  orgs: Array<{ slug: string; name: string; domain: string | null; avatarUrl: string | null; category: string | null }>;
  products: Array<{ slug: string; name: string; orgSlug: string | null; orgName: string | null; category: string | null }>;
  sources: Array<{ slug: string; name: string; type: string; orgSlug: string | null; orgName: string | null; productSlug: string | null }>;
  releases: Array<{ sourceSlug: string; sourceName: string; orgSlug: string | null; version: string | null; title: string; summary: string; publishedAt: string | null }>;
}

export function unifiedSearchLocal(query: string, limit: number, offset: number): LocalUnifiedSearchResult {
  if (isRemoteMode()) {
    throw new Error("unifiedSearchLocal() is not available in remote mode");
  }
  const db = getDb();
  const pattern = `%${query}%`;

  const orgs = db.all(sql`
    SELECT slug, name, domain, avatar_url as avatarUrl, category
    FROM organizations
    WHERE name LIKE ${pattern} OR slug LIKE ${pattern} OR domain LIKE ${pattern}
    ORDER BY name LIMIT ${limit}
  `) as LocalUnifiedSearchResult["orgs"];

  const products = db.all(sql`
    SELECT p.slug, p.name, o.slug as orgSlug, o.name as orgName, p.category
    FROM products p LEFT JOIN organizations o ON o.id = p.org_id
    WHERE p.name LIKE ${pattern} OR p.slug LIKE ${pattern}
    ORDER BY p.name LIMIT ${limit}
  `) as LocalUnifiedSearchResult["products"];

  const sources = db.all(sql`
    SELECT s.slug, s.name, s.type, o.slug as orgSlug, o.name as orgName, p.slug as productSlug
    FROM sources s
    LEFT JOIN organizations o ON o.id = s.org_id
    LEFT JOIN products p ON p.id = s.product_id
    WHERE (s.is_hidden = 0 OR s.is_hidden IS NULL)
      AND (s.name LIKE ${pattern} OR s.slug LIKE ${pattern} OR s.url LIKE ${pattern})
    ORDER BY s.name LIMIT ${limit}
  `) as LocalUnifiedSearchResult["sources"];

  let releases: LocalUnifiedSearchResult["releases"] = [];
  try {
    releases = db.all(sql`
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
    `) as LocalUnifiedSearchResult["releases"];
  } catch (err) {
    logger.warn(`FTS search failed: ${err instanceof Error ? err.message : err}`);
  }

  // Cascading enrichment
  if (releases.length === 0 && (orgs.length > 0 || products.length > 0)) {
    const orgSlugs = orgs.map((o) => o.slug);
    const productSlugs = products.map((p) => p.slug);
    if (orgSlugs.length > 0 || productSlugs.length > 0) {
      const placeholders = [...orgSlugs, ...productSlugs];
      if (placeholders.length > 0) {
        releases = db.all(sql`
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
            AND (o.slug IN (${sql.join(orgSlugs.map((s) => sql`${s}`), sql`, `)})
                 OR p.slug IN (${sql.join(productSlugs.length > 0 ? productSlugs.map((s) => sql`${s}`) : [sql`''`], sql`, `)}))
          ORDER BY r.published_at DESC LIMIT ${limit}
        `) as LocalUnifiedSearchResult["releases"];
      }
    }
  }

  return { orgs, products, sources, releases };
}
```

Keep the existing `searchReleases` function (lines 15-39) intact — it's used by the CLI in local mode for the old path and will be removed in a later cleanup.

- [ ] **Step 2: Update the local API route to use unified search**

In `src/api/routes/search.ts`, replace the entire file with:

```typescript
import { unifiedSearchLocal } from "../../db/fts.js";

export function handleSearch(q: string, limit: number, offset: number) {
  return { query: q, ...unifiedSearchLocal(q, limit, offset) };
}
```

- [ ] **Step 3: Verify type-check passes**

Run: `npx tsc --noEmit`
Expected: Clean pass

- [ ] **Step 4: Commit**

```bash
git add src/db/fts.ts src/api/routes/search.ts
git commit -m "feat(search): unified local search with entity matching and cascading enrichment"
```

---

### Task 5: Update the CLI search command

**Files:**
- Modify: `src/cli/commands/search.ts`

- [ ] **Step 1: Rewrite the search command for unified results**

Replace the entire contents of `src/cli/commands/search.ts` with:

```typescript
import { Command } from "commander";
import chalk from "chalk";
import { unifiedSearch } from "../../db/queries.js";
import { unifiedSearchLocal } from "../../db/fts.js";
import { isRemoteMode } from "../../lib/mode.js";
import { stripAnsi } from "../../lib/sanitize.js";
import type { UnifiedSearchResponse } from "../../api/types.js";

export function registerSearchCommand(program: Command) {
  program
    .command("search")
    .description("Search across organizations, products, sources, and releases")
    .argument("<query>", "Search query")
    .option("-l, --limit <n>", "Max results per type", "10")
    .option("--type <type>", "Limit to a result type: orgs, products, sources, releases")
    .option("--json", "Output as JSON")
    .addHelpText("after", `
Examples:
  released search "vercel"
  released search "breaking change" --type releases
  released search "authentication" --limit 5 --json`)
    .action(async (query: string, opts: { limit: string; type?: string; json?: boolean }) => {
      const limit = parseInt(opts.limit, 10);

      let response: UnifiedSearchResponse;
      if (isRemoteMode()) {
        response = await unifiedSearch(query, limit);
      } else {
        const local = unifiedSearchLocal(query, limit, 0);
        response = { query, ...local };
      }

      // Filter to specific type if requested
      const types = opts.type
        ? [opts.type as keyof Omit<UnifiedSearchResponse, "query">]
        : (["orgs", "products", "sources", "releases"] as const);

      if (opts.json) {
        const filtered: Record<string, unknown> = { query: response.query };
        for (const t of types) filtered[t] = response[t];
        console.log(JSON.stringify(filtered, null, 2));
        return;
      }

      let totalResults = 0;

      // ── Orgs ──
      if (types.includes("orgs") && response.orgs.length > 0) {
        console.log(chalk.bold.underline("Organizations"));
        for (const org of response.orgs) {
          const meta = [org.category, org.domain].filter(Boolean).join(" | ");
          console.log(`  ${chalk.cyan.bold(stripAnsi(org.name))} ${chalk.dim(`(${org.slug})`)}`);
          if (meta) console.log(`  ${chalk.dim(meta)}`);
        }
        console.log();
        totalResults += response.orgs.length;
      }

      // ── Products ──
      if (types.includes("products") && response.products.length > 0) {
        console.log(chalk.bold.underline("Products"));
        for (const p of response.products) {
          const org = p.orgName ? ` ${chalk.dim(`by ${stripAnsi(p.orgName)}`)}` : "";
          console.log(`  ${chalk.cyan.bold(stripAnsi(p.name))} ${chalk.dim(`(${p.slug})`)}${org}`);
        }
        console.log();
        totalResults += response.products.length;
      }

      // ── Sources ──
      if (types.includes("sources") && response.sources.length > 0) {
        console.log(chalk.bold.underline("Sources"));
        for (const s of response.sources) {
          const org = s.orgName ? ` ${chalk.dim(`— ${stripAnsi(s.orgName)}`)}` : "";
          console.log(`  ${chalk.cyan.bold(stripAnsi(s.name))} ${chalk.dim(`(${s.slug})`)}${org}`);
        }
        console.log();
        totalResults += response.sources.length;
      }

      // ── Releases ──
      if (types.includes("releases") && response.releases.length > 0) {
        console.log(chalk.bold.underline("Releases"));
        for (const r of response.releases) {
          console.log(`  ${chalk.cyan.bold(stripAnsi(r.title))}`);
          console.log(chalk.dim(`  Source: ${stripAnsi(r.sourceName)}  |  Published: ${r.publishedAt ?? "No date"}`));
          const summary = stripAnsi(r.summary);
          console.log(`  ${summary}${summary.length >= 150 ? "..." : ""}`);
          console.log();
        }
        totalResults += response.releases.length;
      }

      if (totalResults === 0) {
        console.log(chalk.yellow("No results found."));
      } else {
        console.log(chalk.dim(`${totalResults} result(s) found.`));
      }
    });
}
```

- [ ] **Step 2: Verify type-check passes**

Run: `npx tsc --noEmit`
Expected: Clean pass

- [ ] **Step 3: Smoke test locally**

Run: `bun src/index.ts search "test" --json`
Expected: JSON output with `query`, `orgs`, `products`, `sources`, `releases` keys

- [ ] **Step 4: Commit**

```bash
git add src/cli/commands/search.ts
git commit -m "feat(search): CLI displays unified search results across entity types"
```

---

### Task 6: Update the web app

**Files:**
- Modify: `web/src/lib/api.ts`
- Modify: `web/src/app/search/page.tsx`

- [ ] **Step 1: Update the web API client type**

In `web/src/lib/api.ts`, update the import to include `UnifiedSearchResponse`:

```typescript
import type {
  Stats, OrgListItem, OrgDetail, SourceListItem, SourceDetail,
  SearchResponse, UnifiedSearchResponse, SourceActivity, OrgActivity,
  OrgReleasesResponse, ReleaseDetail, ProductDetail,
} from "@shared/api/types";
```

Then update the `search` method in the `api` object:

```typescript
  search: (q: string, limit = 20, offset = 0) =>
    fetchApi<UnifiedSearchResponse>(`/api/search?q=${encodeURIComponent(q)}&limit=${limit}&offset=${offset}`),
```

Also export the new types so page components can use them:

```typescript
export type {
  ReleaseSummaryItem,
  ReleaseItem,
  SearchReleaseHit,
  SearchOrgHit,
  SearchProductHit,
  SearchSourceHit,
  OrgReleaseItem,
} from "@shared/api/types";
```

- [ ] **Step 2: Update the search page to render all result types**

Replace the entire contents of `web/src/app/search/page.tsx` with:

```typescript
import type { Metadata } from "next";
import { api } from "@/lib/api";
import { Header } from "@/components/header";
import { SearchBar } from "@/components/search-bar";
import Link from "next/link";
import type { UnifiedSearchResponse } from "@shared/api/types";

export const metadata: Metadata = { title: "Search" };

export default async function SearchPage({
  searchParams,
}: {
  searchParams: Promise<{ q?: string }>;
}) {
  const { q } = await searchParams;

  let results: UnifiedSearchResponse | null = null;
  if (q && q.trim()) {
    try {
      results = await api.search(q);
    } catch {
      results = { query: q, orgs: [], products: [], sources: [], releases: [] };
    }
  }

  const hasResults =
    results &&
    (results.orgs.length > 0 ||
      results.products.length > 0 ||
      results.sources.length > 0 ||
      results.releases.length > 0);

  return (
    <div className="min-h-screen">
      <Header />
      <div className="max-w-2xl mx-auto px-6 pt-12 pb-12">
        <h1 className="text-2xl font-semibold mb-6">Search</h1>
        <SearchBar defaultValue={q} />

        {results && !hasResults && (
          <p className="mt-8 text-stone-500">No results for &ldquo;{q}&rdquo;</p>
        )}

        {results && hasResults && (
          <div className="mt-8 space-y-8">
            {/* ── Orgs ── */}
            {results.orgs.length > 0 && (
              <section>
                <h2 className="text-xs font-medium uppercase tracking-wider text-stone-400 mb-3">
                  Organizations
                </h2>
                <div className="space-y-2">
                  {results.orgs.map((org) => (
                    <Link
                      key={org.slug}
                      href={`/${org.slug}`}
                      className="block p-3 rounded-lg border border-stone-200 dark:border-stone-800 hover:bg-stone-50 dark:hover:bg-stone-900 transition-colors"
                    >
                      <span className="font-medium">{org.name}</span>
                      {org.category && (
                        <span className="ml-2 text-xs text-stone-400">{org.category}</span>
                      )}
                      {org.domain && (
                        <span className="ml-2 text-xs text-stone-400">{org.domain}</span>
                      )}
                    </Link>
                  ))}
                </div>
              </section>
            )}

            {/* ── Products ── */}
            {results.products.length > 0 && (
              <section>
                <h2 className="text-xs font-medium uppercase tracking-wider text-stone-400 mb-3">
                  Products
                </h2>
                <div className="space-y-2">
                  {results.products.map((p) => (
                    <Link
                      key={p.slug}
                      href={p.orgSlug ? `/${p.orgSlug}/product/${p.slug}` : `/product/${p.slug}`}
                      className="block p-3 rounded-lg border border-stone-200 dark:border-stone-800 hover:bg-stone-50 dark:hover:bg-stone-900 transition-colors"
                    >
                      <span className="font-medium">{p.name}</span>
                      {p.orgName && (
                        <span className="ml-2 text-xs text-stone-400">by {p.orgName}</span>
                      )}
                    </Link>
                  ))}
                </div>
              </section>
            )}

            {/* ── Sources ── */}
            {results.sources.length > 0 && (
              <section>
                <h2 className="text-xs font-medium uppercase tracking-wider text-stone-400 mb-3">
                  Sources
                </h2>
                <div className="space-y-2">
                  {results.sources.map((s) => {
                    const href = s.orgSlug ? `/${s.orgSlug}/${s.slug}` : `/source/${s.slug}`;
                    return (
                      <Link
                        key={s.slug}
                        href={href}
                        className="block p-3 rounded-lg border border-stone-200 dark:border-stone-800 hover:bg-stone-50 dark:hover:bg-stone-900 transition-colors"
                      >
                        <span className="font-medium">{s.name}</span>
                        {s.orgName && (
                          <span className="ml-2 text-xs text-stone-400">{s.orgName}</span>
                        )}
                        <span className="ml-2 text-xs text-stone-400">{s.type}</span>
                      </Link>
                    );
                  })}
                </div>
              </section>
            )}

            {/* ── Releases ── */}
            {results.releases.length > 0 && (
              <section>
                <h2 className="text-xs font-medium uppercase tracking-wider text-stone-400 mb-3">
                  Releases
                </h2>
                <div className="space-y-4">
                  {results.releases.map((r, i) => {
                    const href = r.orgSlug
                      ? `/${r.orgSlug}/${r.sourceSlug}`
                      : `/source/${r.sourceSlug}`;
                    return (
                      <div
                        key={i}
                        className="border-b border-stone-200 dark:border-stone-800 pb-4"
                      >
                        <div className="flex flex-col sm:flex-row sm:justify-between sm:items-baseline gap-1">
                          <div className="flex items-baseline gap-2">
                            {r.version && (
                              <span className="text-sm font-semibold">{r.version}</span>
                            )}
                            <span className="text-sm text-stone-600 dark:text-stone-400">
                              {r.title}
                            </span>
                          </div>
                          {r.publishedAt && (
                            <time className="text-xs text-stone-400 shrink-0">
                              {new Date(r.publishedAt).toLocaleDateString("en-US", {
                                month: "short",
                                day: "numeric",
                                year: "numeric",
                              })}
                            </time>
                          )}
                        </div>
                        <p className="text-[13px] text-stone-500 mt-1 line-clamp-2">
                          {r.summary}
                        </p>
                        <Link
                          href={href}
                          className="text-xs text-stone-400 hover:text-stone-600 mt-1 inline-block"
                        >
                          {r.sourceName}
                        </Link>
                      </div>
                    );
                  })}
                </div>
              </section>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
```

- [ ] **Step 3: Verify type-check passes**

Run: `cd web && npx tsc --noEmit`
Expected: Clean pass

- [ ] **Step 4: Commit**

```bash
git add web/src/lib/api.ts web/src/app/search/page.tsx
git commit -m "feat(search): web app renders unified search with org/product/source sections"
```

---

### Task 7: CLI roundtrip tests

**Files:**
- Create: `tests/cli/search-unified.test.ts`

- [ ] **Step 1: Write the test file**

Create `tests/cli/search-unified.test.ts`:

```typescript
import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { createTempDataDir, cli, cliJson } from "./roundtrip-helper.js";

describe("unified search", () => {
  let dataDir: string;
  let cleanup: () => void;

  beforeAll(() => {
    ({ dataDir, cleanup } = createTempDataDir());
    // Seed data
    for (const args of [
      ["org", "add", "Vercel", "--category", "cloud"],
      ["org", "add", "Anthropic", "--category", "ai"],
      ["product", "add", "Next.js", "--org", "vercel"],
      ["add", "Vercel Blog", "--url", "https://vercel.com/changelog", "--org", "vercel", "--skip-eval"],
    ]) {
      const r = cli(dataDir, args);
      if (r.exitCode !== 0) throw new Error(`Seed failed (${args.join(" ")}): ${r.stderr}`);
    }
  });

  afterAll(() => cleanup());

  it("returns orgs matching by name", () => {
    const result = cliJson<{ orgs: { slug: string }[] }>(dataDir, [
      "search", "vercel", "--json",
    ]);
    expect(result.orgs.length).toBeGreaterThan(0);
    expect(result.orgs[0].slug).toBe("vercel");
  });

  it("returns products matching by name", () => {
    const result = cliJson<{ products: { slug: string }[] }>(dataDir, [
      "search", "next", "--json",
    ]);
    expect(result.products.length).toBeGreaterThan(0);
    expect(result.products[0].slug).toBe("next-js");
  });

  it("returns sources matching by name", () => {
    const result = cliJson<{ sources: { slug: string }[] }>(dataDir, [
      "search", "vercel blog", "--json",
    ]);
    expect(result.sources.length).toBeGreaterThan(0);
    expect(result.sources[0].slug).toBe("vercel-blog");
  });

  it("filters to a single type with --type", () => {
    const result = cliJson<Record<string, unknown>>(dataDir, [
      "search", "vercel", "--type", "orgs", "--json",
    ]);
    expect(result.orgs).toBeDefined();
    expect(result.products).toBeUndefined();
    expect(result.releases).toBeUndefined();
  });

  it("returns empty gracefully", () => {
    const result = cliJson<{ orgs: unknown[]; products: unknown[]; sources: unknown[]; releases: unknown[] }>(
      dataDir,
      ["search", "zzzznonexistent", "--json"],
    );
    expect(result.orgs).toEqual([]);
    expect(result.products).toEqual([]);
    expect(result.sources).toEqual([]);
    expect(result.releases).toEqual([]);
  });

  it("text output shows section headers", () => {
    const result = cli(dataDir, ["search", "vercel"]);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("Organizations");
    expect(result.stdout).toContain("Sources");
  });

  it("text output shows no results message", () => {
    const result = cli(dataDir, ["search", "zzzznonexistent"]);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("No results");
  });
});
```

- [ ] **Step 2: Run the tests**

Run: `bun test tests/cli/search-unified.test.ts`
Expected: All 7 tests pass

- [ ] **Step 3: Commit**

```bash
git add tests/cli/search-unified.test.ts
git commit -m "test: add CLI roundtrip tests for unified search"
```

---

### Task 8: Clean up deprecated code paths

**Files:**
- Modify: `src/db/fts.ts` (remove old `SearchApiResult` interface if no longer imported)
- Modify: `src/db/queries.ts` (remove `searchReleasesRemote` if no longer called)

- [ ] **Step 1: Check for remaining references to old search functions**

Run: `grep -rn "searchReleasesRemote\|searchReleasesForApi\|SearchApiResult" src/ --include="*.ts"`

Remove any functions and types that are no longer imported anywhere. Keep the `searchReleases` function in `fts.ts` — it's still used by the old local-mode CLI path and can be removed in a future cleanup.

- [ ] **Step 2: Verify type-check passes**

Run: `npx tsc --noEmit`
Expected: Clean pass

- [ ] **Step 3: Run full test suite**

Run: `bun test`
Expected: All tests pass, including the existing `search-edge-cases.test.ts` (the empty-db JSON test will need updating since the shape changed from `[]` to `{ query, orgs: [], ... }`)

- [ ] **Step 4: Update the existing search edge-case test**

In `tests/cli/search-edge-cases.test.ts`, update the first test (line 14-18):

```typescript
  it("search returns empty results gracefully (JSON)", () => {
    const results = cliJson<{ orgs: unknown[]; releases: unknown[] }>(dataDir, [
      "search", "anything", "--json",
    ]);
    expect(results.orgs).toEqual([]);
    expect(results.releases).toEqual([]);
  });
```

- [ ] **Step 5: Run full test suite again**

Run: `bun test`
Expected: All tests pass

- [ ] **Step 6: Commit**

```bash
git add src/db/fts.ts src/db/queries.ts tests/cli/search-edge-cases.test.ts
git commit -m "refactor(search): remove deprecated single-type search code paths"
```
