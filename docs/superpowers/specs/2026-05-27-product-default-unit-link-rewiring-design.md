# 2026-05-27 — Product as the default navigational unit: link rewiring (Phase 2)

## Context

#1187 made product pages the primary **feed** unit (org hub product-card grid, scoped
product feed pages, `?product=` filter). That wired the org-hub product cards to product
pages but left most other navigation pointing at individual sources. Phase 2 finishes the
job: across search, the org page, and the sources table, **when an entity resolves to a
product, navigation lands on the product page** (`/[org]/product/[slug]`) instead of the
individual source page.

This is the link-rewiring half of "make product the default navigational unit." It is
deliberately **not** the route-namespace flip (see [Long-term](#long-term-product-first-resolution-out-of-scope)).
Sources stay reachable at their existing `/[org]/[sourceSlug]` URL; we simply stop
_linking_ to them by default where a product owns the entity.

## Goal / non-goals

- **Goal:** default click targets point at products when an entity belongs to one.
- **Goal:** centralize URL construction so the eventual namespace flip is a one-place change.
- **Non-goal:** no redirects, no new routes, no namespace change. Source URLs unchanged.
- **Non-goal:** MCP search output (LLM-facing, renders no links) — left for the flip work.

## What already works (verified, no change needed)

- **Search catalog hits.** `foldSourcesIntoCatalog` (`packages/api-types/src/api-types.ts:732-765`)
  already collapses product-member sources into a product entry: a source with a
  `productSlug` is promoted to `entryType:"product"` (or dropped if its product is already
  present), so it links to `/[org]/product/[slug]`. Orphan sources (no product) stay
  `entryType:"source"`. The `/v1/search` handler uses it (`workers/api/src/routes/search.ts:431`).
  → **Add a regression test asserting the collapse; no production change.**
- **Org-hub product cards.** `ProductGrid` (`web/src/components/product-grid.tsx:26-28`)
  already links to `/[org]/product/[slug]` (renders at ≥2 products).

## Design

### Unit 1 — Shared link helpers (`web/src/lib/links.ts`, new)

Pure, runtime-neutral path builders that replace the inline template literals currently
duplicated across `product-grid.tsx`, `search-results.tsx` (`sourceHref`), `source-card.tsx`,
and `source-table.tsx` (no shared helper exists today):

```ts
export function productPath(orgSlug: string, productSlug: string): string;
// → `/${orgSlug}/product/${productSlug}`   (today's canonical product URL)

export function sourcePath(orgSlug: string | null, sourceSlug: string): string;
// → orgSlug ? `/${orgSlug}/${sourceSlug}` : `/source/${sourceSlug}`

export function sourceOrProductPath(args: {
  orgSlug: string | null;
  sourceSlug: string;
  productSlug?: string | null;
}): string;
// → productSlug ? productPath(orgSlug, productSlug) : sourcePath(orgSlug, sourceSlug)
//   (productPath requires an orgSlug; when productSlug is set, orgSlug is always present)
```

`productPath` is the single seam for the future flip: when bare `/[org]/[slug]` starts
resolving to products, this function changes to emit `/${orgSlug}/${productSlug}` and a 308
is added from the prefixed form — nothing else in the web tree needs to move.

Unit-tested directly (pure functions).

### Unit 2 — Web render sites using data already on the wire (no API change)

`productSlug` already rides on `SourceListItem` (org detail `org.sources`) and
`SourceWithOrg` (`/v1/sources`), so these are pure web edits:

- **`web/src/components/release-timeline.tsx`** — the product-group section header
  (`<h3>{product.name}</h3>`, ~lines 129-134) becomes a `Link` → `productPath(orgSlug, product.slug)`.
  Source rows rendered under a product → `sourceOrProductPath(...)`.
- **`web/src/components/source-card.tsx:148`** — `const href = orgSlug ? ...` → `sourceOrProductPath({ orgSlug, sourceSlug: source.slug, productSlug: source.productSlug })`.
- **`web/src/components/source-table.tsx`** (`/[org]/sources`) — the source-name link
  (~line 135) → `sourceOrProductPath(...)`; the product column text (~line 157) also links
  to the product when present.

### Unit 3 — Search release-hit bylines (the one API + wire change)

The release-hit **byline** source link (`web/src/components/search-results.tsx:236`,
`href={\`/${orgSlug}/${sourceSlug}\`}`) should point at the product when the source belongs
to one. Release hits don't carry `productSlug` today, so:

- **SQL** (`workers/api/src/queries/search.ts`): add `p.slug as productSlug` to the SELECT of
  `searchReleasesFts` and `searchReleasesFromMatchedEntities`. The `LEFT JOIN products_active p ON p.id = s.product_id`
  is already present (used for the `kind` COALESCE), so this is SELECT-only.
- **Hit shaping:** add `productSlug` to `RawSearchReleaseRow` and forward it through
  `hydrateReleaseHit`.
- **Wire:** add `productSlug: z.string().nullable().optional()` to `SearchReleaseHitSchema`
  (`packages/api-types/src/schemas/search.ts`). Additive → safe for the published
  `@buildinternet/releases-api-types`; web consumes via `workspace:*`, so no publish is
  required for this change to take effect in-repo.
- **Web:** byline source link → `sourceOrProductPath({ orgSlug, sourceSlug, productSlug })`.
  The release **title** stays `/release/{id}` (canonical release page — unchanged).

### Out of scope / unchanged

- **Release detail** `/release/{id}` — canonical, unchanged.
- **Changelog chunk deep-links** (`chunkDeepLink` → `/[org]/[sourceSlug]/changelog?offset=…`)
  — inherently source+offset scoped; products have no changelog-offset view. Stay on source.
- **Org hits** — already link to the org.
- **MCP search** `productSlug` population — MCP reads D1 with its own SQL; the optional wire
  field stays unpopulated there (no breakage). Picked up with the flip work.

## Testing

- Unit tests for `web/src/lib/links.ts` (pure).
- API search test: a release hit whose source belongs to a product carries `productSlug`
  (FTS path runs against the test D1 fixture).
- Regression test for `foldSourcesIntoCatalog` collapse (Unit-already-works guard).
- Gate: `npx tsc --noEmit` (root + web + api), `bun run lint`, `bun test`.

## Risks / tradeoffs

- **Redundancy on the org page.** A product appears both as a card (ProductGrid) and as
  grouped rows (ReleaseTimeline), all now pointing at the same product page. Redundant but
  consistent; accepted. It de-emphasizes per-source drill-down — sources remain reachable by
  direct URL and from the product page's source list.
- **Published wire type.** The `SearchReleaseHit.productSlug` addition is optional/additive,
  so no consumer (OSS CLI, MCP) breaks; co-bump api-types only on the next publish.
- **No schema/migration impact.** This adds a SELECT column and a wire field only — no
  `schema.ts` change, so the migration-pairing CI gate does not apply.

---

## Long-term: product-first resolution (OUT OF SCOPE — recorded for the migration)

The end state is a URL namespace where the top-level coordinate is ~1:1 with org/product and
sources are an implementation detail. This is **not** in this branch; it gets its own spec.
Captured here so the reasoning isn't lost.

### Target model

- `/[org]` → organization
- `/[org]/[slug]` → **product** (bare second segment means product)
- the `/[org]/product/[slug]` prefix collapses (or stays as a permanent 308 alias)
- sources → demoted to an ID-keyed route (`/sources/:id`), surfaced mostly inside
  product/org pages; possibly no primary browse URL at all eventually (a source's releases
  already live at `/release/:id`; "source" is really ingestion-config + provenance).

### Mechanism: product-first resolution (resolves the collision problem gracefully)

```
/[org]/[slug] → product(org, slug)? render product
              → else source(org, slug)? render source (or 308 to its product)
              → else 404
```

- Products get the clean bare coordinate immediately; non-colliding sources keep working;
  collisions resolve by precedence (e.g. Vercel's product `turborepo` shadows the source
  `turborepo` on the bare path — exactly the intended demotion).
- Edge cases the migration spec must own:
  1. **Double lookup** → introduce a combined resolver `GET /v1/orgs/:org/resolve/:slug → { kind: "product"|"source", … }`; merge today's two Next routes (`/[org]/[sourceSlug]` with its changelog/highlights tabs + `/[org]/product/[slug]`) into one dynamic segment rendering by `kind`.
  2. **Silent shadowing** → guard product creation against an existing source slug (warn/forbid).
  3. **Sub-tab interaction** → `/[org]/[slug]/changelog` etc. must resolve sensibly once a product owns the slug.
- The existing `/source/[slug]` route is only a legacy 308 shim (`web/src/app/source/[slug]/page.tsx`),
  not a renderer, so a terminal ID-keyed source view (`/sources/:id`) is net-new work in the flip.

### Open decision for the migration spec: plural `/products/`

The API is already plural (`/v1/products`, `/v1/orgs/:slug/products`); the singular web
`/product/` is the odd one out. Since the prefix is slated to disappear under product-first
resolution, this design **defers** the singular→plural rename to the migration spec (don't
churn a segment we plan to delete). If we instead decide to avoid the singular form getting
indexed, a cheap `/product/ → /products/` 308 can be pulled forward — left as a decision
inside the migration spec.
