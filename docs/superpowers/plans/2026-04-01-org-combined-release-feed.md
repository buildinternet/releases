# Org Combined Release Feed — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a combined chronological release feed for organizations, accessible via a new API endpoint and a "Releases" tab on the org web page.

**Architecture:** New `GET /api/orgs/:slug/releases` endpoint with cursor-based pagination returns releases joined with source metadata. The org page gains a tab system ("Sources" / "Releases"). The Releases tab uses a client component with "Load more" that fetches subsequent pages via cursor. Source attribution ("via Source Name") appears as a byline on each release when the org has multiple sources.

**Tech Stack:** Hono (API routes), Drizzle ORM + raw SQL (D1), Next.js (React Server Components + Client Components), TypeScript

**Spec:** `docs/superpowers/specs/2026-04-01-org-combined-release-feed-design.md`

---

### Task 1: API Endpoint — `GET /api/orgs/:slug/releases`

**Files:**
- Modify: `workers/api/src/routes/orgs.ts` (add new route after existing endpoints)

- [ ] **Step 1: Add the route handler**

Add this route to `workers/api/src/routes/orgs.ts`, before the final `export`. Place it after the existing `orgRoutes.get("/:slug/activity", ...)` route:

```typescript
// Combined release feed for an org
orgRoutes.get("/:slug/releases", async (c) => {
  const slug = c.req.param("slug");
  const cursorParam = c.req.query("cursor") ?? null;
  const limit = Math.min(parseInt(c.req.query("limit") ?? "20", 10), 100);

  const db = createDb(c.env);

  // Resolve org
  const org = await db
    .select({ id: organizations.id })
    .from(organizations)
    .where(
      slug.startsWith("org_")
        ? eq(organizations.id, slug)
        : eq(organizations.slug, slug)
    )
    .get();

  if (!org) return c.json({ error: "org_not_found" }, 404);

  // Get all source IDs for this org
  const orgSources = await db
    .select({ id: sources.id })
    .from(sources)
    .where(eq(sources.orgId, org.id))
    .all();

  if (orgSources.length === 0) {
    return c.json({ releases: [], pagination: { nextCursor: null, limit } });
  }

  const sourceIds = orgSources.map((s) => s.id);
  const placeholders = sourceIds.map(() => "?").join(", ");

  // Parse cursor — format is "publishedAt|id"
  let cursorWhere = "";
  const cursorBindings: string[] = [];
  if (cursorParam) {
    const [cursorDate, cursorId] = cursorParam.split("|");
    if (cursorDate && cursorId) {
      cursorWhere = `AND ((r.published_at < ?) OR (r.published_at = ? AND r.id < ?))`;
      cursorBindings.push(cursorDate, cursorDate, cursorId);
    } else if (cursorDate) {
      cursorWhere = `AND r.published_at < ?`;
      cursorBindings.push(cursorDate);
    }
  }

  // Query releases joined with sources — fetch limit + 1 to detect next page.
  // Use c.env.DB.prepare() for raw SQL — matches the activity endpoint pattern in this file.

  const stmt = c.env.DB.prepare(`
    SELECT r.id, r.version, r.title, r.content, r.content_summary,
           r.published_at, r.fetched_at, r.url, r.media,
           s.slug AS source_slug, s.name AS source_name, s.type AS source_type
    FROM releases r
    INNER JOIN sources s ON s.id = r.source_id
    WHERE r.source_id IN (${placeholders})
      AND (r.suppressed IS NULL OR r.suppressed = 0)
      ${cursorWhere}
    ORDER BY
      CASE WHEN r.published_at IS NOT NULL THEN 0 ELSE 1 END,
      r.published_at DESC,
      r.id DESC
    LIMIT ?
  `).bind(...sourceIds, ...cursorBindings, limit + 1);

  const { results } = await stmt.all<{
    id: string;
    version: string | null;
    title: string;
    content: string;
    content_summary: string | null;
    published_at: string | null;
    fetched_at: string;
    url: string | null;
    media: string | null;
    source_slug: string;
    source_name: string;
    source_type: string;
  }>();

  const hasMore = results.length > limit;
  const pageRows = hasMore ? results.slice(0, limit) : results;

  // Build next cursor from last item
  let nextCursor: string | null = null;
  if (hasMore && pageRows.length > 0) {
    const last = pageRows[pageRows.length - 1];
    nextCursor = last.published_at
      ? `${last.published_at}|${last.id}`
      : null;
  }

  const releasesFormatted = pageRows.map((r) => ({
    id: r.id,
    version: r.version,
    title: r.title,
    summary: r.content_summary ?? (r.content.length > 150 ? r.content.slice(0, 150) + "..." : r.content),
    content: r.content,
    publishedAt: r.published_at,
    url: r.url,
    media: JSON.parse(r.media ?? "[]").map((m: any) => ({
      ...m,
      r2Url: m.r2Key ? `/api/media/${m.r2Key}` : undefined,
    })),
    source: {
      slug: r.source_slug,
      name: r.source_name,
      type: r.source_type,
    },
  }));

  return c.json({
    releases: releasesFormatted,
    pagination: { nextCursor, limit },
  });
});
```

**Important:** Look at how other routes in this file use `c.env.DB.prepare()` for raw SQL (the activity endpoint does this). Use the same pattern — don't mix Drizzle `db.all(sql...)` with D1 prepared statements. Pick whichever the file already uses for raw queries.

- [ ] **Step 2: Verify the route compiles**

Run: `cd workers/api && npx tsc --noEmit`
Expected: No type errors.

- [ ] **Step 3: Commit**

```bash
git add workers/api/src/routes/orgs.ts
git commit -m "feat: add GET /api/orgs/:slug/releases endpoint with cursor pagination"
```

---

### Task 2: API Client Types and Method

**Files:**
- Modify: `web/src/lib/api.ts`

- [ ] **Step 1: Add the new types**

Add after the existing `OrgActivity` interface (around line 142):

```typescript
export interface OrgReleaseItem extends ReleaseItem {
  source: { slug: string; name: string; type: string };
}

export interface OrgReleasesResponse {
  releases: OrgReleaseItem[];
  pagination: { nextCursor: string | null; limit: number };
}
```

- [ ] **Step 2: Add the API method**

Add to the `api` object (after `orgActivity`):

```typescript
orgReleases: (slug: string, cursor?: string, limit = 20) => {
  const params = new URLSearchParams();
  if (cursor) params.set("cursor", cursor);
  if (limit !== 20) params.set("limit", String(limit));
  const qs = params.toString();
  return fetchApi<OrgReleasesResponse>(`/api/orgs/${slug}/releases${qs ? `?${qs}` : ""}`);
},
```

- [ ] **Step 3: Type-check**

Run: `cd web && npx tsc --noEmit`
Expected: No type errors.

- [ ] **Step 4: Commit**

```bash
git add web/src/lib/api.ts
git commit -m "feat: add orgReleases API client method and types"
```

---

### Task 3: `ReleaseListItem` — Add Source Byline

**Files:**
- Modify: `web/src/components/release-item.tsx`

- [ ] **Step 1: Update the component signature and add byline**

Change the function signature at line 144 from:

```typescript
export function ReleaseListItem({ release, hideDate }: { release: ReleaseItem; hideDate?: boolean }) {
```

to:

```typescript
export function ReleaseListItem({ release, hideDate, sourceByline }: { release: ReleaseItem; hideDate?: boolean; sourceByline?: { name: string; slug: string; orgSlug?: string } }) {
```

Then add the byline rendering. After the `showSubtitle` line (line 205) that renders:

```typescript
{showSubtitle && <div className="text-sm text-stone-600 dark:text-stone-400 mb-1">{release.title}</div>}
```

Add immediately after it:

```typescript
{sourceByline && (
  <div className="text-[12px] text-stone-400 dark:text-stone-500 mb-1">
    via{" "}
    {sourceByline.orgSlug ? (
      <Link href={`/${sourceByline.orgSlug}/${sourceByline.slug}`} className="text-stone-500 dark:text-stone-400 font-medium hover:text-stone-700 dark:hover:text-stone-300" onClick={(e) => e.stopPropagation()}>
        {sourceByline.name}
      </Link>
    ) : (
      <span className="text-stone-500 dark:text-stone-400 font-medium">{sourceByline.name}</span>
    )}
  </div>
)}
```

Note: `Link` is already imported at the top of this file.

- [ ] **Step 2: Type-check**

Run: `cd web && npx tsc --noEmit`
Expected: No type errors.

- [ ] **Step 3: Commit**

```bash
git add web/src/components/release-item.tsx
git commit -m "feat: add optional sourceByline prop to ReleaseListItem"
```

---

### Task 4: `OrgTabs` Component

**Files:**
- Create: `web/src/components/org-tabs.tsx`

- [ ] **Step 1: Create the component**

Model this on `web/src/components/source-tabs.tsx`. Write to `web/src/components/org-tabs.tsx`:

```typescript
"use client";

import { useSearchParams, useRouter, usePathname } from "next/navigation";

export function OrgTabs() {
  const searchParams = useSearchParams();
  const router = useRouter();
  const pathname = usePathname();

  const activeTab = searchParams.get("tab") ?? "sources";

  function setTab(tab: string) {
    const params = new URLSearchParams(searchParams.toString());
    if (tab === "sources") {
      params.delete("tab");
    } else {
      params.set("tab", tab);
    }
    const qs = params.toString();
    router.push(qs ? `${pathname}?${qs}` : pathname, { scroll: false });
  }

  const tabClass = (tab: string) =>
    `pb-2.5 text-[13px] font-medium border-b-2 transition-colors ${
      activeTab === tab
        ? "border-stone-900 dark:border-stone-100 text-stone-900 dark:text-stone-100"
        : "border-transparent text-stone-400 hover:text-stone-600 dark:hover:text-stone-300"
    }`;

  return (
    <div className="flex gap-5 border-b border-stone-200 dark:border-stone-800 mt-5">
      <button onClick={() => setTab("sources")} className={tabClass("sources")}>
        Sources
      </button>
      <button onClick={() => setTab("releases")} className={tabClass("releases")}>
        Releases
      </button>
    </div>
  );
}
```

- [ ] **Step 2: Type-check**

Run: `cd web && npx tsc --noEmit`
Expected: No type errors.

- [ ] **Step 3: Commit**

```bash
git add web/src/components/org-tabs.tsx
git commit -m "feat: add OrgTabs component for sources/releases tab switching"
```

---

### Task 5: `OrgReleaseList` Client Component

**Files:**
- Create: `web/src/components/org-release-list.tsx`

- [ ] **Step 1: Create the component**

This is a client component that receives the initial page of releases (SSR'd) and handles "Load more" client-side.

Write to `web/src/components/org-release-list.tsx`:

```typescript
"use client";

import { useState, useCallback } from "react";
import { ReleaseListItem } from "./release-item";
import type { OrgReleaseItem } from "@/lib/api";

interface OrgReleaseListProps {
  orgSlug: string;
  initialReleases: OrgReleaseItem[];
  initialCursor: string | null;
  multipleSourcesExist: boolean;
}

export function OrgReleaseList({
  orgSlug,
  initialReleases,
  initialCursor,
  multipleSourcesExist,
}: OrgReleaseListProps) {
  const [releases, setReleases] = useState(initialReleases);
  const [cursor, setCursor] = useState(initialCursor);
  const [loading, setLoading] = useState(false);

  const loadMore = useCallback(async () => {
    if (!cursor || loading) return;
    setLoading(true);
    try {
      const params = new URLSearchParams({ cursor });
      const res = await fetch(`/api/org-releases/${orgSlug}?${params}`);
      const data = await res.json();
      setReleases((prev) => [...prev, ...data.releases]);
      setCursor(data.pagination.nextCursor);
    } finally {
      setLoading(false);
    }
  }, [cursor, loading, orgSlug]);

  if (releases.length === 0) {
    return (
      <div className="text-center py-12 text-stone-400 dark:text-stone-500 text-sm">
        No releases yet.
      </div>
    );
  }

  return (
    <div>
      {releases.map((release, i) => (
        <ReleaseListItem
          key={release.id ?? i}
          release={release}
          hideDate={
            i > 0 &&
            release.publishedAt?.slice(0, 10) ===
              releases[i - 1].publishedAt?.slice(0, 10)
          }
          sourceByline={
            multipleSourcesExist
              ? { name: release.source.name, slug: release.source.slug, orgSlug }
              : undefined
          }
        />
      ))}
      {cursor && (
        <div className="text-center py-6">
          <button
            onClick={loadMore}
            disabled={loading}
            className="px-5 py-2 text-[13px] font-medium text-stone-500 dark:text-stone-400 bg-white dark:bg-stone-900 border border-stone-200 dark:border-stone-700 rounded-md hover:border-stone-300 dark:hover:border-stone-600 transition-colors disabled:opacity-50"
          >
            {loading ? "Loading..." : "Load more"}
          </button>
        </div>
      )}
    </div>
  );
}
```

**Important note on the client-side fetch URL:** The `fetch()` call above uses `/api/org-releases/${orgSlug}` as a placeholder. This needs a Next.js API route that proxies to the worker API, OR the component needs to call the worker API URL directly. Check how the existing app handles client-side data fetching — look for any existing pattern (e.g., a Next.js route handler in `web/src/app/api/`, or direct worker API calls with auth headers). Match whatever pattern exists. If the app only does server-side fetching today, you'll need to add a thin Next.js route handler:

Create `web/src/app/api/org-releases/[slug]/route.ts`:

```typescript
import { NextRequest, NextResponse } from "next/server";

const API_URL = process.env.RELEASED_API_URL ?? "http://localhost:3456";
const API_SECRET = process.env.RELEASED_API_KEY;

export async function GET(req: NextRequest, { params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const cursor = req.nextUrl.searchParams.get("cursor") ?? "";
  const limit = req.nextUrl.searchParams.get("limit") ?? "20";

  const qs = new URLSearchParams();
  if (cursor) qs.set("cursor", cursor);
  if (limit !== "20") qs.set("limit", limit);

  const headers: Record<string, string> = {};
  if (API_SECRET) headers["Authorization"] = `Bearer ${API_SECRET}`;

  const res = await fetch(`${API_URL}/api/orgs/${slug}/releases?${qs}`, { headers });
  const data = await res.json();
  return NextResponse.json(data);
}
```

Check the existing codebase first — if there's already a proxy pattern or the frontend calls the API directly, use that instead.

- [ ] **Step 2: Type-check**

Run: `cd web && npx tsc --noEmit`
Expected: No type errors.

- [ ] **Step 3: Commit**

```bash
git add web/src/components/org-release-list.tsx web/src/app/api/org-releases/
git commit -m "feat: add OrgReleaseList component with load-more pagination"
```

---

### Task 6: Wire Up the Org Page

**Files:**
- Modify: `web/src/app/[orgSlug]/page.tsx`

- [ ] **Step 1: Add imports and data fetching**

Add imports at the top of the file:

```typescript
import { OrgTabs } from "@/components/org-tabs";
import { OrgReleaseList } from "@/components/org-release-list";
```

Update the page component to accept `searchParams` and fetch releases when the "releases" tab is active. Change the function signature from:

```typescript
export default async function OrgPage({
  params,
}: {
  params: Promise<{ orgSlug: string }>;
}) {
```

to:

```typescript
export default async function OrgPage({
  params,
  searchParams,
}: {
  params: Promise<{ orgSlug: string }>;
  searchParams: Promise<{ tab?: string }>;
}) {
```

After the existing `[org, activity]` fetch block (after line 65), add:

```typescript
const { tab } = await searchParams;
const showReleases = tab === "releases";

let initialReleases: import("@/lib/api").OrgReleasesResponse | null = null;
if (showReleases) {
  try {
    initialReleases = await api.orgReleases(orgSlug);
  } catch {
    initialReleases = null;
  }
}
```

- [ ] **Step 2: Add tabs and conditional rendering**

Replace the current content area (the `<div className="flex-1 min-w-0">` block, lines 121-129) with:

```typescript
<div className="flex-1 min-w-0">
  <OrgTabs />
  {showReleases ? (
    initialReleases ? (
      <OrgReleaseList
        orgSlug={orgSlug}
        initialReleases={initialReleases.releases}
        initialCursor={initialReleases.pagination.nextCursor}
        multipleSourcesExist={org.sources.length > 1}
      />
    ) : (
      <div className="text-center py-12 text-stone-400 dark:text-stone-500 text-sm">
        No releases yet.
      </div>
    )
  ) : activity ? (
    <ReleaseTimeline activity={activity} orgSlug={org.slug} sources={org.sources} />
  ) : (
    <div className="mt-6">
      <SourceList org={org} orgSlug={orgSlug} />
    </div>
  )}
</div>
```

- [ ] **Step 3: Type-check**

Run: `cd web && npx tsc --noEmit`
Expected: No type errors.

- [ ] **Step 4: Commit**

```bash
git add web/src/app/[orgSlug]/page.tsx
git commit -m "feat: add Sources/Releases tabs to org page with combined feed"
```

---

### Task 7: Deploy and Test

- [ ] **Step 1: Deploy the API worker**

Run: `cd workers/api && wrangler deploy`
Expected: Successful deployment with the new route available.

- [ ] **Step 2: Test the API endpoint**

Run: `curl -s "https://<api-url>/api/orgs/anthropic/releases?limit=3" -H "Authorization: Bearer $RELEASED_API_KEY" | jq .`

Expected: JSON response with `releases` array (each item has `source` object) and `pagination.nextCursor`.

- [ ] **Step 3: Test cursor pagination**

Take the `nextCursor` from step 2 and:

Run: `curl -s "https://<api-url>/api/orgs/anthropic/releases?limit=3&cursor=<nextCursor>" -H "Authorization: Bearer $RELEASED_API_KEY" | jq .`

Expected: Next page of results, no overlap with first page.

- [ ] **Step 4: Test the web UI locally**

Run: `cd web && bun dev`

1. Navigate to an org page (e.g., `/anthropic`)
2. Verify "Sources" tab is active by default, showing existing content
3. Click "Releases" tab — should show combined feed with source bylines
4. Click "Load more" — should append more releases
5. For a single-source org, verify no "via" byline appears

- [ ] **Step 5: Commit any fixes**

If any adjustments were needed during testing, commit them.
