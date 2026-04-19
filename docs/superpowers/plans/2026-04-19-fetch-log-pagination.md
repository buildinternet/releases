# Fetch Log Pagination Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the status dashboard's 200-row fetch-log cap with cursor-based load-more plus accurate server-side status counts, so users can walk back through a full week (or longer) of fetch activity and the filter-pill counts reflect reality.

**Architecture:** `GET /v1/status/fetch-log` changes from a bare array to an envelope `{ entries, nextCursor, totalCount, statusCounts }`. `status` and `cursor` query params are added. Count queries run only when `cursor` is absent. The dashboard and org-scoped views replace numbered pagination + client-side filtering with a single `useFetchLog` hook that owns pagination state, server-driven filters, and optimistic count updates on WebSocket events.

**Tech Stack:** Cloudflare Worker + Hono (API), Drizzle ORM on D1/SQLite, Next.js/React with client components (web), Bun test runner.

**Spec:** [docs/superpowers/specs/2026-04-19-fetch-log-pagination-design.md](../specs/2026-04-19-fetch-log-pagination-design.md)

---

## File Structure

**Create:**

- `workers/api/src/routes/fetch-log-cursor.ts` — cursor encode/decode helpers, pure functions; testable without a DB.
- `tests/api/status-fetch-log.test.ts` — worker-side integration tests against an in-memory D1.
- `tests/api/status-fetch-log-helpers.ts` — test harness for the status route (mirrors `admin-cron-runs-helpers.ts`).
- `web/src/components/use-fetch-log.ts` — `useFetchLog` hook shared by the dashboard and org views.

**Modify:**

- `workers/api/src/routes/status.ts` — rewrite the `GET /v1/status/fetch-log` handler to return the envelope, accept `status`/`cursor`, and run count queries only when no cursor is present.
- `web/src/components/fetch-log-shared.tsx` — export the `FetchLogResponse` envelope type.
- `web/src/app/status/dashboard.tsx` — replace the hand-rolled `fetchLogs` state and `FetchLogTable` pagination with the new hook + load-more UX; keep WebSocket handler but make it bump counts optimistically.
- `web/src/components/org-fetch-log-view.tsx` — swap its bespoke `fetch()` for `useFetchLog` and adopt the same load-more UX.

**Untouched (explicitly):**

- `workers/api/src/routes/fetch-log.ts` — keeps its bare-array shape. This is the CLI-facing endpoint.
- `src/api/client.ts` — unchanged for the same reason.
- `tests/integration/fetch-log.test.ts` — CLI integration tests, unrelated.

---

## Task 1: Cursor helpers (pure functions, test-first)

**Files:**

- Create: `workers/api/src/routes/fetch-log-cursor.ts`
- Create: `tests/api/fetch-log-cursor.test.ts`

Tiny module with two pure functions: `encodeCursor({createdAt, id})` → base64url string, `decodeCursor(s)` → `{createdAt, id} | null`. Isolating the encoding means we can assert round-tripping without spinning up a DB.

- [ ] **Step 1: Write the failing test**

Create `tests/api/fetch-log-cursor.test.ts`:

```ts
import { describe, it, expect } from "bun:test";
import { encodeCursor, decodeCursor } from "../../workers/api/src/routes/fetch-log-cursor";

describe("fetch-log cursor helpers", () => {
  it("round-trips a cursor", () => {
    const c = { createdAt: "2026-04-18T21:12:04.001Z", id: "fl_abc123" };
    const token = encodeCursor(c);
    expect(typeof token).toBe("string");
    expect(token).not.toContain("|"); // opaque
    expect(decodeCursor(token)).toEqual(c);
  });

  it("returns null for malformed input", () => {
    expect(decodeCursor("")).toBeNull();
    expect(decodeCursor("not-base64-$$$")).toBeNull();
    expect(decodeCursor(btoa("missing-separator"))).toBeNull();
  });

  it("is URL-safe (no + / =)", () => {
    const c = { createdAt: "2026-04-18T21:12:04.001Z", id: "fl_abc123" };
    const token = encodeCursor(c);
    expect(token).not.toMatch(/[+/=]/);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/api/fetch-log-cursor.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write minimal implementation**

Create `workers/api/src/routes/fetch-log-cursor.ts`:

```ts
export interface CursorValue {
  createdAt: string;
  id: string;
}

function toBase64Url(s: string): string {
  // Workers have btoa; replace +/= to be URL-safe
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function fromBase64Url(s: string): string | null {
  try {
    const padded = s.replace(/-/g, "+").replace(/_/g, "/");
    const pad = padded.length % 4 === 0 ? "" : "=".repeat(4 - (padded.length % 4));
    return atob(padded + pad);
  } catch {
    return null;
  }
}

export function encodeCursor(v: CursorValue): string {
  return toBase64Url(`${v.createdAt}|${v.id}`);
}

export function decodeCursor(token: string): CursorValue | null {
  if (!token) return null;
  const raw = fromBase64Url(token);
  if (!raw) return null;
  const sep = raw.indexOf("|");
  if (sep <= 0 || sep === raw.length - 1) return null;
  const createdAt = raw.slice(0, sep);
  const id = raw.slice(sep + 1);
  if (!createdAt || !id) return null;
  return { createdAt, id };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test tests/api/fetch-log-cursor.test.ts`
Expected: PASS, 3 tests.

- [ ] **Step 5: Commit**

```bash
git add workers/api/src/routes/fetch-log-cursor.ts tests/api/fetch-log-cursor.test.ts
git commit -m "feat(api): cursor encode/decode helpers for fetch-log pagination"
```

---

## Task 2: Test harness for the status fetch-log route

**Files:**

- Create: `tests/api/status-fetch-log-helpers.ts`

Mirrors `tests/api/admin-cron-runs-helpers.ts`. Exposes `mkDb()` (in-memory SQLite with migrations applied) and `mkApp(db)` (a Hono app with `statusRoutes` mounted).

- [ ] **Step 1: Create the helper**

Create `tests/api/status-fetch-log-helpers.ts`:

```ts
import { Database } from "bun:sqlite";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { migrate } from "drizzle-orm/bun-sqlite/migrator";
import { Hono } from "hono";
import { statusRoutes } from "../../workers/api/src/routes/status";

export function mkDb() {
  const sqlite = new Database(":memory:");
  const db = drizzle(sqlite);
  migrate(db, { migrationsFolder: "src/db/migrations" });
  return db;
}

export function mkApp(db: any) {
  const app = new Hono();
  // statusRoutes expects createDb(c.env.DB) — provide a stub that returns our drizzle handle.
  app.use("*", async (c, next) => {
    (c as any).env = { DB: db };
    await next();
  });
  app.route("/v1", statusRoutes);
  return app;
}
```

- [ ] **Step 2: Verify the harness compiles**

Run: `npx tsc --noEmit`
Expected: no errors in this file. (Existing unrelated errors, if any, are fine — ensure none reference `status-fetch-log-helpers.ts`.)

Note: `statusRoutes`' handler currently calls `createDb(c.env.DB)`, which wraps a `D1Database`. In our in-memory test the drizzle handle is already constructed. To make the route testable we need one more change: let `createDb` be a no-op when passed an already-wrapped drizzle handle, or update the route to accept a pre-built `db`. The simplest path is a narrow check inside `createDb` itself — addressed in Task 3, Step 2.

- [ ] **Step 3: Commit**

```bash
git add tests/api/status-fetch-log-helpers.ts
git commit -m "test(api): harness for status fetch-log route"
```

---

## Task 3: Status fetch-log envelope — failing test

**Files:**

- Create: `tests/api/status-fetch-log.test.ts`
- Modify: `workers/api/src/db.ts` (if `createDb` needs to accept pre-built drizzle handles)

Write the integration tests first. They will drive the route rewrite.

- [ ] **Step 1: Inspect `workers/api/src/db.ts`**

Run: `cat workers/api/src/db.ts`
Expected: shows the `createDb` helper. We need to know its signature before patching it.

- [ ] **Step 2: Allow `createDb` to accept pre-built drizzle handles**

Open `workers/api/src/db.ts`. At the top of `createDb`, add a passthrough:

```ts
// Allow tests to pass a pre-built drizzle handle.
if (dbOrD1 && typeof (dbOrD1 as any).select === "function") {
  return dbOrD1 as ReturnType<typeof drizzle>;
}
```

Rename the parameter from `d1` (or whatever it is) to `dbOrD1` and widen the type to `D1Database | ReturnType<typeof drizzle>`. Keep existing callers working — they pass `D1Database` which has no `.select`.

- [ ] **Step 3: Write the failing tests**

Create `tests/api/status-fetch-log.test.ts`:

```ts
import { describe, it, expect } from "bun:test";
import { sources, organizations, fetchLog } from "@buildinternet/releases-core/schema";
import { decodeCursor } from "../../workers/api/src/routes/fetch-log-cursor";
import { mkDb, mkApp } from "./status-fetch-log-helpers";

type Envelope = {
  entries: Array<{ id: string; status: string; createdAt: string }>;
  nextCursor: string | null;
  totalCount?: number;
  statusCounts?: { success: number; error: number; no_change: number; dry_run: number };
};

async function seed(
  db: any,
  count: number,
  status: "success" | "error" | "no_change" | "dry_run" = "success",
) {
  await db.insert(organizations).values({ id: "org_1", name: "Acme", slug: "acme" });
  await db
    .insert(sources)
    .values({ id: "src_1", name: "S", slug: "s", type: "feed", url: "https://x", orgId: "org_1" });
  const rows = Array.from({ length: count }, (_, i) => ({
    id: `fl_${String(i).padStart(4, "0")}`,
    sourceId: "src_1",
    releasesFound: 0,
    releasesInserted: 0,
    status,
    createdAt: new Date(Date.UTC(2026, 3, 1, 0, 0, i)).toISOString(),
  }));
  await db.insert(fetchLog).values(rows);
}

describe("GET /v1/status/fetch-log", () => {
  it("returns envelope with entries, nextCursor, totalCount, statusCounts", async () => {
    const db = mkDb();
    await seed(db, 5);
    const app = mkApp(db);
    const res = await app.request("/v1/status/fetch-log?limit=3");
    expect(res.status).toBe(200);
    const body = (await res.json()) as Envelope;
    expect(body.entries.length).toBe(3);
    expect(body.totalCount).toBe(5);
    expect(body.statusCounts).toEqual({ success: 5, error: 0, no_change: 0, dry_run: 0 });
    expect(body.nextCursor).not.toBeNull();
  });

  it("paginates via cursor until nextCursor is null", async () => {
    const db = mkDb();
    await seed(db, 5);
    const app = mkApp(db);
    const first = (await (await app.request("/v1/status/fetch-log?limit=3")).json()) as Envelope;
    expect(first.nextCursor).not.toBeNull();
    const second = (await (
      await app.request(
        `/v1/status/fetch-log?limit=3&cursor=${encodeURIComponent(first.nextCursor!)}`,
      )
    ).json()) as Envelope;
    expect(second.entries.length).toBe(2);
    expect(second.nextCursor).toBeNull();
    // No overlap between pages.
    const ids1 = first.entries.map((e) => e.id);
    const ids2 = second.entries.map((e) => e.id);
    expect(ids1.some((i) => ids2.includes(i))).toBe(false);
  });

  it("omits totalCount and statusCounts on cursor pages", async () => {
    const db = mkDb();
    await seed(db, 5);
    const app = mkApp(db);
    const first = (await (await app.request("/v1/status/fetch-log?limit=3")).json()) as Envelope;
    const second = (await (
      await app.request(
        `/v1/status/fetch-log?limit=3&cursor=${encodeURIComponent(first.nextCursor!)}`,
      )
    ).json()) as Envelope;
    expect(second.totalCount).toBeUndefined();
    expect(second.statusCounts).toBeUndefined();
  });

  it("filters entries by status but totalCount/statusCounts reflect full scope", async () => {
    const db = mkDb();
    await db.insert(organizations).values({ id: "org_1", name: "A", slug: "a" });
    await db.insert(sources).values({
      id: "src_1",
      name: "S",
      slug: "s",
      type: "feed",
      url: "https://x",
      orgId: "org_1",
    });
    await db.insert(fetchLog).values([
      {
        id: "fl_1",
        sourceId: "src_1",
        releasesFound: 0,
        releasesInserted: 0,
        status: "success",
        createdAt: "2026-04-01T00:00:00Z",
      },
      {
        id: "fl_2",
        sourceId: "src_1",
        releasesFound: 0,
        releasesInserted: 0,
        status: "success",
        createdAt: "2026-04-01T00:00:01Z",
      },
      {
        id: "fl_3",
        sourceId: "src_1",
        releasesFound: 0,
        releasesInserted: 0,
        status: "error",
        createdAt: "2026-04-01T00:00:02Z",
        error: "boom",
      },
    ]);
    const app = mkApp(db);
    const res = (await (
      await app.request("/v1/status/fetch-log?status=error&limit=10")
    ).json()) as Envelope;
    expect(res.entries.length).toBe(1);
    expect(res.entries[0].status).toBe("error");
    expect(res.totalCount).toBe(3); // full scope, not filtered
    expect(res.statusCounts).toEqual({ success: 2, error: 1, no_change: 0, dry_run: 0 });
  });

  it("emits a valid next cursor pointing at the last returned row", async () => {
    const db = mkDb();
    await seed(db, 3);
    const app = mkApp(db);
    const body = (await (await app.request("/v1/status/fetch-log?limit=2")).json()) as Envelope;
    const decoded = decodeCursor(body.nextCursor!);
    expect(decoded).not.toBeNull();
    const last = body.entries[body.entries.length - 1];
    expect(decoded!.id).toBe(last.id);
    expect(decoded!.createdAt).toBe(last.createdAt);
  });

  it("respects after/before and org filters in counts", async () => {
    const db = mkDb();
    await db.insert(organizations).values([
      { id: "org_1", name: "Acme", slug: "acme" },
      { id: "org_2", name: "Other", slug: "other" },
    ]);
    await db.insert(sources).values([
      { id: "src_1", name: "S1", slug: "s1", type: "feed", url: "https://a", orgId: "org_1" },
      { id: "src_2", name: "S2", slug: "s2", type: "feed", url: "https://b", orgId: "org_2" },
    ]);
    await db.insert(fetchLog).values([
      {
        id: "fl_1",
        sourceId: "src_1",
        releasesFound: 0,
        releasesInserted: 0,
        status: "success",
        createdAt: "2026-04-01T00:00:00Z",
      },
      {
        id: "fl_2",
        sourceId: "src_2",
        releasesFound: 0,
        releasesInserted: 0,
        status: "success",
        createdAt: "2026-04-01T00:00:01Z",
      },
      {
        id: "fl_3",
        sourceId: "src_1",
        releasesFound: 0,
        releasesInserted: 0,
        status: "error",
        createdAt: "2026-03-01T00:00:00Z",
      },
    ]);
    const app = mkApp(db);
    const body = (await (
      await app.request("/v1/status/fetch-log?org=acme&after=2026-03-15T00:00:00Z")
    ).json()) as Envelope;
    expect(body.totalCount).toBe(1);
    expect(body.entries.map((e) => e.id)).toEqual(["fl_1"]);
  });
});
```

- [ ] **Step 4: Run tests to verify they fail**

Run: `bun test tests/api/status-fetch-log.test.ts`
Expected: FAIL — current route returns a bare array, no `entries`/`nextCursor`/`totalCount`/`statusCounts`.

- [ ] **Step 5: Commit the failing tests**

```bash
git add tests/api/status-fetch-log.test.ts workers/api/src/db.ts
git commit -m "test(api): failing tests for status fetch-log envelope + pagination"
```

---

## Task 4: Status fetch-log envelope — make tests pass

**Files:**

- Modify: `workers/api/src/routes/status.ts`

Rewrite the `GET /v1/status/fetch-log` handler.

- [ ] **Step 1: Replace the handler**

Open `workers/api/src/routes/status.ts`. Replace the `statusRoutes.get("/status/fetch-log", ...)` block with:

```ts
import { encodeCursor, decodeCursor } from "./fetch-log-cursor.js";

const FETCH_LOG_STATUSES = ["success", "error", "no_change", "dry_run"] as const;
type FetchLogStatus = (typeof FETCH_LOG_STATUSES)[number];

statusRoutes.get("/status/fetch-log", async (c) => {
  const db = createDb(c.env.DB);
  const rawLimit = parseInt(c.req.query("limit") ?? "25", 10);
  const limit = Math.min(Math.max(Number.isFinite(rawLimit) ? rawLimit : 25, 1), 100);
  const after = c.req.query("after");
  const before = c.req.query("before");
  const org = c.req.query("org");
  const statusParam = c.req.query("status");
  const status = (FETCH_LOG_STATUSES as readonly string[]).includes(statusParam ?? "")
    ? (statusParam as FetchLogStatus)
    : undefined;
  const cursorToken = c.req.query("cursor");
  const cursor = cursorToken ? decodeCursor(cursorToken) : null;

  // Scope predicates — apply to both counts and the page.
  const scope = [];
  if (after) scope.push(gte(fetchLog.createdAt, after));
  if (before) scope.push(lte(fetchLog.createdAt, before));
  if (org) scope.push(eq(organizations.slug, org));

  // Page predicates add status and cursor.
  const pagePredicates = [...scope];
  if (status) pagePredicates.push(eq(fetchLog.status, status));
  if (cursor) {
    // (createdAt, id) < (cursor.createdAt, cursor.id) — lexicographic tuple compare.
    pagePredicates.push(
      sql`(${fetchLog.createdAt}, ${fetchLog.id}) < (${cursor.createdAt}, ${cursor.id})`,
    );
  }

  const rows = await db
    .select({
      id: fetchLog.id,
      sourceId: fetchLog.sourceId,
      sessionId: fetchLog.sessionId,
      sourceName: sources.name,
      sourceSlug: sources.slug,
      orgName: organizations.name,
      orgSlug: organizations.slug,
      releasesFound: fetchLog.releasesFound,
      releasesInserted: fetchLog.releasesInserted,
      durationMs: fetchLog.durationMs,
      status: fetchLog.status,
      error: fetchLog.error,
      rawContent: fetchLog.rawContent,
      createdAt: fetchLog.createdAt,
    })
    .from(fetchLog)
    .leftJoin(sources, sql`${fetchLog.sourceId} = ${sources.id}`)
    .leftJoin(organizations, sql`${sources.orgId} = ${organizations.id}`)
    .where(pagePredicates.length > 0 ? and(...pagePredicates) : undefined)
    .orderBy(desc(fetchLog.createdAt), desc(fetchLog.id))
    .limit(limit + 1);

  const hasMore = rows.length > limit;
  const entries = hasMore ? rows.slice(0, limit) : rows;
  const last = entries[entries.length - 1];
  const nextCursor =
    hasMore && last ? encodeCursor({ createdAt: last.createdAt, id: last.id }) : null;

  // Count queries run only on the first page (no cursor).
  let totalCount: number | undefined;
  let statusCounts: Record<FetchLogStatus, number> | undefined;
  if (!cursor) {
    const totalRows = await db
      .select({ n: sql<number>`count(*)` })
      .from(fetchLog)
      .leftJoin(sources, sql`${fetchLog.sourceId} = ${sources.id}`)
      .leftJoin(organizations, sql`${sources.orgId} = ${organizations.id}`)
      .where(scope.length > 0 ? and(...scope) : undefined);
    totalCount = Number(totalRows[0]?.n ?? 0);

    const grouped = await db
      .select({ status: fetchLog.status, n: sql<number>`count(*)` })
      .from(fetchLog)
      .leftJoin(sources, sql`${fetchLog.sourceId} = ${sources.id}`)
      .leftJoin(organizations, sql`${sources.orgId} = ${organizations.id}`)
      .where(scope.length > 0 ? and(...scope) : undefined)
      .groupBy(fetchLog.status);

    statusCounts = { success: 0, error: 0, no_change: 0, dry_run: 0 };
    for (const row of grouped) {
      const s = row.status as FetchLogStatus;
      if (s in statusCounts) statusCounts[s] = Number(row.n);
    }
  }

  return c.json({ entries, nextCursor, totalCount, statusCounts });
});
```

- [ ] **Step 2: Run the envelope tests**

Run: `bun test tests/api/status-fetch-log.test.ts`
Expected: all 6 tests pass.

- [ ] **Step 3: Typecheck**

Run: `npx tsc --noEmit -p workers/api/tsconfig.json`
Expected: no errors.

- [ ] **Step 4: Commit**

```bash
git add workers/api/src/routes/status.ts
git commit -m "feat(api): status fetch-log returns envelope with pagination + counts"
```

---

## Task 5: Shared response type and hook skeleton

**Files:**

- Modify: `web/src/components/fetch-log-shared.tsx`
- Create: `web/src/components/use-fetch-log.ts`

- [ ] **Step 1: Add the envelope type to the shared module**

Open `web/src/components/fetch-log-shared.tsx`. After the existing type exports (near the top, around `FetchLogStatusFilter`), add:

```ts
export interface FetchLogStatusCounts {
  success: number;
  error: number;
  no_change: number;
  dry_run: number;
}

export interface FetchLogResponse {
  entries: FetchLogEntry[];
  nextCursor: string | null;
  totalCount?: number;
  statusCounts?: FetchLogStatusCounts;
}
```

- [ ] **Step 2: Create the hook**

Create `web/src/components/use-fetch-log.ts`:

```ts
"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type {
  FetchLogEntry,
  FetchLogResponse,
  FetchLogStatusCounts,
  FetchLogStatusFilter,
} from "./fetch-log-shared";

interface Params {
  apiUrl: string;
  apiKey?: string;
  after?: string | null;
  before?: string | null;
  org?: string;
  status: FetchLogStatusFilter;
  pageSize?: number;
}

interface State {
  entries: FetchLogEntry[];
  nextCursor: string | null;
  totalCount: number;
  statusCounts: FetchLogStatusCounts;
  loading: boolean;
  error: string | null;
}

const EMPTY_COUNTS: FetchLogStatusCounts = { success: 0, error: 0, no_change: 0, dry_run: 0 };

function buildUrl(base: string, params: Record<string, string | null | undefined>): string {
  const qs = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v) qs.set(k, v);
  return `${base}${qs.toString() ? `?${qs}` : ""}`;
}

export function useFetchLog({ apiUrl, apiKey, after, before, org, status, pageSize = 25 }: Params) {
  const [state, setState] = useState<State>({
    entries: [],
    nextCursor: null,
    totalCount: 0,
    statusCounts: EMPTY_COUNTS,
    loading: true,
    error: null,
  });
  const reqId = useRef(0);

  const headers = useMemo<Record<string, string>>(() => {
    return apiKey ? { Authorization: `Bearer ${apiKey}` } : {};
  }, [apiKey]);

  const fetchPage = useCallback(
    async (cursor: string | null, append: boolean) => {
      const id = ++reqId.current;
      setState((s) => ({ ...s, loading: true, error: null }));
      try {
        const url = buildUrl(`${apiUrl}/v1/status/fetch-log`, {
          after: after ?? undefined,
          before: before ?? undefined,
          org,
          status: status === "all" ? undefined : status,
          limit: String(pageSize),
          cursor: cursor ?? undefined,
        });
        const res = await fetch(url, { headers });
        if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
        const body = (await res.json()) as FetchLogResponse;
        if (reqId.current !== id) return; // superseded
        setState((s) => ({
          entries: append ? [...s.entries, ...body.entries] : body.entries,
          nextCursor: body.nextCursor,
          totalCount: body.totalCount ?? s.totalCount,
          statusCounts: body.statusCounts ?? s.statusCounts,
          loading: false,
          error: null,
        }));
      } catch (e) {
        if (reqId.current !== id) return;
        setState((s) => ({
          ...s,
          loading: false,
          error: e instanceof Error ? e.message : String(e),
        }));
      }
    },
    [apiUrl, headers, after, before, org, status, pageSize],
  );

  // Reset whenever scope/filter changes.
  useEffect(() => {
    fetchPage(null, false);
  }, [fetchPage]);

  const loadMore = useCallback(() => {
    if (state.nextCursor && !state.loading) void fetchPage(state.nextCursor, true);
  }, [state.nextCursor, state.loading, fetchPage]);

  const reset = useCallback(() => {
    void fetchPage(null, false);
  }, [fetchPage]);

  // Optimistic live-tail prepend. Bumps counts if the event is in scope.
  const prepend = useCallback(
    (entry: FetchLogEntry) => {
      setState((s) => {
        const inScope = isInScope(entry, { after, before, org });
        const matchesFilter = status === "all" || entry.status === status;
        return {
          ...s,
          entries: inScope && matchesFilter ? [entry, ...s.entries] : s.entries,
          totalCount: inScope ? s.totalCount + 1 : s.totalCount,
          statusCounts: inScope
            ? { ...s.statusCounts, [entry.status]: (s.statusCounts[entry.status] ?? 0) + 1 }
            : s.statusCounts,
        };
      });
    },
    [after, before, org, status],
  );

  return {
    entries: state.entries,
    totalCount: state.totalCount,
    statusCounts: state.statusCounts,
    hasMore: state.nextCursor !== null,
    loading: state.loading,
    error: state.error,
    loadMore,
    reset,
    prepend,
  };
}

function isInScope(
  entry: FetchLogEntry,
  { after, before, org }: { after?: string | null; before?: string | null; org?: string },
): boolean {
  if (after && entry.createdAt < after) return false;
  if (before && entry.createdAt > before) return false;
  if (org && entry.orgSlug && entry.orgSlug !== org) return false;
  return true;
}
```

- [ ] **Step 3: Typecheck the web app**

Run: `cd web && npx tsc --noEmit && cd ..`
Expected: no errors. (If the web workspace has its own TypeScript config path, adapt accordingly.)

- [ ] **Step 4: Commit**

```bash
git add web/src/components/fetch-log-shared.tsx web/src/components/use-fetch-log.ts
git commit -m "feat(web): useFetchLog hook + FetchLogResponse envelope type"
```

---

## Task 6: Rewire the status dashboard

**Files:**

- Modify: `web/src/app/status/dashboard.tsx`

Replace the dashboard's bespoke `fetchLogs` state and `FetchLogTable` pagination with `useFetchLog`.

- [ ] **Step 1: Replace fetchLogs state and hydration**

In `web/src/app/status/dashboard.tsx`:

1. Remove the local `fetchLogs` state declaration (line ~142):
   ```ts
   const [fetchLogs, setFetchLogs] = useState<FetchLogEntry[]>([]);
   ```
2. Remove `const [fetchLogPage, setFetchLogPage] = useState(0);` (line ~150).
3. Remove the `fetchLogUrl` / `safeFetch(fetchLogUrl)` branch inside `hydrate` (lines ~172–184). The `Promise.all` should now only fetch sessions and usage. Replace:

   ```ts
   const fetchLogUrl = after
     ? `${apiUrl}/v1/status/fetch-log?after=${encodeURIComponent(after)}`
     : `${apiUrl}/v1/status/fetch-log`;
   return Promise.all([
     safeFetch(`${apiUrl}/v1/sessions`),
     safeFetch(fetchLogUrl),
     safeFetch(`${apiUrl}/v1/status/usage`),
   ])
     .then(([s, f, u]) => {
       if (s) setSessions(s as SessionState[]);
       if (f) setFetchLogs(f as FetchLogEntry[]);
       if (u) setUsage(u as UsageEntry[]);
       return s as SessionState[] | null;
     })
     .catch(() => null);
   ```

   with:

   ```ts
   return Promise.all([safeFetch(`${apiUrl}/v1/sessions`), safeFetch(`${apiUrl}/v1/status/usage`)])
     .then(([s, u]) => {
       if (s) setSessions(s as SessionState[]);
       if (u) setUsage(u as UsageEntry[]);
       return s as SessionState[] | null;
     })
     .catch(() => null);
   ```

4. In the `fetch:complete` WebSocket handler (lines ~271–285), replace the `setFetchLogs((prev) => [...])` block with a call to the hook's `prepend` — but the hook lives in the `FetchLogTable` child. Pass a ref up instead: declare a ref at the dashboard level:

   ```ts
   const fetchLogPrependRef = useRef<((entry: FetchLogEntry) => void) | null>(null);
   ```

   Replace the `else if (msg.type === "fetch:complete") { ... }` block with:

   ```ts
   } else if (msg.type === "fetch:complete") {
     fetchLogPrependRef.current?.({
       id: msg.id as string,
       sourceId: msg.sourceId as string,
       sessionId: msg.sessionId as string | undefined,
       sourceName: msg.sourceName as string | undefined,
       sourceSlug: msg.sourceSlug as string | undefined,
       releasesFound: msg.releasesFound as number,
       releasesInserted: msg.releasesInserted as number,
       durationMs: msg.durationMs as number | undefined,
       status: msg.status as FetchLogEntry["status"],
       error: msg.error as string | undefined,
       createdAt: msg.createdAt as string,
     });
   }
   ```

5. Remove the `setSessionPage(0); setFetchLogPage(0);` side-effects in the date-range pill click; they referred to removed state:

   ```ts
   onClick={() => { setDateRange(range); setSessionPage(0); setFetchLogPage(0); }}
   ```

   becomes

   ```ts
   onClick={() => { setDateRange(range); setSessionPage(0); }}
   ```

6. Replace the `FetchLogTable` invocation (line ~494):
   ```ts
   {tab === "fetch-log" && <FetchLogTable logs={fetchLogs} page={fetchLogPage} perPage={pageSize} onPageChange={setFetchLogPage} />}
   ```
   with
   ```ts
   {tab === "fetch-log" && (
     <FetchLogTable
       apiUrl={apiUrl}
       apiKey={apiKey}
       after={after}
       prependRef={fetchLogPrependRef}
     />
   )}
   ```

- [ ] **Step 2: Rewrite `FetchLogTable`**

Replace the existing `FetchLogTable` function (the whole thing, ~lines 781–893) with:

```ts
function FetchLogTable({
  apiUrl,
  apiKey,
  after,
  prependRef,
}: {
  apiUrl: string;
  apiKey?: string;
  after: string | null;
  prependRef: React.MutableRefObject<((entry: FetchLogEntry) => void) | null>;
}) {
  const [filter, setFilter] = useState<FetchLogStatusFilter>("all");
  const [expandedIds, setExpandedIds] = useState<Set<string>>(new Set());
  const { entries, totalCount, statusCounts, hasMore, loading, error, loadMore, prepend } = useFetchLog({
    apiUrl, apiKey, after, status: filter,
  });

  // Wire the live-tail prepend up to the parent via the ref.
  useEffect(() => {
    prependRef.current = prepend;
    return () => { prependRef.current = null; };
  }, [prepend, prependRef]);

  if (loading && entries.length === 0) {
    return <div className="text-sm text-stone-400 dark:text-stone-500 py-8 text-center">Loading fetch log…</div>;
  }
  if (error && entries.length === 0) {
    return <div className="text-sm text-red-500 py-8 text-center">Failed to load fetch log: {error}</div>;
  }
  if (!loading && totalCount === 0) {
    return <div className="text-sm text-stone-400 dark:text-stone-500 py-8 text-center">No fetch log entries yet.</div>;
  }

  const activeTotal = filter === "all" ? totalCount : statusCounts[filter];

  return (
    <div>
      <div className="flex gap-1 mb-3">
        {FETCH_LOG_FILTER_BUTTONS.map((f) => {
          const count = f.value === "all" ? totalCount : statusCounts[f.value];
          if (count === 0 && f.value !== "all") return null;
          return (
            <button
              key={f.value}
              onClick={() => setFilter(f.value)}
              className={`px-2.5 py-1 text-xs rounded-full transition-colors ${
                filter === f.value
                  ? "bg-stone-900 dark:bg-stone-100 text-white dark:text-stone-900"
                  : "bg-stone-100 dark:bg-stone-800 text-stone-500 dark:text-stone-400 hover:bg-stone-200 dark:hover:bg-stone-700"
              }`}
            >
              {f.label} <span className="ml-0.5 opacity-60">{count}</span>
            </button>
          );
        })}
      </div>

      <div className="border border-stone-200 dark:border-stone-800 rounded-lg overflow-hidden font-mono">
        <div className="grid grid-cols-[2fr_1.5fr_1fr_1.5fr_1fr] px-4 py-2 border-b border-stone-100 dark:border-stone-800 text-xs font-sans font-medium uppercase tracking-wider text-stone-400 dark:text-stone-500">
          <div>Source</div>
          <div>Time</div>
          <div>Status</div>
          <div>Result</div>
          <div className="text-right">Duration</div>
        </div>
        {entries.map((log) => {
          const isExpanded = expandedIds.has(log.id);
          return (
            <div key={log.id}>
              <button
                onClick={() => setExpandedIds((prev) => {
                  const next = new Set(prev);
                  if (next.has(log.id)) next.delete(log.id);
                  else next.add(log.id);
                  return next;
                })}
                className="grid grid-cols-[2fr_1.5fr_1fr_1.5fr_1fr] px-4 py-2.5 w-full text-left text-xs border-b border-stone-100 dark:border-stone-800 hover:bg-stone-50 dark:hover:bg-stone-800 transition-colors"
              >
                <div className="flex items-start gap-1.5">
                  <span className="text-stone-300 dark:text-stone-600 shrink-0">{isExpanded ? "▾" : "▸"}</span>
                  <div>
                    <div className="text-stone-900 dark:text-stone-100">
                      {log.sourceSlug ? (
                        <a href={`/source/${log.sourceSlug}`} className="hover:underline" onClick={(e) => e.stopPropagation()}>
                          {log.sourceName ?? log.sourceSlug}
                        </a>
                      ) : (
                        <span className="text-stone-500">{log.sourceName ?? log.sourceId}</span>
                      )}
                    </div>
                    {log.orgName && (
                      <div className="text-stone-400">{log.orgName}</div>
                    )}
                    {log.sessionId && (
                      <span className="text-[10px] font-sans text-indigo-400 dark:text-indigo-500">agent</span>
                    )}
                  </div>
                </div>
                <div className="text-stone-500">
                  {formatTime(new Date(log.createdAt).getTime())}
                </div>
                <div><FetchStatusBadge status={log.status} /></div>
                <div className="text-stone-500"><FetchLogResultCell log={log} /></div>
                <div className="text-stone-400 text-right">{formatFetchDuration(log.durationMs)}</div>
              </button>
              {isExpanded && <FetchLogDetail log={log} />}
            </div>
          );
        })}
      </div>
      <div className="flex items-center justify-between mt-3 text-xs text-stone-400 dark:text-stone-500">
        <span>
          Showing {entries.length} of {activeTotal.toLocaleString()} {filter === "all" ? "entries" : filter.replace("_", " ")}
        </span>
        {hasMore && (
          <button
            onClick={loadMore}
            disabled={loading}
            className="px-3 py-1 rounded border border-stone-200 dark:border-stone-700 hover:bg-stone-50 dark:hover:bg-stone-800 disabled:opacity-40 disabled:cursor-default"
          >
            {loading ? "Loading…" : "Load 25 more"}
          </button>
        )}
      </div>
    </div>
  );
}
```

- [ ] **Step 3: Add the hook import at the top of `dashboard.tsx`**

Add to the existing import from `@/components/fetch-log-shared`:

```ts
import { useFetchLog } from "@/components/use-fetch-log";
```

- [ ] **Step 4: Typecheck and build the web app**

Run: `cd web && npx tsc --noEmit && cd ..`
Expected: no errors.

Run: `cd web && bun run build 2>&1 | tail -40 && cd ..` (or `npm run build` — whichever the workspace uses).
Expected: build succeeds.

- [ ] **Step 5: Commit**

```bash
git add web/src/app/status/dashboard.tsx
git commit -m "feat(web): status dashboard uses useFetchLog + load-more"
```

---

## Task 7: Rewire the org-scoped fetch-log view

**Files:**

- Modify: `web/src/components/org-fetch-log-view.tsx`

- [ ] **Step 1: Replace the component body**

Replace the entire `OrgFetchLogView` function with:

```ts
export function OrgFetchLogView({ apiUrl, apiKey, orgSlug }: { apiUrl: string; apiKey?: string; orgSlug: string }) {
  const [filter, setFilter] = useState<FetchLogStatusFilter>("all");
  const [expandedIds, setExpandedIds] = useState<Set<string>>(new Set());
  const { entries, totalCount, statusCounts, hasMore, loading, error, loadMore } = useFetchLog({
    apiUrl, apiKey, org: orgSlug, status: filter,
  });

  if (loading && entries.length === 0) {
    return <div className="text-sm text-stone-400 dark:text-stone-500 py-8 text-center">Loading fetch log…</div>;
  }
  if (error && entries.length === 0) {
    return <div className="text-sm text-red-500 py-8 text-center">Failed to load fetch log: {error}</div>;
  }
  if (!loading && totalCount === 0) {
    return <div className="text-sm text-stone-400 dark:text-stone-500 py-8 text-center">No fetch log entries for this organization.</div>;
  }

  const activeTotal = filter === "all" ? totalCount : statusCounts[filter];

  return (
    <div className="mt-5">
      <div className="flex gap-1 mb-3">
        {FETCH_LOG_FILTER_BUTTONS.map((f) => {
          const count = f.value === "all" ? totalCount : statusCounts[f.value];
          if (count === 0 && f.value !== "all") return null;
          return (
            <button
              key={f.value}
              onClick={() => setFilter(f.value)}
              className={`px-2.5 py-1 text-xs rounded-full transition-colors ${
                filter === f.value
                  ? "bg-stone-900 dark:bg-stone-100 text-white dark:text-stone-900"
                  : "bg-stone-100 dark:bg-stone-800 text-stone-500 dark:text-stone-400 hover:bg-stone-200 dark:hover:bg-stone-700"
              }`}
            >
              {f.label} <span className="ml-0.5 opacity-60">{count}</span>
            </button>
          );
        })}
      </div>

      <div className="border border-stone-200 dark:border-stone-800 rounded-lg overflow-hidden font-mono">
        <div className="grid grid-cols-[2fr_1.5fr_1fr_1.5fr_1fr] px-4 py-2 border-b border-stone-100 dark:border-stone-800 text-xs font-sans font-medium uppercase tracking-wider text-stone-400 dark:text-stone-500">
          <div>Source</div>
          <div>Time</div>
          <div>Status</div>
          <div>Result</div>
          <div className="text-right">Duration</div>
        </div>
        {entries.map((log) => {
          const isExpanded = expandedIds.has(log.id);
          return (
            <div key={log.id}>
              <button
                onClick={() => setExpandedIds((prev) => {
                  const next = new Set(prev);
                  if (next.has(log.id)) next.delete(log.id);
                  else next.add(log.id);
                  return next;
                })}
                className="grid grid-cols-[2fr_1.5fr_1fr_1.5fr_1fr] px-4 py-2.5 w-full text-left text-xs border-b border-stone-100 dark:border-stone-800 hover:bg-stone-50 dark:hover:bg-stone-800 transition-colors"
              >
                <div className="flex items-start gap-1.5">
                  <span className="text-stone-300 dark:text-stone-600 shrink-0">{isExpanded ? "▾" : "▸"}</span>
                  <div>
                    <div className="text-stone-900 dark:text-stone-100">
                      {log.sourceSlug ? (
                        <a href={`/source/${log.sourceSlug}`} className="hover:underline" onClick={(e) => e.stopPropagation()}>
                          {log.sourceName ?? log.sourceSlug}
                        </a>
                      ) : (
                        <span className="text-stone-500">{log.sourceName ?? log.sourceId}</span>
                      )}
                    </div>
                    {log.sessionId && (
                      <span className="text-[10px] font-sans text-indigo-400 dark:text-indigo-500">agent</span>
                    )}
                  </div>
                </div>
                <div className="text-stone-500">{formatTime(log.createdAt)}</div>
                <div><FetchStatusBadge status={log.status} /></div>
                <div className="text-stone-500"><FetchLogResultCell log={log} /></div>
                <div className="text-stone-400 text-right">{formatFetchDuration(log.durationMs)}</div>
              </button>
              {isExpanded && <FetchLogDetail log={log} />}
            </div>
          );
        })}
      </div>

      <div className="flex items-center justify-between mt-2 text-[11px] text-stone-400 dark:text-stone-500">
        <span>
          Showing {entries.length} of {activeTotal.toLocaleString()} {filter === "all" ? "entries" : filter.replace("_", " ")}
        </span>
        {hasMore && (
          <button
            onClick={loadMore}
            disabled={loading}
            className="px-3 py-1 rounded border border-stone-200 dark:border-stone-700 hover:bg-stone-50 dark:hover:bg-stone-800 disabled:opacity-40 disabled:cursor-default"
          >
            {loading ? "Loading…" : "Load 25 more"}
          </button>
        )}
      </div>
    </div>
  );
}
```

- [ ] **Step 2: Update imports**

Top of `web/src/components/org-fetch-log-view.tsx`:

```ts
"use client";

import { useState } from "react";
import {
  type FetchLogStatusFilter,
  FetchStatusBadge,
  FetchLogResultCell,
  FetchLogDetail,
  formatFetchDuration,
  FETCH_LOG_FILTER_BUTTONS,
} from "./fetch-log-shared";
import { useFetchLog } from "./use-fetch-log";
```

(Remove `useEffect`, remove `FetchLogEntry` import — no longer referenced.)

- [ ] **Step 3: Typecheck**

Run: `cd web && npx tsc --noEmit && cd ..`
Expected: no errors.

- [ ] **Step 4: Commit**

```bash
git add web/src/components/org-fetch-log-view.tsx
git commit -m "feat(web): org fetch-log view uses useFetchLog + load-more"
```

---

## Task 8: Manual smoke test

**Files:** (none modified)

Verification that the UX actually works. This is a plan requirement because there are no automated UI tests in this repo.

- [ ] **Step 1: Run the web app against remote API**

Run: `cd web && bun dev` (or `npm run dev`)
Expected: Next.js dev server starts, usually on `http://localhost:3000`.

- [ ] **Step 2: Open the status page**

Visit `http://localhost:3000/status`. Go to the Fetch Log tab. Select "This Week" date range.

Verify:

- Header reads `Showing 25 of N entries` where N is the real weekly count (not capped at 200).
- Pill counts add up to N.
- "Load 25 more" appears and, when clicked, appends the next page without duplicates.
- Clicking a status pill (e.g. "Errors") shows `Showing M of <errors count> errors`, refetches, and updates the visible rows.
- Switching back to "All" refetches the mixed list.

- [ ] **Step 3: Open an org page**

Visit `http://localhost:3000/<some-org-slug>` and switch to the Fetch Log tab.

Verify the same behaviors apply scoped to that org.

- [ ] **Step 4: Confirm live-tail still works**

Trigger a fetch (e.g. `releases admin source fetch <slug>`). Within a few seconds, the new entry should appear at the top of the status dashboard Fetch Log tab and `totalCount` should increment.

- [ ] **Step 5: Commit (nothing to commit, but make sure the worktree is clean)**

Run: `git status`
Expected: clean or only the plan-file changes.

---

## Task 9: Update the spec with any refinements and PR prep

**Files:**

- Possibly modify: `docs/superpowers/specs/2026-04-19-fetch-log-pagination-design.md`

- [ ] **Step 1: Re-read the spec against the final implementation**

Run: `cat docs/superpowers/specs/2026-04-19-fetch-log-pagination-design.md`

Check: does anything implemented in Tasks 4–7 contradict the spec? If so, fix the spec to match reality (small inline edits only).

- [ ] **Step 2: Run the full worker test suite**

Run: `bun test tests/api/`
Expected: existing tests still pass; new `status-fetch-log.test.ts` and `fetch-log-cursor.test.ts` pass.

- [ ] **Step 3: Run the CLI integration tests (regression sanity)**

Run: `bun test tests/integration/fetch-log.test.ts`
Expected: PASS — the CLI path uses `/v1/fetch-log` (unchanged) and is untouched.

- [ ] **Step 4: Typecheck everything**

Run: `npx tsc --noEmit`
Expected: no new errors.

- [ ] **Step 5: Commit any spec refinements and push**

```bash
git status
# If spec was updated:
git add docs/superpowers/specs/2026-04-19-fetch-log-pagination-design.md
git commit -m "docs(specs): align fetch-log pagination spec with implementation"
git push -u origin HEAD
```

- [ ] **Step 6: Open the PR**

Run:

```bash
gh pr create --title "fetch log: cursor pagination and accurate counts" --body-file /tmp/fetch-log-pr-body.md
```

First write `/tmp/fetch-log-pr-body.md`:

```markdown
## Summary

- `GET /v1/status/fetch-log` now returns `{ entries, nextCursor, totalCount, statusCounts }`. Cursor-based pagination replaces the 200-row cap.
- Status filter pills on the dashboard and org pages use server-side counts — "42 errors this week" actually means 42 errors this week.
- "Load 25 more" replaces the client-only Prev/Next. Live `fetch:complete` events still prepend into the visible list.
- CLI endpoint `/v1/fetch-log` is unchanged.

## Test plan

- [ ] `bun test tests/api/status-fetch-log.test.ts` passes
- [ ] `bun test tests/api/fetch-log-cursor.test.ts` passes
- [ ] `bun test tests/integration/fetch-log.test.ts` still green
- [ ] Manual: status page Fetch Log tab shows accurate totals across "Week", Load more works, filters refetch from the server
- [ ] Manual: org page Fetch Log tab shows accurate scoped totals
- [ ] Manual: new entry arrives via WebSocket while viewing — appears at top, counts bump

Spec: [docs/superpowers/specs/2026-04-19-fetch-log-pagination-design.md](docs/superpowers/specs/2026-04-19-fetch-log-pagination-design.md)

🤖 Generated with [Claude Code](https://claude.com/claude-code)
```

---

## Self-Review Notes

**Spec coverage check:** Each spec section maps to tasks —

- API envelope / params → Tasks 3–4.
- Cursor semantics → Task 1, exercised in Task 4.
- Count-query scoping → Task 3 (tests), Task 4 (impl).
- Hook + load-more UX → Tasks 5–7.
- Live-tail bump on fetch:complete → Task 6.
- Org-scoped view parity → Task 7.
- Testing (integration tests, manual smoke) → Tasks 3, 8.
- Rollout / single PR → Task 9.
- Out of scope (`/v1/fetch-log`, CLI) → confirmed untouched in Task 9 Step 3.

**Type consistency:** `FetchLogStatusCounts` and `FetchLogResponse` defined once in Task 5 and reused in Tasks 6–7. Hook method names (`loadMore`, `reset`, `prepend`, `hasMore`) consistent across call sites. Cursor type `CursorValue` defined in Task 1 and used only inside the worker.

**No placeholders:** every step shows full code or an exact command.
