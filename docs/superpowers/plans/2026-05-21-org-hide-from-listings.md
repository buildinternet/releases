# Org "hide from listings" toggle — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add an admin-only, dev-local toggle that pulls a low-value org (e.g. `koute`) out of the homepage latest-releases ticker and the main `/orgs` directory table while keeping the org reachable via its detail page, search, and the sitemap.

**Architecture:** A new `is_hidden` boolean on `organizations` (independent of `fetch_paused` and `deleted_at`). Two read-path queries filter it out (`getLatestReleasesAcross`, `getOrgsWithStats`/`countOrgsForList`); search, sitemap, and the detail endpoint deliberately do not. The toggle rides the existing `PATCH /v1/orgs/:slug` handler (mirroring `fetchPaused`); the web UI mirrors `ReleaseAdminMenu` — a dev-local `OrgAdminMenu` on the org detail page → server action → PATCH with the `RELEASED_API_KEY` bearer.

**Tech Stack:** Bun, TypeScript (strict), Drizzle ORM over Cloudflare D1, Hono (API worker), Next.js (web). Tests: `bun test` with `bun:sqlite` fixtures.

**Spec:** `docs/superpowers/specs/2026-05-21-org-hide-from-listings-design.md`

---

## File map

- **Create** `workers/api/migrations/20260521000000_add_organizations_is_hidden.sql` — the column.
- **Modify** `packages/core/src/schema.ts` — add `isHidden` to the `organizations` table.
- **Modify** `workers/api/src/queries/releases.ts` — filter hidden orgs from `getLatestReleasesAcross`.
- **Modify** `workers/api/src/queries/orgs.ts` — filter hidden orgs from `getOrgsWithStats` + `countOrgsForList`.
- **Modify** `packages/api-types/src/schemas/orgs.ts` — `isHidden` on `UpdateOrgBodySchema` (request) and `OrgDetailSchema` (response).
- **Modify** `workers/api/src/routes/orgs.ts` — accept/persist `isHidden` in `PATCH`, return it from the detail handler, purge the latest-cache on toggle.
- **Create** `web/src/app/actions/org-admin.ts` — `setOrgHiddenAction` server action.
- **Create** `web/src/components/org-admin-menu.tsx` — dev-local admin dropdown.
- **Modify** `web/src/app/[orgSlug]/(org)/layout.tsx` — mount the menu behind `isLocalAdminEnabled()`.
- **Create** `workers/api/test/org-hidden-listings.test.ts` — read-path filter tests (Tasks 2 + 3).
- **Create** `tests/api/org-hidden-toggle.test.ts` — column round-trip + PATCH + detail + reachability (Tasks 1 + 4).

---

## Task 1: Add the `is_hidden` column + migration

**Files:**

- Create: `workers/api/migrations/20260521000000_add_organizations_is_hidden.sql`
- Modify: `packages/core/src/schema.ts` (organizations table, after the `fetchPaused` field at line 76)
- Test: `tests/api/org-hidden-toggle.test.ts` (new)

- [ ] **Step 1: Write the failing test**

Create `tests/api/org-hidden-toggle.test.ts` with a column round-trip that proves the migration + schema field exist:

```ts
import { describe, it, expect } from "bun:test";
import { Database } from "bun:sqlite";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { eq } from "drizzle-orm";
import { applyMigrations } from "../db-helper";
import { organizations } from "@buildinternet/releases-core/schema";

describe("organizations.is_hidden column", () => {
  it("defaults to false and round-trips true", async () => {
    const sqlite = new Database(":memory:");
    applyMigrations(sqlite);
    const db = drizzle(sqlite);

    await db
      .insert(organizations)
      .values([
        { id: "org_default", slug: "default-org", name: "Default" },
        { id: "org_hidden", slug: "hidden-org", name: "Hidden", isHidden: true },
      ])
      .run();

    const [def] = await db.select().from(organizations).where(eq(organizations.id, "org_default"));
    const [hid] = await db.select().from(organizations).where(eq(organizations.id, "org_hidden"));

    expect(def.isHidden).toBe(false);
    expect(hid.isHidden).toBe(true);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/api/org-hidden-toggle.test.ts`
Expected: FAIL — either a TS error that `isHidden` is not a known property of the insert values, or a SQLite error `table organizations has no column named is_hidden`.

- [ ] **Step 3: Add the column to the Drizzle schema**

In `packages/core/src/schema.ts`, insert this field in the `organizations` table definition immediately after the `fetchPaused` line (currently line 76), before the `// Soft-delete tombstone (#666).` comment:

```ts
    // Per-org "don't feature" flag. When true, the org is excluded from the
    // homepage latest-releases ticker and the main /v1/orgs directory table,
    // but stays fully reachable via its detail page, search, and the sitemap.
    // Distinct from fetchPaused (ingest-only) and deletedAt (soft-delete).
    // Toggle via PATCH /v1/orgs/:slug { isHidden: true }. Default false.
    isHidden: integer("is_hidden", { mode: "boolean" }).notNull().default(false),
```

- [ ] **Step 4: Create the migration file**

Create `workers/api/migrations/20260521000000_add_organizations_is_hidden.sql`:

```sql
-- Per-org "don't feature" flag. Excludes the org from the homepage ticker and
-- the /v1/orgs directory listing while keeping it reachable via detail page,
-- search, and sitemap. The organizations_active / organizations_public SELECT *
-- views expose the new column at query time — no view recreation required.
ALTER TABLE organizations ADD COLUMN is_hidden INTEGER NOT NULL DEFAULT 0;
```

- [ ] **Step 5: Run test to verify it passes**

Run: `bun test tests/api/org-hidden-toggle.test.ts`
Expected: PASS (1 test).

- [ ] **Step 6: Commit**

```bash
git add packages/core/src/schema.ts workers/api/migrations/20260521000000_add_organizations_is_hidden.sql tests/api/org-hidden-toggle.test.ts
git commit -m "feat(orgs): add is_hidden column + migration"
```

---

## Task 2: Filter hidden orgs from the homepage reel (`getLatestReleasesAcross`)

**Files:**

- Modify: `workers/api/src/queries/releases.ts:46-49` (the `wheres` array)
- Test: `workers/api/test/org-hidden-listings.test.ts` (new)

- [ ] **Step 1: Write the failing test**

Create `workers/api/test/org-hidden-listings.test.ts`. This task's `describe` block uses `bun:sqlite` + `makeD1Shim` because `getLatestReleasesAcross` takes a raw `D1Database` (mirrors `prerelease-default-filter.test.ts`):

```ts
import { describe, it, expect } from "bun:test";
import { Database } from "bun:sqlite";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { organizations, sources, releases } from "@buildinternet/releases-core/schema";
import { getLatestReleasesAcross } from "../src/queries/releases";
import { applyMigrations, makeD1Shim } from "../../../tests/db-helper";

async function seedLatest(): Promise<D1Database> {
  const sqlite = new Database(":memory:");
  applyMigrations(sqlite);
  const db = drizzle(sqlite);
  await db.insert(organizations).values([
    { id: "org_visible", slug: "visible-org", name: "Visible" },
    { id: "org_hidden", slug: "hidden-org", name: "Hidden", isHidden: true },
  ]);
  await db.insert(sources).values([
    {
      id: "src_visible",
      slug: "visible-src",
      name: "Visible Src",
      type: "feed",
      url: "https://visible.example/feed",
      orgId: "org_visible",
    },
    {
      id: "src_hidden",
      slug: "hidden-src",
      name: "Hidden Src",
      type: "feed",
      url: "https://hidden.example/feed",
      orgId: "org_hidden",
    },
  ]);
  await db.insert(releases).values([
    {
      id: "rel_visible",
      sourceId: "src_visible",
      title: "Visible 1.0",
      content: "x",
      url: "https://visible.example/r/1",
      publishedAt: "2026-05-05T12:00:00.000Z",
    },
    {
      id: "rel_hidden",
      sourceId: "src_hidden",
      title: "Hidden 1.0",
      content: "x",
      url: "https://hidden.example/r/1",
      publishedAt: "2026-05-06T12:00:00.000Z",
    },
  ]);
  return makeD1Shim(sqlite);
}

describe("getLatestReleasesAcross — hidden-org filter", () => {
  it("excludes releases whose org is hidden", async () => {
    const d1 = await seedLatest();
    const rows = await getLatestReleasesAcross(d1, { limit: 50 });
    const ids = rows.map((r) => r.id);
    expect(ids).toContain("rel_visible");
    expect(ids).not.toContain("rel_hidden");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test workers/api/test/org-hidden-listings.test.ts`
Expected: FAIL — `expect(ids).not.toContain("rel_hidden")` fails because the hidden org's release is currently included.

- [ ] **Step 3: Add the filter**

In `workers/api/src/queries/releases.ts`, extend the initial `wheres` array (currently lines 46-49) to drop hidden orgs. The org is a `LEFT JOIN`, so keep the `IS NULL` branch for source-only rows:

```ts
const wheres: string[] = [
  "(s.is_hidden = 0 OR s.is_hidden IS NULL)",
  "(o.is_hidden = 0 OR o.is_hidden IS NULL)",
  "(r.suppressed IS NULL OR r.suppressed = 0)",
];
```

(The `o` alias is already joined at line 86: `LEFT JOIN organizations o ON o.id = s.org_id`.)

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test workers/api/test/org-hidden-listings.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add workers/api/src/queries/releases.ts workers/api/test/org-hidden-listings.test.ts
git commit -m "feat(orgs): exclude hidden orgs from the latest-releases feed"
```

---

## Task 3: Filter hidden orgs from the directory table (`getOrgsWithStats` + `countOrgsForList`)

**Files:**

- Modify: `workers/api/src/queries/orgs.ts:79-83` (the `orgListSearchWhere` helper)
- Test: `workers/api/test/org-hidden-listings.test.ts` (append a `describe` block)

- [ ] **Step 1: Write the failing test**

Append to `workers/api/test/org-hidden-listings.test.ts`. This block goes through the `GET /v1/orgs` route (mirrors `orgs-empty-filter.test.ts`):

```ts
import { orgRoutes } from "../src/routes/orgs.js";
import { createTestDb as mkDb, createTestApp } from "./setup";

const mkApp = (db: ReturnType<typeof mkDb>) => createTestApp(db, orgRoutes);
const NOW = "2026-05-15T12:00:00.000Z";

async function seedDirectory(db: ReturnType<typeof mkDb>) {
  await db.insert(organizations).values([
    { id: "org_acme", slug: "acme", name: "Acme" },
    { id: "org_koute", slug: "koute", name: "Koute", isHidden: true },
  ]);
  await db.insert(sources).values([
    {
      id: "src_acme",
      orgId: "org_acme",
      slug: "acme-changelog",
      name: "Acme Changelog",
      type: "scrape",
      url: "https://acme.example/changelog",
      createdAt: NOW,
    },
    {
      id: "src_koute",
      orgId: "org_koute",
      slug: "koute-changelog",
      name: "Koute Changelog",
      type: "scrape",
      url: "https://koute.example/changelog",
      createdAt: NOW,
    },
  ]);
  await db.insert(releases).values([
    {
      id: "rel_acme_1",
      sourceId: "src_acme",
      title: "Acme 1.0",
      content: "x",
      publishedAt: NOW,
      fetchedAt: NOW,
    },
    {
      id: "rel_koute_1",
      sourceId: "src_koute",
      title: "Koute 1.0",
      content: "x",
      publishedAt: NOW,
      fetchedAt: NOW,
    },
  ]);
}

describe("GET /v1/orgs — hidden-org filter", () => {
  it("excludes hidden orgs from items and totalItems", async () => {
    const db = mkDb();
    await seedDirectory(db);

    const res = await mkApp(db)(new Request("https://x.test/v1/orgs"));
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      items: Array<{ slug: string }>;
      pagination: { totalItems: number };
    };
    expect(body.items.map((o) => o.slug)).toEqual(["acme"]);
    expect(body.pagination.totalItems).toBe(1);
  });

  it("keeps hidden orgs out even with ?includeEmpty=true", async () => {
    const db = mkDb();
    await seedDirectory(db);

    const res = await mkApp(db)(new Request("https://x.test/v1/orgs?includeEmpty=true"));
    const body = (await res.json()) as { items: Array<{ slug: string }> };
    expect(body.items.map((o) => o.slug)).not.toContain("koute");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test workers/api/test/org-hidden-listings.test.ts`
Expected: FAIL — `koute` appears in `items` / `totalItems` is 2.

- [ ] **Step 3: Add the filter to the shared WHERE helper**

In `workers/api/src/queries/orgs.ts`, replace the `orgListSearchWhere` helper (lines 79-83) so the hidden filter is always applied, with the optional search term `AND`-ed on. Rename it to `orgListWhere` for accuracy and update both call sites (line 16 in `getOrgsWithStats`, line 53 in `countOrgsForList`):

```ts
function orgListWhere(q?: string) {
  // Hidden orgs ("don't feature") never appear in the directory listing,
  // regardless of the empty-org toggle. is_hidden is NOT NULL so `= 0` is safe.
  const hidden = sql`o.is_hidden = 0`;
  if (!q) return sql`WHERE ${hidden}`;
  const lower = q.toLowerCase();
  return sql`WHERE ${hidden} AND (${likeContains(sql`lower(o.name)`, lower)} OR ${likeContains(sql`lower(o.slug)`, lower)})`;
}
```

Then update the two call sites from `orgListSearchWhere(q)` to `orgListWhere(q)`:

- `getOrgsWithStats`: `const where = orgListWhere(q);` (line 16)
- `countOrgsForList`: `const where = orgListWhere(q);` (line 53)

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test workers/api/test/org-hidden-listings.test.ts`
Expected: PASS (all three tests in the file).

- [ ] **Step 5: Run the existing directory test to confirm no regression**

Run: `bun test workers/api/test/orgs-empty-filter.test.ts`
Expected: PASS (3 tests) — the empty-org filter still behaves; its seed orgs have `is_hidden = 0` by default.

- [ ] **Step 6: Commit**

```bash
git add workers/api/src/queries/orgs.ts workers/api/test/org-hidden-listings.test.ts
git commit -m "feat(orgs): exclude hidden orgs from the directory listing"
```

---

## Task 4: Toggle API — schema field, PATCH persist, detail response, cache purge

**Files:**

- Modify: `packages/api-types/src/schemas/orgs.ts` (`UpdateOrgBodySchema` line 95-106, `OrgDetailSchema` line 389-411)
- Modify: `workers/api/src/routes/orgs.ts` (PATCH body type ~578, updates map ~630, detail result ~399-427, add import)
- Test: `tests/api/org-hidden-toggle.test.ts` (append PATCH + detail + reachability)

- [ ] **Step 1: Write the failing tests**

Append to `tests/api/org-hidden-toggle.test.ts` (the file from Task 1). This uses the `createTestDb` / `orgRoutes.request` harness from `org-fetch-paused.test.ts`:

```ts
import { beforeEach, afterEach } from "bun:test";
import { createTestDb, type TestDatabase } from "../db-helper";

let testDb: TestDatabase;
beforeEach(() => {
  testDb = createTestDb();
});
afterEach(() => {
  testDb.cleanup();
});

const noopCtx = { waitUntil: () => {}, passThroughOnException: () => {} };

async function call(path: string, method: string, body?: unknown): Promise<Response> {
  return orgRoutes.request(
    path,
    {
      method,
      headers: body !== undefined ? { "content-type": "application/json" } : undefined,
      body: body === undefined ? undefined : JSON.stringify(body),
    },
    { DB: testDb.db as unknown as never },
    noopCtx as unknown as Parameters<typeof orgRoutes.request>[3],
  );
}

describe("PATCH /v1/orgs/:slug { isHidden }", () => {
  it("hides and persists, and the org stays reachable via detail", async () => {
    await testDb.db.insert(organizations).values({
      id: "org_acme",
      name: "Acme",
      slug: "acme",
      discovery: "curated",
    });

    const patched = await call("/orgs/acme", "PATCH", { isHidden: true });
    expect(patched.status).toBe(200);
    expect(((await patched.json()) as { isHidden: boolean }).isHidden).toBe(true);

    // Reachability regression: the detail endpoint still returns the org.
    const detail = await call("/orgs/acme", "GET");
    expect(detail.status).toBe(200);
    expect(((await detail.json()) as { slug: string; isHidden: boolean }).isHidden).toBe(true);
  });

  it("unhides", async () => {
    await testDb.db.insert(organizations).values({
      id: "org_acme2",
      name: "Acme 2",
      slug: "acme2",
      discovery: "curated",
      isHidden: true,
    });

    const res = await call("/orgs/acme2", "PATCH", { isHidden: false });
    expect(res.status).toBe(200);
    expect(((await res.json()) as { isHidden: boolean }).isHidden).toBe(false);
  });
});
```

This test file now imports `orgRoutes` and `organizations`; add to the top-of-file imports:

```ts
import { orgRoutes } from "../../workers/api/src/routes/orgs.js";
```

(`organizations` and `applyMigrations` are already imported from Task 1. Keep the Task 1 round-trip test as the first `describe`.)

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun test tests/api/org-hidden-toggle.test.ts`
Expected: FAIL — the PATCH body's `isHidden` is stripped by `UpdateOrgBodySchema` validation (or ignored by the handler), so the returned `isHidden` is `false`/`undefined`, and the detail response has no `isHidden`.

- [ ] **Step 3: Add `isHidden` to the API-types schemas**

In `packages/api-types/src/schemas/orgs.ts`, add to `UpdateOrgBodySchema` (after the `fetchPaused` line 105):

```ts
  /** Admin-only: hide the org from the homepage ticker + /v1/orgs directory. Stays reachable via detail, search, sitemap. */
  isHidden: z.boolean().optional(),
```

And add to `OrgDetailSchema` (after `avatarUrl` at line 396). Optional on the wire so a pinned/older worker mid-deploy that omits it doesn't trip the web's schema parse:

```ts
  isHidden: z.boolean().optional(),
```

- [ ] **Step 4: Persist + return `isHidden` in the route, and import the cache helper**

In `workers/api/src/routes/orgs.ts`:

(a) Add the import near the other `../lib/*` imports at the top of the file:

```ts
import { invalidateLatestCache } from "../lib/latest-cache.js";
```

(b) Add `isHidden` to the PATCH body type (after `fetchPaused?: boolean;` at line 578):

```ts
      isHidden?: boolean;
```

(c) Add the conditional write to the `updates` map (after `if (body.fetchPaused !== undefined) updates.fetchPaused = body.fetchPaused;` at line 630):

```ts
if (body.isHidden !== undefined) updates.isHidden = body.isHidden;
```

(d) After the `db.update(organizations).set(updates)` block returns `updated` (line 636), purge the latest-cache when visibility changed. The org id is `org.id`:

```ts
if (body.isHidden !== undefined) {
  // Hiding/unhiding changes what the homepage ticker + /v1/releases/latest
  // default shapes return; purge so the change appears within seconds
  // rather than waiting out the 300s KV TTL. Best-effort, gated on
  // INVALIDATION_ENABLED, so a missing binding (dev/tests) just no-ops.
  c.executionCtx.waitUntil(invalidateLatestCache(c.env, { nReleases: 1, sourceId: org.id }));
}
```

(e) Add `isHidden` to the detail handler's `result` object (in the GET `/orgs/:slug` handler, alongside `avatarUrl` at line 406). `org` is the Drizzle row from `organizations`, so `org.isHidden` exists after Task 1:

```ts
      isHidden: org.isHidden ?? false,
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `bun test tests/api/org-hidden-toggle.test.ts`
Expected: PASS (3 tests — column round-trip, hide+reachable, unhide).

- [ ] **Step 6: Run the fetchPaused test to confirm the shared PATCH path is intact**

Run: `bun test tests/api/org-fetch-paused.test.ts`
Expected: PASS (unchanged behavior).

- [ ] **Step 7: Commit**

```bash
git add packages/api-types/src/schemas/orgs.ts workers/api/src/routes/orgs.ts tests/api/org-hidden-toggle.test.ts
git commit -m "feat(orgs): accept isHidden on PATCH, return it on detail, purge latest-cache"
```

---

## Task 5: Web server action (`setOrgHiddenAction`)

**Files:**

- Create: `web/src/app/actions/org-admin.ts`

No unit test (Next.js server actions aren't covered by the worker test harness; verification is `tsc` + the manual dev check in Task 8). Mirrors `web/src/app/actions/release-admin.ts`.

- [ ] **Step 1: Create the server action**

Create `web/src/app/actions/org-admin.ts`:

```ts
"use server";

import { revalidatePath } from "next/cache";
import { webApiHeaders } from "@/lib/api";
import { isLocalAdminEnabled } from "@/lib/local-admin-flag";

type ActionResult = { ok: true } | { ok: false; error: string };

function adminEnv(): { apiUrl: string; apiSecret: string } | { error: string } {
  if (!isLocalAdminEnabled()) {
    return { error: "Admin actions are disabled in this environment." };
  }
  const apiUrl = process.env.RELEASED_API_URL ?? "http://localhost:3456";
  const apiSecret = process.env.RELEASED_API_KEY;
  if (!apiSecret) return { error: "RELEASED_API_KEY not configured." };
  return { apiUrl, apiSecret };
}

export async function setOrgHiddenAction(input: {
  slug: string;
  hidden: boolean;
}): Promise<ActionResult> {
  const env = adminEnv();
  if ("error" in env) return { ok: false, error: env.error };

  let res: Response;
  try {
    res = await fetch(`${env.apiUrl}/v1/orgs/${encodeURIComponent(input.slug)}`, {
      method: "PATCH",
      headers: webApiHeaders({
        "Content-Type": "application/json",
        Authorization: `Bearer ${env.apiSecret}`,
      }),
      body: JSON.stringify({ isHidden: input.hidden }),
      cache: "no-store",
    });
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : "Network error" };
  }

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    return { ok: false, error: `API ${res.status}: ${text || res.statusText}` };
  }

  // Bust the homepage (ticker + directory table) and the org detail page.
  revalidatePath("/");
  revalidatePath(`/${input.slug}`);
  return { ok: true };
}
```

- [ ] **Step 2: Type-check**

Run: `cd web && npx tsc --noEmit`
Expected: PASS (no errors referencing `org-admin.ts`).

- [ ] **Step 3: Commit**

```bash
git add web/src/app/actions/org-admin.ts
git commit -m "feat(web): setOrgHiddenAction server action for org hide toggle"
```

---

## Task 6: Web `OrgAdminMenu` component

**Files:**

- Create: `web/src/components/org-admin-menu.tsx`

Mirrors `web/src/components/release-admin-menu.tsx` but simpler (single toggle, no reason field).

- [ ] **Step 1: Create the component**

Create `web/src/components/org-admin-menu.tsx`:

```tsx
"use client";

import { useEffect, useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { setOrgHiddenAction } from "@/app/actions/org-admin";

export function OrgAdminMenu({ orgSlug, isHidden }: { orgSlug: string; isHidden: boolean }) {
  const [open, setOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  const containerRef = useRef<HTMLDivElement>(null);
  const router = useRouter();

  function close() {
    setOpen(false);
    setError(null);
  }

  useEffect(() => {
    if (!open) return;
    function onPointerDown(e: PointerEvent) {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) close();
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") close();
    }
    document.addEventListener("pointerdown", onPointerDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  function handleToggle() {
    startTransition(async () => {
      setError(null);
      const res = await setOrgHiddenAction({ slug: orgSlug, hidden: !isHidden });
      if (!res.ok) {
        setError(res.error);
        return;
      }
      close();
      router.refresh();
    });
  }

  return (
    <div ref={containerRef} className="relative inline-flex items-center">
      <button
        type="button"
        onClick={() => (open ? close() : setOpen(true))}
        aria-haspopup="menu"
        aria-expanded={open}
        className="text-[11px] px-2 py-0.5 rounded font-medium uppercase tracking-wider border border-stone-300 dark:border-stone-700 bg-stone-50 hover:bg-stone-100 dark:bg-stone-900 dark:hover:bg-stone-800 text-stone-700 dark:text-stone-200"
        title="Local-dev admin actions"
      >
        {isHidden ? "Admin · Hidden" : "Admin"}
      </button>
      {open && (
        <div
          role="menu"
          className="absolute left-0 top-full mt-1 z-20 w-72 rounded-md border border-stone-200 dark:border-stone-800 bg-white dark:bg-stone-950 shadow-lg text-[13px] overflow-hidden"
        >
          <div className="p-3 space-y-2">
            <div className="font-medium text-stone-700 dark:text-stone-200">
              {isHidden ? "Org hidden from listings" : "Feature visibility"}
            </div>
            <p className="text-[12px] text-stone-500 dark:text-stone-400">
              {isHidden
                ? "Excluded from the homepage ticker and the org directory. Still reachable by direct link, search, and sitemap."
                : "Hides this org from the homepage ticker and the org directory table. It stays reachable by direct link, search, and sitemap."}
            </p>
            <button
              type="button"
              onClick={handleToggle}
              disabled={pending}
              className="w-full px-2 py-1 rounded border border-stone-300 dark:border-stone-700 bg-stone-50 hover:bg-stone-100 dark:bg-stone-900 dark:hover:bg-stone-800 text-stone-700 dark:text-stone-200 disabled:opacity-50"
            >
              {pending ? "Saving…" : isHidden ? "Unhide from listings" : "Hide from listings"}
            </button>
            {error && <div className="text-[12px] text-red-600 dark:text-red-400">{error}</div>}
          </div>
        </div>
      )}
    </div>
  );
}
```

- [ ] **Step 2: Type-check**

Run: `cd web && npx tsc --noEmit`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add web/src/components/org-admin-menu.tsx
git commit -m "feat(web): OrgAdminMenu dev-local hide/unhide dropdown"
```

---

## Task 7: Mount the menu in the org layout

**Files:**

- Modify: `web/src/app/[orgSlug]/(org)/layout.tsx`

- [ ] **Step 1: Add imports**

In `web/src/app/[orgSlug]/(org)/layout.tsx`, add to the import block (near the `CliCommand` import at line 10):

```ts
import { isLocalAdminEnabled } from "@/lib/local-admin-flag";
import { OrgAdminMenu } from "@/components/org-admin-menu";
```

- [ ] **Step 2: Compute the gate**

After `const hasFetchLog = process.env.NODE_ENV === "development";` (line 40), add:

```ts
const adminEnabled = isLocalAdminEnabled();
```

- [ ] **Step 3: Render the menu after the CLI command**

Replace the `<CliCommand identifier={org.slug} />` line (line 96) with:

```tsx
<CliCommand identifier={org.slug} />;
{
  adminEnabled && (
    <div className="mt-2">
      <OrgAdminMenu orgSlug={org.slug} isHidden={org.isHidden ?? false} />
    </div>
  );
}
```

(`org` is the api-types `OrgDetail`; `org.isHidden` is available because Task 4 added it to `OrgDetailSchema` and web resolves api-types from source.)

- [ ] **Step 4: Type-check**

Run: `cd web && npx tsc --noEmit`
Expected: PASS — `org.isHidden` resolves to `boolean | undefined`.

- [ ] **Step 5: Commit**

```bash
git add "web/src/app/[orgSlug]/(org)/layout.tsx"
git commit -m "feat(web): mount OrgAdminMenu on the org detail page (dev-local)"
```

---

## Task 8: Full verification

**Files:** none (verification only).

- [ ] **Step 1: Full test suite**

Run: `bun test`
Expected: PASS, including the two new files (`tests/api/org-hidden-toggle.test.ts`, `workers/api/test/org-hidden-listings.test.ts`).

- [ ] **Step 2: Type-check root + each worker + web**

Run:

```bash
npx tsc --noEmit
(cd workers/api && npx tsc --noEmit)
(cd web && npx tsc --noEmit)
```

Expected: PASS for all. (Root `tsc` only covers `src/`; `bun test` in Step 1 is what gate-checks the new test files' types.)

- [ ] **Step 3: Lint + format**

Run:

```bash
bun run lint
bun run format:check
```

Expected: PASS. If `format:check` flags the new files, run `bun run format` and amend.

- [ ] **Step 4: Manual dev smoke (optional but recommended)**

With `RELEASED_API_KEY` set in `web/.env` and `NODE_ENV=development`:

1. `bun run dev:api` and `bun run dev:web`.
2. Visit `https://{branch}.releases.localhost/koute` → the **Admin** chip shows under the CLI command.
3. Click **Admin → Hide from listings**.
4. Confirm `koute` no longer appears in the homepage org table or the latest ticker, but `https://…/koute` still loads and `https://…/koute` is returned by `/v1/orgs/koute`.
5. Re-open the menu → **Unhide from listings** → `koute` returns to the table.

- [ ] **Step 5: Note on deployment**

The migration auto-applies on merge to `main` (D1 migrations run before the worker deploy). No manual prod migration step. Staging can be refreshed/migrated freely; production migration runs as part of the normal merge deploy.

---

## Self-review notes

- **Spec coverage:** column + migration (Task 1), homepage reel filter (Task 2), directory filter (Task 3), PATCH toggle + detail + cache purge (Task 4), web action + menu + mount (Tasks 5-7), tests incl. reachability regression (Tasks 1-4), search/sitemap/detail untouched (no task modifies `search.ts` or `sitemap.ts`; reachability asserted in Task 4). All spec sections map to a task.
- **Naming consistency:** `is_hidden` (DB) / `isHidden` (Drizzle + wire) throughout; helper renamed `orgListSearchWhere` → `orgListWhere` with both call sites updated in the same task; `setOrgHiddenAction` / `OrgAdminMenu` consistent across Tasks 5-7.
- **`invalidateLatestCache` signature** matches the source: `(env, { nReleases, sourceId })`; `nReleases: 1` clears the `nReleases <= 0` early-return guard so the homepage shapes actually purge.
