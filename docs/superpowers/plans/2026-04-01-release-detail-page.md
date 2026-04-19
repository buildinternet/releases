# Release Detail Page Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a direct-linkable release detail page at `/release/[id]` with full content, media, and source attribution, plus permalink icons in release list items.

**Architecture:** Enhance the existing `GET /api/releases/:id` worker endpoint to include org info and source type. Add `id` to release list responses. Add an `api.release()` client method. Create a new Next.js page at `/release/[id]`. Update source/org worker routes to resolve by slug or ID. Add permalink to `ReleaseListItem`.

**Tech Stack:** Next.js (App Router), Hono (Cloudflare Worker), Drizzle ORM, React, Tailwind CSS

---

## File Map

- **Modify:** `workers/api/src/routes/sources.ts` — enhance `GET /releases/:id` response, add `id` to source detail release list, accept slug-or-ID on source routes
- **Modify:** `workers/api/src/routes/orgs.ts` — accept slug-or-ID on org routes
- **Modify:** `web/src/lib/api.ts` — add `ReleaseDetail` interface and `api.release()` method, add `id` to `ReleaseItem`
- **Create:** `web/src/app/release/[id]/page.tsx` — release detail page
- **Modify:** `web/src/components/release-item.tsx` — add permalink icon

---

### Task 1: Enhance `GET /api/releases/:id` to include org info and source type

The current endpoint returns `sourceName` and `sourceSlug` but not the org slug/name or source type. The detail page needs these for attribution and back-linking.

**Files:**

- Modify: `workers/api/src/routes/sources.ts:701-718`

- [ ] **Step 1: Update the release detail query to join organizations**

In `workers/api/src/routes/sources.ts`, replace the existing `GET /releases/:id` handler (lines 701-718) with:

```typescript
sourceRoutes.get("/releases/:id", async (c) => {
  const db = createDb(c.env.DB);
  const id = c.req.param("id");

  const rows = await db
    .select({
      release: releases,
      sourceName: sources.name,
      sourceSlug: sources.slug,
      sourceType: sources.type,
      orgId: sources.orgId,
    })
    .from(releases)
    .leftJoin(sources, eq(releases.sourceId, sources.id))
    .where(eq(releases.id, id));

  if (rows.length === 0) return c.json({ error: "not_found", message: "Release not found" }, 404);

  const { release, sourceName, sourceSlug, sourceType, orgId } = rows[0];

  let org: { slug: string; name: string } | null = null;
  if (orgId) {
    const [orgRow] = await db
      .select({ slug: organizations.slug, name: organizations.name })
      .from(organizations)
      .where(eq(organizations.id, orgId));
    org = orgRow ?? null;
  }

  return c.json({ ...release, sourceName, sourceSlug, sourceType, org });
});
```

- [ ] **Step 2: Verify the build**

Run: `cd workers/api && npx tsc --noEmit`
Expected: No type errors

- [ ] **Step 3: Commit**

```bash
git add workers/api/src/routes/sources.ts
git commit -m "feat: include org info and source type in release detail API response"
```

---

### Task 2: Add `id` to source detail release list response

The source detail endpoint maps releases but drops the `id` field. List items need it to build permalink URLs.

**Files:**

- Modify: `workers/api/src/routes/sources.ts:455-485`

- [ ] **Step 1: Add `id` to the release SQL select and mapping**

In `workers/api/src/routes/sources.ts`, update the raw SQL query for releases in the `GET /sources/:slug` handler (around line 463) to include `id`:

Change the SQL from:

```sql
SELECT version, title, content_summary, content, published_at, url, media
```

to:

```sql
SELECT id, version, title, content_summary, content, published_at, url, media
```

Update the type annotation to include `id: string`:

```typescript
const releaseRows = await db.all<{
  id: string;
  version: string | null;
  title: string;
  content_summary: string | null;
  content: string;
  published_at: string | null;
  url: string | null;
  media: string | null;
}>(sql`...`);
```

And add `id` to the mapping (around line 472):

```typescript
const releasesFormatted = releaseRows.map((r) => ({
  id: r.id,
  version: r.version,
  title: r.title,
  summary:
    r.content_summary ?? (r.content.length > 150 ? r.content.slice(0, 150) + "..." : r.content),
  content: r.content,
  publishedAt: r.published_at,
  url: r.url,
  media: JSON.parse(r.media ?? "[]").map((m: any) => ({
    ...m,
    r2Url: m.r2Key ? `/api/media/${m.r2Key}` : undefined,
  })),
}));
```

- [ ] **Step 2: Verify the build**

Run: `cd workers/api && npx tsc --noEmit`
Expected: No type errors

- [ ] **Step 3: Commit**

```bash
git add workers/api/src/routes/sources.ts
git commit -m "feat: include release id in source detail response"
```

---

### Task 3: Source and org routes accept slug or ID

Update the lookup logic so `GET /api/sources/:slugOrId` and `GET /api/orgs/:slugOrId` resolve by either slug or canonical ID. IDs use prefixes like `src_` and `org_`.

**Files:**

- Modify: `workers/api/src/routes/sources.ts` — source detail handler (line 431)
- Modify: `workers/api/src/routes/orgs.ts` — org detail handler (line 61)

- [ ] **Step 1: Update source detail route to resolve by slug or ID**

In `workers/api/src/routes/sources.ts`, in the `GET /sources/:slug` handler (line 431), change the lookup from:

```typescript
const [src] = await db.select().from(sources).where(eq(sources.slug, slug));
```

to:

```typescript
const [src] = await db
  .select()
  .from(sources)
  .where(slug.startsWith("src_") ? eq(sources.id, slug) : eq(sources.slug, slug));
```

- [ ] **Step 2: Update org detail route to resolve by slug or ID**

In `workers/api/src/routes/orgs.ts`, in the `GET /orgs/:slug` handler (line 61), change the lookup from:

```typescript
const [org] = await db.select().from(organizations).where(eq(organizations.slug, slug));
```

to:

```typescript
const slug = c.req.param("slug");
const [org] = await db
  .select()
  .from(organizations)
  .where(slug.startsWith("org_") ? eq(organizations.id, slug) : eq(organizations.slug, slug));
```

- [ ] **Step 3: Verify the build**

Run: `cd workers/api && npx tsc --noEmit`
Expected: No type errors

- [ ] **Step 4: Commit**

```bash
git add workers/api/src/routes/sources.ts workers/api/src/routes/orgs.ts
git commit -m "feat: source and org API routes accept slug or canonical ID"
```

---

### Task 4: Deploy worker

The web app points at the remote API, so worker changes must be deployed before the frontend can use them.

- [ ] **Step 1: Deploy the worker**

Run: `cd workers/api && wrangler deploy`
Expected: Successful deployment with the new endpoints

- [ ] **Step 2: Verify the release detail endpoint**

Run: `curl -s -H "Authorization: Bearer $RELEASED_API_KEY" "$RELEASED_API_URL/api/sources/claude-code?page=1&pageSize=1" | jq '.releases[0].id'`
Expected: A release ID string (e.g., `"rel_abc123..."`)

---

### Task 5: Add `ReleaseDetail` interface and `api.release()` to web client

**Files:**

- Modify: `web/src/lib/api.ts`

- [ ] **Step 1: Add `id` to the `ReleaseItem` interface**

In `web/src/lib/api.ts`, update the `ReleaseItem` interface (line 88) to include `id`:

```typescript
export interface ReleaseItem {
  id?: string;
  version: string | null;
  title: string;
  summary: string;
  content?: string;
  publishedAt: string | null;
  url: string | null;
  media?: Array<{ type: "image" | "video" | "gif"; url: string; alt?: string; r2Url?: string }>;
}
```

- [ ] **Step 2: Add `ReleaseDetail` interface**

Add after the `ReleaseItem` interface:

```typescript
export interface ReleaseDetail {
  id: string;
  sourceId: string;
  version: string | null;
  title: string;
  content: string;
  contentSummary: string | null;
  url: string | null;
  media: string;
  publishedAt: string | null;
  fetchedAt: string;
  sourceName: string;
  sourceSlug: string;
  sourceType: string;
  org: { slug: string; name: string } | null;
}
```

- [ ] **Step 3: Add `api.release()` method**

Add to the `api` object (around line 148, before the closing `}`):

```typescript
release: (id: string) => fetchApi<ReleaseDetail>(`/api/releases/${id}`),
```

- [ ] **Step 4: Verify the build**

Run: `cd web && npx tsc --noEmit`
Expected: No type errors

- [ ] **Step 5: Commit**

```bash
git add web/src/lib/api.ts
git commit -m "feat: add release detail API client method and types"
```

---

### Task 6: Create release detail page

**Files:**

- Create: `web/src/app/release/[id]/page.tsx`

- [ ] **Step 1: Create the release detail page**

Create `web/src/app/release/[id]/page.tsx`:

```tsx
import { notFound } from "next/navigation";
import Link from "next/link";
import { api, ApiSetupError } from "@/lib/api";
import { Header } from "@/components/header";
import { SetupMessage } from "@/components/setup-message";
import { SourceTypeIcon } from "@/components/source-type-icon";
import { ReleaseContent } from "./release-content";

function formatDate(iso: string | null) {
  if (!iso) return null;
  return new Date(iso).toLocaleDateString("en-US", {
    month: "long",
    day: "numeric",
    year: "numeric",
  });
}

export default async function ReleaseDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;

  let release;
  try {
    release = await api.release(id);
  } catch (err) {
    if (err instanceof ApiSetupError) {
      return (
        <div className="min-h-screen">
          <Header />
          <SetupMessage message={err.message} steps={err.setup} />
        </div>
      );
    }
    notFound();
  }

  const sourcePath = release.org
    ? `/${release.org.slug}/${release.sourceSlug}`
    : `/source/${release.sourceSlug}`;

  const media = JSON.parse(release.media || "[]").map((m: any) => ({
    ...m,
    r2Url: m.r2Key ? `/api/media/${m.r2Key}` : undefined,
  }));

  const hasVersion = !!release.version;
  const titleMatchesVersion =
    release.title === release.version ||
    release.title === release.version?.replace(/^v/, "") ||
    release.version === release.title?.replace(/^v/, "");

  const heading = hasVersion ? release.version : release.title;
  const showSubtitle = hasVersion && release.title && !titleMatchesVersion;

  return (
    <div className="min-h-screen">
      <Header />
      <div className="max-w-3xl mx-auto px-6">
        {/* Breadcrumb */}
        <div className="pt-5 text-[13px] text-stone-400 dark:text-stone-500">
          {release.org && (
            <>
              <Link
                href={`/${release.org.slug}`}
                className="hover:text-stone-600 dark:hover:text-stone-300"
              >
                {release.org.name}
              </Link>
              <span className="mx-1.5">/</span>
            </>
          )}
          <Link href={sourcePath} className="hover:text-stone-600 dark:hover:text-stone-300">
            {release.sourceName}
          </Link>
          <span className="mx-1.5">/</span>
          <span className="text-stone-600 dark:text-stone-300 font-medium">{heading}</span>
        </div>

        {/* Header */}
        <div className="mt-6 mb-6">
          <div className="flex items-center gap-2.5">
            <h1 className="text-[28px] font-bold tracking-tight text-stone-900 dark:text-stone-100">
              {heading}
            </h1>
          </div>
          {showSubtitle && (
            <p className="text-lg text-stone-600 dark:text-stone-400 mt-1">{release.title}</p>
          )}
          <div className="flex items-center gap-3 mt-3 text-[13px] text-stone-400 dark:text-stone-500">
            {release.publishedAt && <span>{formatDate(release.publishedAt)}</span>}
            <span className="flex items-center gap-1.5">
              <SourceTypeIcon type={release.sourceType} size={14} />
              <Link href={sourcePath} className="hover:text-stone-600 dark:hover:text-stone-300">
                {release.sourceName}
              </Link>
            </span>
            {release.url && (
              <a
                href={release.url}
                target="_blank"
                rel="noopener noreferrer"
                className="hover:text-stone-600 dark:hover:text-stone-300"
              >
                View original ↗
              </a>
            )}
          </div>
        </div>

        {/* Content */}
        <div className="pb-12">
          <ReleaseContent content={release.content} title={release.title} media={media} />
        </div>
      </div>
    </div>
  );
}
```

- [ ] **Step 2: Create the client component for markdown rendering**

Create `web/src/app/release/[id]/release-content.tsx`:

```tsx
"use client";

import { useMemo } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";

interface MediaItem {
  type: "image" | "video" | "gif";
  url: string;
  alt?: string;
  r2Url?: string;
}

/** Strip a leading markdown heading that duplicates the release title */
function stripLeadingTitle(content: string, title: string | null): string {
  if (!title || !content) return content;
  const firstNewline = content.indexOf("\n");
  if (firstNewline === -1) return content;
  const firstLine = content
    .slice(0, firstNewline)
    .replace(/^#+\s+/, "")
    .trim();
  if (firstLine.toLowerCase() === title.toLowerCase()) {
    return content.slice(firstNewline + 1).trimStart();
  }
  return content;
}

/* eslint-disable @typescript-eslint/no-explicit-any */
const markdownComponents: Record<string, any> = {
  img: (props: any) => {
    const src = props.src as string | undefined;
    if (!src || typeof src !== "string") return null;
    return (
      <img
        src={src}
        alt={props.alt || ""}
        loading="lazy"
        className="rounded-md max-w-full h-auto my-3"
      />
    );
  },
  a: (props: any) => {
    const href = props.href as string | undefined;
    const children = props.children;
    if (!href) return <>{children}</>;

    const ytMatch = href.match(/(?:youtube\.com\/watch\?v=|youtu\.be\/)([^&?]+)/);
    if (ytMatch) {
      return (
        <div className="my-4 aspect-video max-w-2xl">
          <iframe
            src={`https://www.youtube.com/embed/${ytMatch[1]}`}
            className="w-full h-full rounded-md"
            allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture"
            allowFullScreen
            loading="lazy"
          />
        </div>
      );
    }

    const vimeoMatch = href.match(/vimeo\.com\/(\d+)/);
    if (vimeoMatch) {
      return (
        <div className="my-4 aspect-video max-w-2xl">
          <iframe
            src={`https://player.vimeo.com/video/${vimeoMatch[1]}`}
            className="w-full h-full rounded-md"
            allow="autoplay; fullscreen; picture-in-picture"
            allowFullScreen
            loading="lazy"
          />
        </div>
      );
    }

    const loomMatch = href.match(/loom\.com\/share\/([^?&]+)/);
    if (loomMatch) {
      return (
        <div className="my-4 aspect-video max-w-2xl">
          <iframe
            src={`https://www.loom.com/embed/${loomMatch[1]}`}
            className="w-full h-full rounded-md"
            allowFullScreen
            loading="lazy"
          />
        </div>
      );
    }

    return (
      <a href={href} target="_blank" rel="noopener noreferrer">
        {children}
      </a>
    );
  },
};

function MediaGallery({ media, content }: { media: MediaItem[]; content: string }) {
  if (!media || media.length === 0) return null;
  const extra = media.filter((m) => !content.includes(m.url));
  if (extra.length === 0) return null;

  return (
    <div className="flex flex-wrap gap-3 mt-4">
      {extra.map((item, i) => {
        if (item.type === "image" || item.type === "gif") {
          const src = item.r2Url ?? item.url;
          return (
            <img
              key={i}
              src={src}
              alt={item.alt || ""}
              loading="lazy"
              className="rounded-md max-w-full h-auto"
            />
          );
        }
        return null;
      })}
    </div>
  );
}

export function ReleaseContent({
  content,
  title,
  media,
}: {
  content: string;
  title: string;
  media: MediaItem[];
}) {
  const markdownContent = useMemo(() => stripLeadingTitle(content, title), [content, title]);

  return (
    <div className="prose prose-stone dark:prose-invert max-w-none text-[15px] leading-relaxed [&_h1]:text-lg [&_h1]:font-semibold [&_h1]:mt-4 [&_h1]:mb-2 [&_h2]:text-base [&_h2]:font-semibold [&_h2]:mt-4 [&_h2]:mb-2 [&_h3]:text-[15px] [&_h3]:font-semibold [&_h3]:mt-3 [&_h3]:mb-1 [&_ul]:my-2 [&_ul]:pl-5 [&_li]:my-0.5 [&_p]:my-2 [&_a]:text-stone-600 dark:[&_a]:text-stone-400 [&_a]:no-underline [&_code]:text-sm [&_code]:bg-stone-100 dark:[&_code]:bg-stone-800 [&_code]:px-1 [&_code]:rounded [&_code::before]:content-none [&_code::after]:content-none">
      <ReactMarkdown remarkPlugins={[remarkGfm]} components={markdownComponents}>
        {markdownContent}
      </ReactMarkdown>
      <MediaGallery media={media} content={markdownContent} />
    </div>
  );
}
```

- [ ] **Step 3: Verify the build**

Run: `cd web && npx tsc --noEmit`
Expected: No type errors

- [ ] **Step 4: Commit**

```bash
git add web/src/app/release/[id]/page.tsx web/src/app/release/[id]/release-content.tsx
git commit -m "feat: add release detail page at /release/[id]"
```

---

### Task 7: Add permalink icon to ReleaseListItem

**Files:**

- Modify: `web/src/components/release-item.tsx`

- [ ] **Step 1: Add permalink icon to the release header**

In `web/src/components/release-item.tsx`, update the `ReleaseListItem` component. Add a `Link` import at the top:

```typescript
import Link from "next/link";
```

Then in the header area (around line 186), after the external link `↗` anchor, add a permalink icon. The updated `<div className="flex items-baseline gap-1.5">` block should be:

```tsx
<div className="flex items-baseline gap-1.5">
  {isOverflowing ? (
    <span className="text-stone-300 dark:text-stone-600 text-sm">{expanded ? "▾" : "▸"}</span>
  ) : (
    <span className="text-stone-300 dark:text-stone-600 text-sm">·</span>
  )}
  <span className="font-semibold text-[15px] text-stone-900 dark:text-stone-100">{heading}</span>
  {release.url && (
    <a
      href={release.url}
      target="_blank"
      rel="noopener noreferrer"
      className="text-stone-300 dark:text-stone-600 hover:text-stone-500 dark:hover:text-stone-400 text-xs"
      onClick={(e) => e.stopPropagation()}
    >
      ↗
    </a>
  )}
  {release.id && (
    <Link
      href={`/release/${release.id}`}
      className="text-stone-300 dark:text-stone-600 hover:text-stone-500 dark:hover:text-stone-400 text-xs opacity-0 group-hover:opacity-100 transition-opacity"
      onClick={(e) => e.stopPropagation()}
      title="Permalink"
    >
      #
    </Link>
  )}
</div>
```

Note: The permalink uses `#` as the icon — minimal and subtle. We also need to add `group` to the parent `<div>` wrapping the entire release item. Update the outermost div (line 174) from:

```tsx
<div className="border-b border-stone-200 dark:border-stone-800 py-4 first:pt-0 last:border-b-0 -mx-2 px-2 rounded">
```

to:

```tsx
<div className="group/item border-b border-stone-200 dark:border-stone-800 py-4 first:pt-0 last:border-b-0 -mx-2 px-2 rounded">
```

And update the permalink's class to use `group-hover/item:opacity-100` instead of `group-hover:opacity-100` to avoid conflicts with the inner content group.

- [ ] **Step 2: Verify the build**

Run: `cd web && npx tsc --noEmit`
Expected: No type errors

- [ ] **Step 3: Commit**

```bash
git add web/src/components/release-item.tsx
git commit -m "feat: add subtle permalink icon to release list items"
```

---

### Task 8: Smoke test

- [ ] **Step 1: Start the dev server and verify**

Run: `cd web && bun dev`

Test in the browser:

1. Navigate to a source page (e.g., `/anthropic/claude-code`) — verify release list items show `#` permalink on hover
2. Click a permalink — verify it navigates to `/release/<id>`
3. Verify the release detail page shows: heading, date, source attribution with icon, breadcrumb, full content, media
4. Verify breadcrumb links work (back to source, back to org)
5. Verify the "View original" link opens the external changelog URL

- [ ] **Step 2: Test with a direct URL**

Navigate directly to a `/release/<id>` URL — verify it renders correctly without coming from a list page.
