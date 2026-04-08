# CLI Remote Mode Migration Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make all CLI commands work equally in local (SQLite) and remote (D1 via API) modes by routing all database operations through `src/db/queries.ts` helpers.

**Architecture:** Each CLI command currently calls `getDb()` directly for Drizzle queries, which throws in remote mode. The fix is to add query helper functions in `queries.ts` that check `isRemoteMode()` and delegate to `src/api/client.ts` methods. Missing API routes are added to `workers/api/src/routes/`. Each command is migrated independently.

**Tech Stack:** TypeScript, Drizzle ORM, Hono (API worker), Commander (CLI)

**Pattern:** Every command follows the same migration pattern:
1. Identify all `getDb()` / direct Drizzle calls in the command
2. Add any missing API routes to the worker (if the operation isn't already exposed)
3. Add corresponding API client methods in `src/api/client.ts`
4. Add query helpers in `src/db/queries.ts` with `isRemoteMode()` branching
5. Replace direct DB calls in the command with query helper calls
6. Remove `getDb()` import from the command
7. Run `npx tsc --noEmit` to verify
8. Commit

**Existing infrastructure:**
- API routes exist for: GET/POST/PATCH/DELETE sources, GET/POST/PATCH/DELETE orgs, org accounts, ignored/blocked URLs, search, stats, fetch-log, usage-log, releases (insert, suppress, unsuppress)
- Query helpers exist for: findSourceBySlug, findOrg, getSourcesByOrg, listOrgs, createSource, findSourcesByUrls, ignored/blocked URLs, checkContentHash, listSourcesWithOrg, getStatsSummary, getFetchLogs, getLatestReleases, createOrg, removeOrg, org accounts, suppress/unsuppress, searchReleasesRemote, insertFetchLog

---

### Task 1: Migrate `fetch.ts` (highest priority)

**Files:**
- Modify: `workers/api/src/routes/sources.ts` — add fetch-specific query endpoints
- Modify: `src/api/client.ts` — add client methods for new endpoints
- Modify: `src/db/queries.ts` — add query helpers
- Modify: `src/cli/commands/fetch.ts` — replace all `getDb()` calls

The fetch command needs these operations that don't have remote support yet:

| Operation | Current code | Needed helper |
|---|---|---|
| Find source by slug | `db.select().from(sources).where(eq(sources.slug, slug))` | `findSourceBySlug()` — **already exists** |
| List all sources | `db.select().from(sources)` | `listAllSources()` — **new** |
| List unfetched sources | `sql\`lastFetchedAt IS NULL\`` | `listFetchableSources({ unfetched: true })` — **new** |
| List stale sources | Complex filter with backoff | `listFetchableSources({ staleHours: N })` — **new** |
| List errored sources | Subquery on fetch_log | `listFetchableSources({ retryErrors: true })` — **new** |
| Update source metadata | `db.update(sources).set({...})` | `updateSource(slug, data)` — **new** |
| Reload source by ID | `db.select().from(sources).where(eq(sources.id, id))` | `getSourceById(id)` — **new** |
| Delete releases for source | `db.delete(releases).where(...)` | `deleteReleasesForSource(sourceId)` — **new** |
| Count releases for source | `db.select({ total: count() }).from(releases)` | `countReleases(sourceId)` — **new** |
| Batch insert releases | `db.insert(releases).values([...]).onConflictDoNothing()` | `insertReleases(sourceId, rows)` — **new** |
| Update lastFetchedAt | `db.update(sources).set({ lastFetchedAt })` | Covered by `updateSource()` |
| Update backoff counters | `db.update(sources).set({ consecutiveNoChange, nextFetchAfter })` | Covered by `updateSource()` |

- [ ] **Step 1: Add `GET /sources/fetchable` route to worker**

In `workers/api/src/routes/sources.ts`, add a new route that returns sources filtered for fetching. This consolidates the unfetched/stale/retry-errors logic server-side:

```typescript
sourceRoutes.get("/sources/fetchable", async (c) => {
  const db = createDb(c.env.DB);
  const mode = c.req.query("mode"); // "unfetched" | "stale" | "retry_errors" | "all"
  const staleHours = c.req.query("staleHours");

  let rows: typeof sources.$inferSelect[];

  if (mode === "unfetched") {
    rows = await db.select().from(sources).where(sql`${sources.lastFetchedAt} IS NULL`);
  } else if (mode === "stale" && staleHours) {
    const hours = parseInt(staleHours, 10);
    const cutoff = new Date(Date.now() - hours * 3600_000).toISOString();
    const now = new Date().toISOString();
    rows = await db.select().from(sources).where(
      and(
        sql`(${sources.lastFetchedAt} IS NULL OR ${sources.lastFetchedAt} < ${cutoff})`,
        sql`(${sources.nextFetchAfter} IS NULL OR ${sources.nextFetchAfter} <= ${now})`,
        sql`${sources.fetchPriority} != 'paused'`
      )
    );
  } else if (mode === "retry_errors") {
    rows = await db.select().from(sources).where(
      sql`${sources.id} IN (
        SELECT f.source_id FROM fetch_log f
        WHERE f.id = (SELECT f2.id FROM fetch_log f2 WHERE f2.source_id = f.source_id ORDER BY f2.created_at DESC LIMIT 1)
        AND f.status = 'error'
      )`
    );
  } else {
    rows = await db.select().from(sources);
  }

  return c.json(rows);
});
```

IMPORTANT: This route must be registered BEFORE the `/sources/:slug` route, otherwise Express/Hono will match "fetchable" as a slug parameter. Move it above the `:slug` route or use a different path pattern.

- [ ] **Step 2: Add bulk operations routes to worker**

In `workers/api/src/routes/sources.ts`, add routes for operations the fetch command needs:

```typescript
// Bulk release insert (batch of releases for a source)
sourceRoutes.post("/sources/:slug/releases/batch", async (c) => {
  const db = createDb(c.env.DB);
  const slug = c.req.param("slug");
  const [src] = await db.select().from(sources).where(eq(sources.slug, slug));
  if (!src) return c.json({ error: "not_found" }, 404);

  const body = await c.req.json<{ releases: Array<{
    version?: string | null; title: string; content: string;
    url?: string | null; contentHash?: string; publishedAt?: string | null;
  }> }>();

  // Count before
  const [{ n: before }] = await db.select({ n: count() }).from(releases).where(eq(releases.sourceId, src.id));

  // Batch insert in chunks of 500
  for (let i = 0; i < body.releases.length; i += 500) {
    const chunk = body.releases.slice(i, i + 500).map((r) => ({
      sourceId: src.id,
      version: r.version ?? null,
      title: r.title,
      content: r.content,
      url: r.url ?? null,
      contentHash: r.contentHash ?? null,
      publishedAt: r.publishedAt ?? null,
    }));
    await db.insert(releases).values(chunk).onConflictDoNothing();
  }

  // Count after
  const [{ n: after }] = await db.select({ n: count() }).from(releases).where(eq(releases.sourceId, src.id));

  return c.json({ inserted: after - before, total: after });
});

// Delete all releases for a source (for --force re-fetch)
sourceRoutes.delete("/sources/:slug/releases", async (c) => {
  const db = createDb(c.env.DB);
  const slug = c.req.param("slug");
  const [src] = await db.select().from(sources).where(eq(sources.slug, slug));
  if (!src) return c.json({ error: "not_found" }, 404);

  const deleted = await db.delete(releases).where(eq(releases.sourceId, src.id)).returning();
  return c.json({ deleted: deleted.length });
});
```

- [ ] **Step 3: Add API client methods**

In `src/api/client.ts`, add:

```typescript
// ── Fetchable sources ──

export async function listFetchableSources(opts: {
  mode: "all" | "unfetched" | "stale" | "retry_errors";
  staleHours?: number;
}): Promise<Source[]> {
  const params = new URLSearchParams({ mode: opts.mode });
  if (opts.staleHours) params.set("staleHours", String(opts.staleHours));
  return apiFetch<Source[]>(`/api/sources/fetchable?${params}`);
}

export async function updateSource(slug: string, data: Record<string, unknown>): Promise<Source> {
  return apiFetch<Source>(`/api/sources/${slug}`, {
    method: "PATCH",
    body: JSON.stringify(data),
  });
}

export async function deleteSource(slug: string): Promise<void> {
  await apiFetch(`/api/sources/${slug}`, { method: "DELETE" });
}

export async function insertReleasesBatch(sourceSlug: string, releases: Array<{
  version?: string | null; title: string; content: string;
  url?: string | null; contentHash?: string; publishedAt?: string | null;
}>): Promise<{ inserted: number; total: number }> {
  return apiFetch(`/api/sources/${sourceSlug}/releases/batch`, {
    method: "POST",
    body: JSON.stringify({ releases }),
  });
}

export async function deleteReleasesForSource(sourceSlug: string): Promise<{ deleted: number }> {
  return apiFetch(`/api/sources/${sourceSlug}/releases`, { method: "DELETE" });
}
```

- [ ] **Step 4: Add query helpers in `queries.ts`**

```typescript
export async function listAllSources(): Promise<Source[]> {
  if (isRemoteMode()) {
    return apiClient.listFetchableSources({ mode: "all" });
  }
  const db = getDb();
  return db.select().from(sources);
}

export async function listFetchableSources(opts: {
  mode: "unfetched" | "stale" | "retry_errors";
  staleHours?: number;
}): Promise<Source[]> {
  if (isRemoteMode()) {
    return apiClient.listFetchableSources(opts);
  }
  const db = getDb();
  if (opts.mode === "unfetched") {
    return db.select().from(sources).where(sql`${sources.lastFetchedAt} IS NULL`);
  }
  if (opts.mode === "stale" && opts.staleHours) {
    const cutoff = new Date(Date.now() - opts.staleHours * 3600_000).toISOString();
    const now = new Date().toISOString();
    return db.select().from(sources).where(
      and(
        sql`(${sources.lastFetchedAt} IS NULL OR ${sources.lastFetchedAt} < ${cutoff})`,
        sql`(${sources.nextFetchAfter} IS NULL OR ${sources.nextFetchAfter} <= ${now})`,
        sql`${sources.fetchPriority} != 'paused'`
      )
    );
  }
  if (opts.mode === "retry_errors") {
    return db.select().from(sources).where(
      sql`${sources.id} IN (
        SELECT f.source_id FROM fetch_log f
        WHERE f.id = (SELECT f2.id FROM fetch_log f2 WHERE f2.source_id = f.source_id ORDER BY f2.created_at DESC LIMIT 1)
        AND f.status = 'error'
      )`
    );
  }
  return db.select().from(sources);
}

export async function getSourceById(id: string): Promise<Source | null> {
  if (isRemoteMode()) {
    // In remote mode, we need the slug. Sources in memory should have it.
    // This is only used for reloading after metadata updates.
    // The caller should use findSourceBySlug instead when possible.
    throw new Error("getSourceById not supported in remote mode — use findSourceBySlug");
  }
  const db = getDb();
  const [source] = await db.select().from(sources).where(eq(sources.id, id));
  return source ?? null;
}

export async function updateSource(source: Source, data: Record<string, unknown>): Promise<Source> {
  if (isRemoteMode()) {
    return apiClient.updateSource(source.slug, data);
  }
  const db = getDb();
  const [updated] = await db.update(sources).set(data).where(eq(sources.id, source.id)).returning();
  return updated;
}

export async function deleteReleasesForSource(source: Source): Promise<number> {
  if (isRemoteMode()) {
    const result = await apiClient.deleteReleasesForSource(source.slug);
    return result.deleted;
  }
  const db = getDb();
  const deleted = await db.delete(releases).where(eq(releases.sourceId, source.id)).returning();
  return deleted.length;
}

export async function countReleases(sourceId: string): Promise<number> {
  if (isRemoteMode()) {
    // The batch insert endpoint returns counts, so this is only needed locally
    throw new Error("countReleases not supported in remote mode — use insertReleasesBatch");
  }
  const db = getDb();
  const [{ n }] = await db.select({ n: count() }).from(releases).where(eq(releases.sourceId, sourceId));
  return n;
}

export async function insertReleases(source: Source, rows: Array<{
  sourceId: string; version: string | null; title: string; content: string;
  url: string | null; contentHash: string; publishedAt: string | null;
}>): Promise<number> {
  if (isRemoteMode()) {
    const result = await apiClient.insertReleasesBatch(source.slug, rows);
    return result.inserted;
  }
  const db = getDb();
  const [{ n: before }] = await db.select({ n: count() }).from(releases).where(eq(releases.sourceId, source.id));
  for (let i = 0; i < rows.length; i += 500) {
    await db.insert(releases).values(rows.slice(i, i + 500)).onConflictDoNothing();
  }
  const [{ n: after }] = await db.select({ n: count() }).from(releases).where(eq(releases.sourceId, source.id));
  return after - before;
}
```

- [ ] **Step 5: Refactor `fetch.ts` to use query helpers**

Replace every `getDb()` call and direct Drizzle query in `src/cli/commands/fetch.ts` with the corresponding query helper. Remove `getDb` and direct schema imports (`releases`). Keep the adapter calls (those don't use the DB).

Key replacements:
- `db.select().from(sources).where(eq(sources.slug, slug))` → `findSourceBySlug(slug)`
- `db.select().from(sources).where(sql\`lastFetchedAt IS NULL\`)` → `listFetchableSources({ mode: "unfetched" })`
- Complex stale query → `listFetchableSources({ mode: "stale", staleHours: hours })`
- Error retry subquery → `listFetchableSources({ mode: "retry_errors" })`
- `db.select().from(sources)` → `listAllSources()`
- `db.update(sources).set({...})` → `updateSource(source, data)`
- `db.delete(releases).where(...)` → `deleteReleasesForSource(source)`
- `db.insert(releases).values(rows)` + before/after counts → `insertReleases(source, rows)`
- `db.select().from(sources).where(eq(sources.id, id))` (reload) → `findSourceBySlug(source.slug)`
- `updateSourceMeta(source, {...})` — this helper already works with the source object in memory; verify it doesn't call getDb()

After refactoring, the imports should be:
```typescript
import {
  findSourceBySlug, listAllSources, listFetchableSources,
  updateSource, deleteReleasesForSource, insertReleases, insertFetchLog,
} from "../../db/queries.js";
```

Remove: `import { getDb } from "../../db/connection.js";` and `import { sources, releases, type Source } from "../../db/schema.js";` (keep `type Source` if still needed).

- [ ] **Step 6: Verify and commit**

```bash
npx tsc --noEmit
```

Then test:
```bash
source .env && RELEASED_API_URL=https://api.releases.sh bun src/index.ts fetch claude-code --dry-run
```

```bash
git add src/cli/commands/fetch.ts src/db/queries.ts src/api/client.ts workers/api/src/routes/sources.ts
git commit -m "feat: migrate fetch command to support remote mode"
```

---

### Task 2: Migrate `add.ts`

**Files:**
- Modify: `src/api/client.ts` — add `findOrgAccountByPlatformHandle()`
- Modify: `src/db/queries.ts` — add query helpers
- Modify: `src/cli/commands/add.ts` — replace getDb() calls

Operations needed:
- Find org account by platform+handle join → `getOrgAccountByPlatform()` **already exists**
- Create org → `createOrg()` **already exists**
- Create source → `createSource()` **already exists**
- `getDb()` is used for: org account lookup with join (lines 147, 174), org insert (line 157), source insert (line 218)

- [ ] **Step 1: Refactor `add.ts` to use existing query helpers**

The key operations are:
1. Looking up an org by GitHub handle → use `findOrg(handle)` (searches by account handle)
2. Creating an org → use `createOrg(name, opts)`
3. Creating a source → use `createSource(data)`

Replace the inline Drizzle queries with these existing helpers. The org account lookup with join can use `findOrg(handle)` since it already searches by account handle.

- [ ] **Step 2: Remove `getDb` import, verify, commit**

```bash
npx tsc --noEmit
git add src/cli/commands/add.ts
git commit -m "feat: migrate add command to support remote mode"
```

---

### Task 3: Migrate `remove.ts`

**Files:**
- Modify: `src/api/client.ts` — `deleteSource()` already added in Task 1
- Modify: `src/db/queries.ts` — add `deleteSources(slugs)`
- Modify: `src/cli/commands/remove.ts`

Operations needed:
- Find sources by slugs → new helper `findSourcesBySlugs(slugs[])`
- Delete sources by slugs → new helper `deleteSources(slugs[])`

- [ ] **Step 1: Add helpers**

In `queries.ts`:
```typescript
export async function findSourcesBySlugs(slugs: string[]): Promise<Source[]> {
  if (isRemoteMode()) {
    // Fetch each by slug (API doesn't have bulk slug lookup)
    const results = await Promise.all(slugs.map((s) => apiClient.findSourceBySlug(s)));
    return results.filter((s): s is Source => s !== null);
  }
  const db = getDb();
  return db.select().from(sources).where(inArray(sources.slug, slugs));
}

export async function deleteSources(slugs: string[]): Promise<void> {
  if (isRemoteMode()) {
    await Promise.all(slugs.map((s) => apiClient.deleteSource(s)));
    return;
  }
  const db = getDb();
  await db.delete(sources).where(inArray(sources.slug, slugs));
}
```

- [ ] **Step 2: Refactor `remove.ts`, verify, commit**

```bash
npx tsc --noEmit
git add src/cli/commands/remove.ts src/db/queries.ts
git commit -m "feat: migrate remove command to support remote mode"
```

---

### Task 4: Migrate `edit.ts`

**Files:**
- Modify: `src/db/queries.ts` — `updateSource()` already added in Task 1
- Modify: `src/cli/commands/edit.ts`

Operations needed:
- Find source by slug → `findSourceBySlug()` **already exists**
- Create org → `createOrg()` **already exists**
- Find org → `findOrg()` **already exists**
- Update source → `updateSource()` added in Task 1
- Reload source after update → `findSourceBySlug()` **already exists**

- [ ] **Step 1: Refactor `edit.ts` to use query helpers, remove getDb, verify, commit**

---

### Task 5: Migrate `check.ts`

**Files:**
- Modify: `src/cli/commands/check.ts`

Operations needed:
- List all sources → `listAllSources()` added in Task 1
- Find source by slug → `findSourceBySlug()` **already exists**

- [ ] **Step 1: Refactor `check.ts` to use query helpers, remove getDb, verify, commit**

---

### Task 6: Migrate `discover.ts`

**Files:**
- Modify: `src/cli/commands/discover.ts`

Operations needed:
- Find sources by URLs → `findSourcesByUrls()` **already exists**
- Insert source → `createSource()` **already exists**

- [ ] **Step 1: Refactor `discover.ts` to use query helpers, remove getDb, verify, commit**

---

### Task 7: Migrate `release.ts`

**Files:**
- Modify: `workers/api/src/routes/sources.ts` — add release CRUD routes
- Modify: `src/api/client.ts` — add release client methods
- Modify: `src/db/queries.ts` — add release query helpers
- Modify: `src/cli/commands/release.ts`

Operations needed:
- Show release with source join → new `getRelease(id)` helper + API route `GET /releases/:id`
- Delete release by ID → new `deleteRelease(id)` helper + API route `DELETE /releases/:id`
- Delete releases by source/date filter → new `deleteReleasesByFilter(...)` helper
- Edit release → new `updateRelease(id, data)` helper + API route `PATCH /releases/:id`
- Suppress/unsuppress → **already exist**

- [ ] **Step 1: Add API routes for release CRUD**

Add to `workers/api/src/routes/sources.ts`:
- `GET /releases/:id` — return release with source name/slug join
- `DELETE /releases/:id` — delete single release
- `PATCH /releases/:id` — update release fields

- [ ] **Step 2: Add client methods and query helpers**
- [ ] **Step 3: Refactor `release.ts`, remove getDb, verify, commit**

---

### Task 8: Migrate `onboard-apply.ts`

**Files:**
- Modify: `src/cli/commands/onboard-apply.ts`

Operations needed:
- Insert source → `createSource()` **already exists**
- Add ignored URL → `addIgnoredUrl()` **already exists**

- [ ] **Step 1: Refactor `onboard-apply.ts` to use query helpers, remove getDb, verify, commit**

---

### Task 9: Migrate `usage.ts`

**Files:**
- Modify: `src/api/client.ts` — add usage stats method
- Modify: `src/db/queries.ts` — add usage query helper
- Modify: `src/cli/commands/usage.ts`

Operations needed:
- Aggregate usage stats → new `getUsageStats(days)` helper + existing `GET /api/usage-log` or new endpoint

- [ ] **Step 1: Add API route for usage stats if needed**
- [ ] **Step 2: Add query helper, refactor `usage.ts`, verify, commit**

---

### Task 10: Migrate `search.ts` (local FTS path)

**Files:**
- Modify: `src/cli/commands/search.ts`

The remote path already works. The local FTS path uses getDb() for metadata hydration (lines 74-147). This only needs a guard:

- [ ] **Step 1: Add early guard for remote mode**

The search command already routes to `searchReleasesRemote()` in remote mode (line 27). Verify this works correctly and the local FTS path is never reached in remote mode. If there's a code path that falls through, add a guard.

- [ ] **Step 2: Verify and commit if changes needed**

---

### Task 11: Verify full remote mode

- [ ] **Step 1: Deploy updated worker**

```bash
cd workers/api && wrangler deploy
```

- [ ] **Step 2: Test each command in remote mode**

```bash
source .env && export RELEASED_API_URL=https://api.releases.sh

# Test each command
bun src/index.ts list
bun src/index.ts fetch claude-code --dry-run
bun src/index.ts stats
bun src/index.ts search "react"
bun src/index.ts latest
bun src/index.ts fetch-log
```

- [ ] **Step 3: Fix any issues found, commit**
