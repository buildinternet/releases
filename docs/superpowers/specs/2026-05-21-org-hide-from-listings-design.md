# Org "hide from listings" toggle (admin, dev-local UI)

**Date:** 2026-05-21
**Status:** Design approved

## Problem

Some organizations in the catalog are low-value or near-empty (e.g. `koute`) and
clutter the feature surfaces — the homepage latest-releases ticker and the main
`/orgs` directory table. We want a way to pull such orgs out of those surfaces
**without making them inaccessible**.

This is deliberately _different_ from release suppression. Suppressing a release
sets `suppressed = 1` and the release becomes a 404 on every read path. For orgs
we want **"don't feature"** semantics: the org disappears from listing/feed
surfaces but its detail page stays reachable, and it remains discoverable via
search and the sitemap.

### What exists today (and why none of it fits)

| Mechanism                 | What it does                                  | Why it doesn't fit                                                                                                                                                  |
| ------------------------- | --------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `deletedAt` (soft-delete) | Tombstones the org, mangles slug/domain       | Destructive; makes the org inaccessible (the 404 behavior we don't want)                                                                                            |
| `fetchPaused` (#1057)     | Pauses all ingest for the org                 | Org stays fully visible in the catalog; orthogonal to display                                                                                                       |
| `discovery = 'on_demand'` | Excludes from the `organizations_public` view | Records _origin_, not visibility; and the main `GET /v1/orgs` listing reads `organizations_active`, not `organizations_public`, so even `on_demand` orgs show there |

There is no boolean to hide a curated org from listings while keeping it
reachable, and no API or UI to toggle one.

## Chosen scope

- **Hide from:** the homepage latest-releases ticker **and** the main `/orgs`
  directory table.
- **Keep visible in:** search results, the sitemap, the org's own detail page
  (direct link always resolves), and collections.

## Approach (selected: A)

Add an independent boolean axis `is_hidden` on `organizations`, mirroring the
existing admin-only `fetch_paused` toggle, and filter exactly the two listing
queries that back the chosen surfaces.

**Alternatives rejected:**

- **B — shared `org_listing_visible` view** (parallel to `releases_visible`): a
  single view applied everywhere would over-filter search + sitemap, which must
  keep showing hidden orgs. It would need a parallel view anyway. More
  machinery, no benefit when only two queries need the filter.
- **C — reuse `fetchPaused` / `discovery` / soft-delete**: `fetchPaused` is
  ingest-only and must stay orthogonal (pausing ingest shouldn't unfeature, and
  vice-versa); `discovery` records origin; soft-delete is destructive. "Don't
  feature" deserves its own axis.

## Prior art being mirrored

- **API side:** `fetchPaused` — an admin-only boolean on `organizations`,
  toggled through `PATCH /v1/orgs/:slug` (`UpdateOrgBodySchema` field +
  one-line conditional in the handler).
- **Web side:** `ReleaseAdminMenu` (`web/src/components/release-admin-menu.tsx`)
  - the `release-admin.ts` server action + the dev-local `isLocalAdminEnabled()`
    gate (`NODE_ENV !== production && VERCEL_ENV !== production && RELEASED_API_KEY`).

## Design

### 1. Data model

- Add `isHidden: integer("is_hidden", { mode: "boolean" }).notNull().default(false)`
  to the `organizations` table in `packages/core/src/schema.ts`, beside
  `fetchPaused`.
- New migration `workers/api/migrations/<ts>_add_organizations_is_hidden.sql`:
  `ALTER TABLE organizations ADD COLUMN is_hidden INTEGER NOT NULL DEFAULT 0;`
- **No view DDL change.** Verified that SQLite `SELECT *` views (e.g.
  `organizations_active`) expose `ALTER TABLE ADD COLUMN` additions at query time,
  so the column flows through `organizations_active` / `organizations_public`
  automatically. For typed completeness, add `isHidden` to the Drizzle
  `organizationsActive` / `organizationsPublic` view column maps in `schema.ts`
  (the listing queries use raw SQL, so this is type-hygiene only).
- **No index** (matches `fetch_paused`): tiny table, low-cardinality filter.

### 2. Toggle API

- `packages/api-types/src/schemas/orgs.ts` → add to `UpdateOrgBodySchema`:
  `isHidden: z.boolean().optional()` with an admin-only doc comment.
- `workers/api/src/routes/orgs.ts` `PATCH /v1/orgs/:slug`:
  - add `isHidden?: boolean` to the body type,
  - add `if (body.isHidden !== undefined) updates.isHidden = body.isHidden;`
    before the existing `.update(organizations).set(updates)` call.
- After a successful toggle, fire
  `c.executionCtx.waitUntil(invalidateLatestCache(c.env, …))` so the homepage
  ticker reflects the change within seconds rather than the 300s KV TTL. The
  existing default-shape purge is sufficient (hiding an org changes what the
  no-filter default shape returns).
- **Auth:** inherited from the same PATCH path that already serves
  `fetchPaused`. No new gating wiring.
- `GET /v1/orgs/:slug` detail response includes `isHidden` so the admin menu can
  render the correct current state (Hide vs. Unhide). Add `isHidden` to the org
  detail response shape in `@buildinternet/releases-api-types`.

### 3. Read-path filters — exactly two queries

- **`getLatestReleasesAcross()`** (`workers/api/src/queries/releases.ts`): add
  `wheres.push("(o.is_hidden = 0 OR o.is_hidden IS NULL)")`. The `IS NULL`
  branch preserves source-only rows (org is a LEFT JOIN). This covers the
  homepage ticker (GraphQL `latestReleases`), `GET /v1/releases/latest`, and the
  CLI/MCP "latest" feed.
- **`getOrgsWithStats()` and `countOrgsForList()`**
  (`workers/api/src/queries/orgs.ts`): add `AND o.is_hidden = 0` to both, so the
  `<OrgTable>` directory and its pagination count stay consistent.

**Deliberately NOT touched** (so hidden orgs stay reachable/discoverable):
`search.ts`, `sitemap.ts`, `GET /v1/orgs/:slug` detail, collections read paths.

**Accepted consequence:** `getLatestReleasesAcross()` also backs
`GET /v1/releases/latest` (the CLI/MCP cross-catalog "what's new" feed), not just
the homepage ticker. Filtering at the shared query level means a hidden org also
drops out of that feed. This is intended — it's the same "featured / what's new"
concept — and filtering only the homepage GraphQL path would make the same feed
behave differently per client. (Confirmed with the requester.)

### 4. Web admin UI (dev-local)

- New `web/src/components/org-admin-menu.tsx` (`"use client"`): a small dropdown
  showing **"Hide from listings"** or **"Unhide from listings"** depending on the
  current `isHidden`, mirroring `release-admin-menu.tsx` (simpler — no reason
  field). Calls the server action and `router.refresh()` on success.
- New server action `web/src/app/actions/org-admin.ts` (`"use server"`):
  `setOrgHiddenAction({ slug, hidden })` — re-checks `isLocalAdminEnabled()` as
  defense-in-depth, `PATCH`es `/v1/orgs/:slug` with `{ isHidden: hidden }` and
  the `Authorization: Bearer ${RELEASED_API_KEY}` header (server-side env only),
  then `revalidatePath("/")` (homepage + table) and the org path.
- Mount in `web/src/app/[orgSlug]/(org)/layout.tsx` next to the org name /
  `CliCommand`, behind `{adminEnabled && <OrgAdminMenu … />}` where
  `const adminEnabled = isLocalAdminEnabled()` (same shape as the release page).
  Pass `isHidden` from the org detail payload.

### 5. Testing

Worker unit tests (Bun, in-repo test DB):

- `PATCH /v1/orgs/:slug { isHidden: true }` writes `is_hidden = 1`; `{ isHidden:
false }` clears it; `isHidden` round-trips on `GET /v1/orgs/:slug`.
- `getOrgsWithStats` / `countOrgsForList` exclude a hidden org.
- `getLatestReleasesAcross` excludes a hidden org's releases.
- **Regression guards (the "stays reachable" requirement):** a hidden org is
  still returned by search, by the sitemap, and by `GET /v1/orgs/:slug`.

Migration is applied to the test DB fixture so the column exists.

## Out of scope

- Inline hide/unhide controls in the org table rows (chosen: detail-page menu only).
- Hiding from search / sitemap (chosen: keep discoverable).
- A production (non-dev) admin surface — gating stays `isLocalAdminEnabled()`,
  identical to the release admin menu.
- Bulk triage tooling.
