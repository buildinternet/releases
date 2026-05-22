# Featured collections on the home page

**Date:** 2026-05-22
**Status:** Design approved, pending spec review

## Problem

Collections (curated cross-org playlists, e.g. "Coding Agents") exist but are only
discoverable via the `/collections` nav link. Nothing on the home page hints that
they exist. We want a small promotional block on the home page that surfaces one or
two collections — enough to signal the feature without dominating the page.

## Goals

- Surface a small number (cap: 2) of editorially-chosen collections on the home page.
- Give curators an in-app way to choose which collections are featured, without a deploy.
- Match the existing home-page and admin-menu conventions; no new visual language.

## Non-goals

- A second, full-width mobile/tablet treatment. At and above the `xl` breakpoint the block
  renders as the expanded sidebar card; below `xl` (where the sidebar is hidden) the same
  featured collections render in a compact, collapsed-by-default `<details>` disclosure
  above the org table. So they are exposed at every width — just not as a prominent
  full-width banner on small screens.
- A featured-ordering / weight system. Featured is a boolean; display order is by name,
  capped at 2 in the web component.
- CLI support for the `--featured` flag. The OSS CLI lives in a separate repo; the wire
  field is additive and can be adopted there later.

## Decisions

- **Selection mechanism:** a real `is_featured` boolean on `collections`, toggleable via
  the API (and the admin UI). Chosen over hardcoded slugs (no editorial control without a
  deploy) and over "top by member count" (no control; current ties).
- **Placement:** the home page's `xl`-only right sidebar, below the install steps.
- **Admin toggle:** a new per-entity `CollectionAdminMenu` dropdown on the collection
  detail page (`/collections/[slug]`), mirroring `org-admin-menu` / `source-admin-menu` /
  `release-admin-menu`. Gated by the same dev-only `isLocalAdminEnabled()` signal.
- **Seeding:** the migration only adds the column (default 0). The initial featured set
  (`coding-agents`, `frontier-ai-labs`) is applied as a **direct SQL UPDATE**, not a
  migration row.

## Architecture by layer

### 1. Data layer

Migration `workers/api/migrations/<timestamp>_add_collections_is_featured.sql`:

```sql
-- Per-collection "promote on the homepage" flag. When set, the collection
-- appears in the home page's featured-collections sidebar block. Default 0
-- (not featured). Mirrors organizations.is_hidden.
ALTER TABLE collections ADD COLUMN is_featured INTEGER NOT NULL DEFAULT 0;
```

Drizzle schema (`packages/core/src/schema.ts`, `collections` table):

```ts
isFeatured: integer("is_featured", { mode: "boolean" }).notNull().default(false),
```

### 2. Wire types (`packages/api-types/src/schemas/collections.ts`)

All additive:

- `CollectionListItemSchema` → `isFeatured: z.boolean()`
- `CollectionDetailSchema` → `isFeatured: z.boolean()`
- `CollectionRowSchema` → `isFeatured: z.boolean()`
- `UpdateCollectionRequestSchema` → `isFeatured: z.boolean().optional()`

Consumed in-repo via `workspace:*`, so no publish is required to wire this up. A version
bump for the OSS CLI's published pin is a separate, later concern.

### 3. API worker (`workers/api/src/routes/collections.ts`)

- `GET /v1/collections`:
  - Select `c.is_featured` in the raw count query; map `isFeatured` into each
    `CollectionListItem`.
  - Honor an optional `?featured=1` query param → `WHERE c.is_featured = 1`. (Validate to a
    boolean; absent/other → no filter.)
  - Document the param in the existing `describeRoute`. The route already appears in
    `/v1/openapi.json`, so the OpenAPI coverage gate stays satisfied — no allowlist change.
- `GET /v1/collections/:slug`: include `isFeatured` in the detail payload (the admin menu
  reads current state from it).
- `PATCH /v1/collections/:slug`: accept `body.isFeatured` → `updates.isFeatured`. No
  re-embed (featured status does not change embedded text — keep it out of the
  name/description re-embed branch).
- `rowToWire`: add `isFeatured: row.isFeatured`.

### 4. Web — home page promo block

- `web/src/lib/api.ts`: extend `collections(opts?: { featured?: boolean })` to append
  `?featured=1` when requested. The existing no-arg call stays back-compatible.
- `web/src/app/page.tsx`: add `api.collections({ featured: true })` to the existing
  `Promise.all`. Render a new `<FeaturedCollections collections={featured} />` inside the
  existing `xl`-only `<aside>`, below `<InstallStepsSidebar />`. An empty list renders
  nothing.
- New `web/src/components/featured-collections.tsx`:
  - A compact "Collections" heading.
  - Up to 2 cards (defensive `slice(0, 2)`), each a `Link` to `/collections/{slug}`
    showing: collection name, clamped description, and the member avatar stack (reuse the
    `MemberPreview` avatar-stack pattern already used on the collections list page; extract
    it to a shared component if cleaner than duplicating).
  - A "Browse all collections →" link to `/collections`.
  - No emojis (house style); use existing chip/avatar patterns.

### 5. Web — admin toggle

Mirror the existing per-entity admin menus:

- New `web/src/components/collection-admin-menu.tsx`: same dropdown shell as
  `OrgAdminMenu` (click-outside + Escape close, `useTransition`, `router.refresh()` on
  success). A single section with one toggle: "Feature on homepage" / "Unfeature",
  reflecting `isFeatured`.
- New server action `web/src/app/actions/collection-admin.ts`:
  `setCollectionFeaturedAction({ slug, featured })` → `PATCH /v1/collections/:slug
{ isFeatured: featured }` via `adminActionEnv()` (re-checks the gate server-side).
  On success `revalidatePath("/")`, `revalidatePath("/collections")`,
  `revalidatePath("/collections/${slug}")`.
- `web/src/app/collections/[slug]/page.tsx`: when `isLocalAdminEnabled()`, render
  `<CollectionAdminMenu slug={slug} isFeatured={detail.isFeatured} />` next to the title.
  Gate the render server-side so the menu never ships to production.

### 6. Seeding (manual, post-deploy)

After the column migration is applied (migrations auto-apply on merge to main), flag the
initial featured set with a direct SQL UPDATE against the target D1 — **not** a migration
row:

```sql
UPDATE collections SET is_featured = 1 WHERE slug IN ('coding-agents', 'frontier-ai-labs');
```

Run against prod `released-db` (and staging `released-db-staging` if desired) via
`wrangler d1 execute`. This yields exactly two featured collections, matching the home
block's display cap.

## Testing

- **API** (`workers/api` route tests, `createTestDb()` builds from the Drizzle schema so the
  new column lands automatically):
  - `GET /v1/collections?featured=1` returns only featured rows; without the param,
    behavior is unchanged.
  - `PATCH /v1/collections/:slug { isFeatured: true }` persists and the response (via
    `rowToWire`) echoes `isFeatured: true`.
  - `GET /v1/collections/:slug` includes `isFeatured`.
- **Web:** components are presentational — rely on `npx tsc --noEmit` (web) plus a local
  smoke run of the home page and a collection detail page with local admin enabled.
  Optionally a small unit test that `api.collections({ featured: true })` builds the
  expected query string.
- **Repo gates:** root + per-worker `tsc --noEmit`, `bun test`, `bun run lint`,
  `bun run format:check`, and `scripts/check-openapi-coverage.ts` (run in CI).

## Rollout

1. Land the migration + schema + api-types + API + web changes behind a single PR.
2. Merge → migration auto-applies; web + workers auto-deploy.
3. Run the seeding UPDATE against prod (and staging) D1.
4. Verify the home page shows the two featured collections in the `xl` sidebar and that the
   detail-page admin menu toggles state in local dev.

## Risks / notes

- Below `xl` the block is a collapsed-by-default `<details>` disclosure (the expanded
  sidebar card is `xl`-only) — so it's compact on small screens, not a full-width banner.
- If a curator features more than 2 collections, the home block still shows only the first 2
  (by name); the rest are simply not rendered. No error.
- `bun install` must be run inside the worktree before tests resolve the edited
  `packages/core` / `packages/api-types` (workspace packages otherwise resolve to the main
  checkout).
