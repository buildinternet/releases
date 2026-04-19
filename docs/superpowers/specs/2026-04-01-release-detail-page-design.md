# Release Detail Page

Direct-linkable release view with full content, media, and source attribution.

## Scope

1. **Release detail page** — `/release/[id]` in the web app, server-rendered
2. **Release ID in list responses** — include `id` field in source detail release arrays
3. **Flexible API identifiers** — source and org API routes accept either slug or ID
4. **Permalink from list items** — subtle link icon on `ReleaseListItem`
5. **Worker deployment** — deploy API changes via wrangler before testing

## Route

`/release/[id]/page.tsx` — Next.js server component. The `[id]` param is the canonical release ID (e.g., `rel_abc123`).

## API Changes

### New: `api.release(id)` client method

Add to `web/src/lib/api.ts`. Calls `GET /api/releases/:id` which already exists in the worker.

### Update: Include `id` in release list responses

The `GET /api/sources/:slug` response currently maps releases but drops the `id` field. Include it so `ReleaseListItem` can build permalink URLs.

Affects: `workers/api/src/routes/sources.ts` — the release mapping in the source detail handler.

### Update: Source/org routes accept slug or ID

Update `GET /api/sources/:slugOrId` and `GET /api/orgs/:slugOrId` to resolve by either:

- Slug (existing behavior, string like `nodejs`)
- Canonical ID (e.g., `src_abc123` or `org_abc123`)

Detection: check if the param matches the ID prefix pattern (`src_`, `org_`), otherwise treat as slug.

## Page Layout

### Header

- Version as primary heading (fall back to title if no version)
- Published date, formatted consistently with list items

### Attribution

- Source name with type icon, linking back to the source page
- Org-aware linking: `/[orgSlug]/[sourceSlug]` for org sources, `/source/[slug]` for independent
- External link to original changelog URL if available

### Content

- Full markdown rendering — reuse existing markdown pipeline from `ReleaseListItem`
- No collapse/truncation (unlike list view)
- Embedded video support (YouTube, Vimeo, Loom)

### Media

- Attached media displayed prominently at full width
- Use `r2Url` when available, fall back to `sourceUrl`

## ReleaseListItem Changes

Add a subtle permalink icon (link/chain icon) to each release in the list view. Clicking navigates to `/release/[id]`. The icon should be unobtrusive — appears on hover or as a muted icon alongside the version/date header.

Requires: `ReleaseItem` interface gains an `id` field.

## Data Flow

```
ReleaseListItem (click permalink)
  → /release/[id]
    → api.release(id)
      → GET /api/releases/:id (worker)
        → DB lookup by ID
          → Return full release with source name, slug, org info
```

## Deployment

Worker API changes must be deployed before the web app can use them:

```bash
cd workers/api && wrangler deploy
```

## Future

- Related releases (same source, nearby versions)
- Social/OpenGraph meta tags for link previews
- Breadcrumb navigation back to source/org
