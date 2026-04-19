# Org Combined Release Feed

Combined chronological release feed across all sources in an organization, accessible via API endpoint and web UI tab.

## Scope

1. **API endpoint** — `GET /api/orgs/:slug/releases` with cursor-based pagination
2. **Web UI tabs** — "Sources" and "Releases" tabs on the org page
3. **Source attribution** — "via Source Name" byline on release items when org has multiple sources
4. **Load more** — client-side cursor pagination with "Load more" button

## API

### New: `GET /api/orgs/:slug/releases`

Returns a combined, chronological feed of all releases across the org's sources.

**Query params:**

- `cursor` — ISO 8601 timestamp (`publishedAt` of last item from previous page). Omit for first page.
- `limit` — items per page. Default 20, max 100.

**Response shape:**

```json
{
  "releases": [
    {
      "id": "rel_abc123",
      "version": "v1.0.33",
      "title": "v1.0.33",
      "summary": "Added support for...",
      "content": "Full markdown...",
      "publishedAt": "2026-03-31T12:00:00Z",
      "url": "https://...",
      "media": [],
      "source": {
        "slug": "claude-code",
        "name": "Claude Code",
        "type": "feed"
      }
    }
  ],
  "pagination": {
    "nextCursor": "2026-03-29T08:00:00Z",
    "limit": 20
  }
}
```

`pagination.nextCursor` is `null` when there are no more results.

**Sorting:** `publishedAt DESC`, with `id DESC` as tiebreaker for identical timestamps. Falls back to `fetchedAt DESC` for releases without a publish date. Matches the existing source detail sort.

**Cursor tiebreaker:** The cursor is a `publishedAt` timestamp. For releases sharing the same timestamp, `id` provides a stable secondary sort. The `WHERE` clause uses `(publishedAt < cursor) OR (publishedAt = cursor AND id < lastId)` to avoid skipping or duplicating items. The cursor value encodes both: `{publishedAt}|{id}`.

**Filtering:** Suppressed releases are excluded. No per-source filtering — always returns all sources.

**Query strategy:** Resolve the org's source IDs, then query releases with `inArray(sourceId, orgSourceIds)`. Join source name/slug/type for attribution. The existing `(sourceId, publishedAt)` composite index supports this.

### API client addition

Add to `web/src/lib/api.ts`:

```typescript
orgReleases: (slug: string, cursor?: string, limit?: number) =>
  fetchApi<OrgReleasesResponse>(`/api/orgs/${slug}/releases?...`);
```

New type:

```typescript
export interface OrgReleaseItem extends ReleaseItem {
  source: { slug: string; name: string; type: string };
}

export interface OrgReleasesResponse {
  releases: OrgReleaseItem[];
  pagination: { nextCursor: string | null; limit: number };
}
```

## Web UI

### Org page tabs

Add an `OrgTabs` component to the org page, following the same pattern as the existing `SourceTabs`:

- Two tabs: "Sources" (default) and "Releases"
- Driven by `?tab=` query param
- "Sources" tab renders the existing content (timeline + source cards)
- "Releases" tab renders the new combined feed

### Combined feed component (`OrgReleaseList`)

Client component that manages the "Load more" state:

- First page of releases fetched server-side (SSR)
- "Load more" button at the bottom fetches the next cursor client-side and appends
- Reuses the existing `ReleaseListItem` component

### Source attribution on `ReleaseListItem`

Add an optional `sourceByline` prop to `ReleaseListItem`:

```typescript
sourceByline?: { name: string; slug: string }
```

When present, renders a `via {name}` line below the version heading. The source name links to the source page (`/{orgSlug}/{sourceSlug}`).

The org page only passes `sourceByline` when `org.sources.length > 1`. Single-source orgs show the same clean layout as individual source pages.

## Worker route

New route in `workers/api/src/routes/orgs.ts`:

```typescript
app.get("/api/orgs/:slug/releases", async (c) => {
  // 1. Resolve org by slug
  // 2. Get all source IDs for org
  // 3. Query releases joined with sources
  //    WHERE sourceId IN (orgSourceIds) AND suppressed = false
  //    ORDER BY publishedAt DESC (with fetchedAt fallback)
  //    WHERE publishedAt < cursor (if cursor provided)
  //    LIMIT limit + 1 (to detect next page)
  // 4. Return releases with source attribution + pagination
});
```

## CLI

No changes needed. The existing `latest --org <slug>` command already supports org-scoped release listing via `getLatestReleases()`.

## Files to modify

- `workers/api/src/routes/orgs.ts` — new `/api/orgs/:slug/releases` route
- `web/src/lib/api.ts` — new types and `api.orgReleases()` method
- `web/src/app/[orgSlug]/page.tsx` — add tab system, conditionally render sources vs releases
- `web/src/components/org-tabs.tsx` — new component (follows `SourceTabs` pattern)
- `web/src/components/org-release-list.tsx` — new client component for combined feed with load-more
- `web/src/components/release-item.tsx` — add optional `sourceByline` prop
