# 2026-05-26 — Rename display name from the web admin menus

## Problem

The web app's local-dev admin menus let an operator toggle state (hide/unhide,
auto-AI, marketing classifier, feed depth, promote) on orgs and sources, but
there is no way to **rename the display name** of an org, product, or source
from the UI. Today a rename means a CLI/API call. We want it available from the
same admin menus.

## Scope

- Add a "Display name" rename control to the **org**, **product**, and
  **source** admin menus.
- Products have **no admin menu today** — this work introduces one.
- Web-frontend only. **No API or schema changes.**

Out of scope: renaming collections/releases, slug editing, any production
(non-local) admin surface, per-user auth.

## Why no API work

The display name is the `name` column on all three tables
(`organizations.name`, `products.name`, `sources.name` in
`packages/core/src/schema.ts`), and all three PATCH endpoints already accept an
optional `name` field:

- `PATCH /v1/orgs/:slug` — `workers/api/src/routes/orgs.ts`
- `PATCH /v1/orgs/:orgSlug/products/:productSlug` — `workers/api/src/routes/products.ts`
- `PATCH /v1/orgs/:orgSlug/sources/:sourceSlug` — `workers/api/src/routes/sources.ts`

We send **only** `{ name }`, so the slug and URL are never touched. (Note: the
source PATCH re-embeds when `name` changes — that is the desired behavior, the
embedding should reflect the new name.)

## Gating

Inherits the existing `isLocalAdminEnabled()` gate
(`web/src/lib/local-admin-flag.ts`): the menus render only in local/dev when an
API key is configured, and never in production. The rename control matches every
other admin action — it is a local operator convenience, not a public feature.

## Design (inline "Display name" section)

Mirror the existing inline-edit pattern already in `source-admin-menu.tsx` (the
marketing-filter-hint textarea + Save button): a controlled input synced to the
prop, a Save button, the shared `run()` helper, and the existing error region.

### UI — added as the first section in each menu

```
Display name
[ text input prefilled with current name        ]
[ Save ]
Renames the display name only — slug and URL stay the same.
```

- Single-line `<input type="text">`, controlled by local state initialized from
  the `name` prop.
- `useEffect(() => setNameDraft(name), [name])` re-syncs the field after
  `router.refresh()` (same pattern as the hint field).
- **Save** is disabled when: `pending`, the trimmed draft is empty, or the
  trimmed draft equals the current `name` (no-op guard).
- Helper line clarifies the slug/URL are unaffected.
- On success the shared `run()` helper closes the menu and calls
  `router.refresh()`; failures render in the existing red error `<div>`.

### Server actions (`"use server"`)

All mirror the existing actions: `adminActionEnv()` guard → `fetch` PATCH with
`Authorization: Bearer ${env.apiSecret}` and `webApiHeaders(...)` →
`{ ok }`/`{ ok:false, error }` → `revalidatePath(...)`.

| Action                                                | Endpoint                                        | Revalidates                                         |
| ----------------------------------------------------- | ----------------------------------------------- | --------------------------------------------------- |
| `renameOrgAction({ slug, name })`                     | `PATCH /v1/orgs/:slug`                          | `"/"`, `/${slug}`                                   |
| `renameSourceAction({ orgSlug, sourceSlug, name })`   | `PATCH /v1/orgs/:orgSlug/sources/:sourceSlug`   | `/${orgSlug}/${sourceSlug}`, `/${orgSlug}`          |
| `renameProductAction({ orgSlug, productSlug, name })` | `PATCH /v1/orgs/:orgSlug/products/:productSlug` | `/${orgSlug}/product/${productSlug}`, `/${orgSlug}` |

`renameOrgAction` lands in `web/src/app/actions/org-admin.ts`;
`renameSourceAction` in `web/src/app/actions/source-admin.ts`; a new
`web/src/app/actions/product-admin.ts` holds `renameProductAction`.

### Component wiring

| File                                                   | Change                                                                                                     |
| ------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------- |
| `web/src/components/org-admin-menu.tsx`                | add `name: string` prop + Display-name section                                                             |
| `web/src/components/source-admin-menu.tsx`             | add `name: string` prop + Display-name section                                                             |
| `web/src/components/product-admin-menu.tsx`            | **new** — same dropdown shell as the others, contains the Display-name section only (button label `Admin`) |
| `web/src/app/[orgSlug]/(org)/layout.tsx`               | pass `name={org.name}` to `OrgAdminMenu`                                                                   |
| `web/src/app/[orgSlug]/[sourceSlug]/layout.tsx`        | pass `name={source.name}` to `SourceAdminMenu`                                                             |
| `web/src/app/[orgSlug]/product/[productSlug]/page.tsx` | gate on `isLocalAdminEnabled()`, render `ProductAdminMenu` near the `<h1>` (line ~122)                     |

`org.name` and `source.name` are already in scope at their render sites;
`product.name`/`orgSlug`/`productSlug` are in scope on the product page.

## Components / boundaries

- **`product-admin-menu.tsx`** — a self-contained dropdown owning open/close,
  keyboard + outside-click handling, `run()` loading/error state. Same public
  shape as the other two menus (`{ orgSlug, productSlug, name }`), so a future
  product admin action drops in as another section. Depends only on
  `renameProductAction`.
- **Rename section** — repeated in three menus. It is small and the menus differ
  enough (props, sibling sections) that a shared component would couple them
  without real payoff; the duplication is three near-identical ~20-line blocks.
  If a 4th consumer appears, extract a `<RenameNameField>` then.

## Error handling

- Network/API errors surface through the existing `run()` → `error` state → red
  `<div>` in each menu. No new error UI.
- Client-side guard (disabled Save) prevents empty/no-op submits before they
  reach the API; the API still enforces `name` non-empty as the backstop.

## Testing / verification

- `npx tsc --noEmit` in `web/` (and root) — type-check the new prop + action
  signatures.
- `bun run lint` (oxlint) + `bun run format:check`.
- Local-dev smoke (the gate is on locally): rename one org, one product, and one
  source; confirm each page shows the new name after the automatic refresh, and
  that the URL/slug is unchanged.

No unit tests added: the server actions are thin fetch wrappers over
already-tested endpoints, and the menus are client UI with no logic beyond the
shared `run()` helper that ships untested today.
