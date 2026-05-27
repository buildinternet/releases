# 2026-05-27 — Product-first URL resolution (bare `/[org]/[slug]` → product)

Tracking issue: **#1190**. Follow-ups (out of scope, cross-linked): #1191–#1196.
Predecessors: #1187 (product as default feed unit), #1189 + the Phase-2 spec
`2026-05-27-product-default-unit-link-rewiring-design.md` (product as default link target).

## Context

Phases 1 and 2 made the **product** the default feed unit and the default link
target. The URL namespace is still source-first, though: bare `/[org]/[slug]`
resolves to a **source**, and products need the `/product/` prefix. This phase
flips the namespace so the bare second segment means **product**, and demotes
sources toward an ID-keyed surface.

`web/src/lib/links.ts` is the single path-construction seam (built in Phase 2
precisely so this flip is a one-place change to `productPath`).

## Goal / non-goals

- **Goal:** `/[org]/[slug]` resolves **product-first**; products own the clean bare
  coordinate; the `/product/` prefix becomes a permanent 308 alias.
- **Goal:** give shadowed sources a stable, first-class home at `/sources/:id`.
- **Goal:** stay non-breaking — no existing URL 404s as a result of the flip.
- **Non-goal:** removing source slugs / making sources ID-only _now_ (see
  [Forward compatibility](#forward-compatibility--the-committed-destination)).
- **Non-goal:** the orphan→product wrapping migration and any resulting org-page
  behavior change — that is #1194's design.
- **Non-goal:** MCP search output, per-product feeds, product overviews, the
  `OrgReleasesResponse` migration — separate follow-ups (#1191–#1196).

## Production data that shaped this design (measured 2026-05-27, prod D1)

| Metric                                                   | Value                                    |
| -------------------------------------------------------- | ---------------------------------------- |
| Organizations                                            | 84                                       |
| Orgs with ≥1 product                                     | 22 (→ **62 orgs, 74%, have no product**) |
| Products                                                 | 68                                       |
| Sources                                                  | 310                                      |
| Member sources (`product_id` set)                        | 71                                       |
| Orphan sources (`product_id` NULL)                       | 239                                      |
| Orgs with 2+ orphan sources                              | 60                                       |
| **Product/source slug collisions (same org, same slug)** | **23**                                   |
| Colliding sources with a changelog file                  | 11 of 23                                 |

Two facts drove the design:

1. **Collisions are common, not rare** — 23 of 71 member sources share a slug
   with a product (products are usually named after their primary repo). So the
   flip _must_ handle collisions gracefully; it cannot assume bare slugs are
   unique across products and sources.
2. **The catalog is overwhelmingly source-shaped** — 74% of orgs have no product
   at all, and most have several distinct orphan sources. So sources cannot lose
   their human URLs in this cycle without regressing the primary browse path for
   most of the catalog. Product-first resolution must _fall back_ to rendering a
   source.

## Decisions

- **Demotion model: lean / by-precedence.** Products win the bare slug; only the
  sources actually _shadowed_ by a product move to `/sources/:id`. The 48
  non-colliding member sources and all 239 orphan sources keep rendering at their
  bare URL, untouched. (Rejected the heavier "redirect every member source"
  model — it churns 48 working pages and forks orphan-vs-member logic across five
  call sites for no user-visible benefit.)
- **Combined resolver: build it.** `GET /v1/orgs/:org/resolve/:slug` returns a
  discriminated payload in one round trip (vs. the merged page trying
  `productDetail` then a source fetch on 404).
- **Old `/product/` URLs: permanent 308 to bare.** `/[org]/product/[slug]` redirects
  to `/[org]/[slug]`. Resolves the deferred singular-vs-plural question by deletion:
  no `/products/` (plural) segment is ever introduced, so there is nothing to rename.
- **Shadow guard: warn but allow** (informational — same-slug product creation is
  the _intended_ wrap operation, not an anomaly; see Forward compatibility).

## Resolution model

`/[org]/[slug]` calls the resolver and branches on `kind`:

| Path                    | resolves to                              | Action                                |
| ----------------------- | ---------------------------------------- | ------------------------------------- |
| `/[org]/[slug]`         | **product**                              | render product                        |
| `/[org]/[slug]`         | **source** (definitionally non-shadowed) | render source, as today               |
| `/[org]/[slug]`         | nothing                                  | 404                                   |
| `/[org]/product/[slug]` | (anything)                               | **308 → `/[org]/[slug]`** (permanent) |
| `/sources/[id]`         | source                                   | render source (+ sub-tabs)            |
| `/source/[slug]`        | legacy shim                              | unchanged (308 via existing lookup)   |

The elegant part: **a shadowed source's slug _is_ its product's slug**, so
product-first resolution returns the product directly — there is no separate
"bare member-source → product" redirect, and no broken URL. The bare URL stays
the same; only its content flips from source to product. The resolver's `source`
branch therefore only ever fires for non-shadowed sources, which render exactly
as they do today.

## Units

### Unit 1 — Combined resolver endpoint (API worker)

`GET /v1/orgs/:org/resolve/:slug`, product-first in SQL, returning a discriminated
union that composes the **existing** detail shapes (no new shape definitions):

```ts
type ResolveResponse =
  | { kind: "product"; product: ProductDetail }
  | { kind: "source"; source: SourceDetail }; // SourceDetail already carries productSlug
// 404 not_found when neither matches
```

- Resolution precedence (product wins) lives server-side in the handler/query.
- `:org` accepts an org slug or `org_…` ID (consistent with existing resolvers).
- Public-read route → **must** carry a `describeRoute(...)` annotation and appear
  in `/v1/openapi.json` (the #894 coverage gate, enforced in CI). Add it under the
  correct `publicReadRoutes` prefix in `workers/api/src/route-namespaces.ts`.
- Reuses `findProductForOrgSlug` / `findSourceForOrgSlug` (`workers/api/src/utils.ts`).

### Unit 2 — Next.js route merge (web)

Collapse `web/src/app/[orgSlug]/[sourceSlug]/` (with its `page`, `changelog`,
`highlights`, `layout`, `error`, `opengraph-image`) and
`web/src/app/[orgSlug]/product/[productSlug]/` into one `[orgSlug]/[slug]/` segment
that calls the resolver and renders by `kind`:

- `kind: "product"` → the product page (today's `product/[productSlug]` render).
- `kind: "source"` → the source page (today's `[sourceSlug]` render), including its
  `changelog` / `highlights` sub-tabs and layout.
- 404 → not-found.

`web/src/app/[orgSlug]/product/[productSlug]/page.tsx` shrinks to a `redirect()`
(308) to the bare form. `product` stays a **static** segment (wins Next.js
static-over-dynamic precedence) and becomes reserved (Unit 6).

**Sub-tab edge:** `/[org]/[slug]/changelog` (and `/highlights`) when `[slug]`
resolves to a **product** → 404 by default (products have no changelog-offset
view). An optional 308 to `/sources/:id/changelog` for the ~11 shadowed-with-changelog
sources is a noted nicety, **not built here**. The proper long-term fix — a
single-source product page surfacing its sole source's changelog/highlights —
rides with the product-scoped-views follow-ups (#1191-adjacent), not this cycle.

### Unit 3 — `/sources/:id` terminal render route (web)

Net-new (`web/src/app/sources/[id]/` + `changelog/` + `highlights/` + `layout.tsx`),
reusing the existing source-detail components. The existing `/source/[slug]` route
is only a 308 shim, so this is genuinely new render work.

- `:id` is the typed `src_…` ID (globally unique → no org segment needed).
- The canonical/only home for the **23 shadowed** sources; a working alias for the
  rest. Built as a **first-class permanent surface**, not a corner-case fallback
  (see Forward compatibility — this is the eventual home of _all_ sources).
- The product page's "Sources" list links members here (Unit 4) — linking them to
  the bare slug would 308 a shadowed source straight back to the product.
- **Duplicate-content guard:** a non-shadowed source renders at both its bare URL
  and `/sources/:id`. Emit `<link rel="canonical">` pointing at the bare URL for
  non-shadowed sources, and at `/sources/:id` for shadowed ones (whose bare slug
  belongs to the product). One conditional in the route's metadata.

### Unit 4 — `links.ts` seam (web)

```ts
// flip:
productPath(orgSlug, productSlug)  // → `/${orgSlug}/${productSlug}` (was `/${orgSlug}/product/${productSlug}`)

// new:
sourceIdPath(sourceId: string)     // → `/sources/${sourceId}`

// sourcePath(org, slug) unchanged → `/${org}/${slug}` (orphan + non-shadowed sources)
```

- The product page's member-source list → `sourceIdPath(source.id)`.
- `chunkDeepLink`: a **member** source's changelog deep-link → `/sources/:id/changelog?offset=…`;
  an **orphan** source's → `/[org]/[sourceSlug]/changelog?offset=…`. This member/orphan
  branch lives **only here** (one module). Phase 2 already points member-source
  _release_ hits at the product, so the product page's source list is the only
  surface linking to a member source directly.

### Unit 5 — Redirects

One **308 (permanent)** redirect:

- `/[org]/product/[slug]` → `/[org]/[slug]` (the `product/[productSlug]` page becomes a `redirect()`).

No `/products/` (plural) route is introduced (singular/plural question resolved by
deletion). No bare member-source → product redirect is needed either — collisions
resolve directly to the product, per the resolution model.

### Unit 6 — Guards (`packages/core` + API worker)

- **Reserved nested slugs:** extend `NESTED_RESERVED` in
  `packages/core/src/reserved-slugs.ts` with `product`, `products`, `playbook`,
  `fetch-log`. These are live static second-segment routes today but are **not**
  currently reserved, so a product/source slug matching them would be shadowed by
  the route. (`releases`, `sources`, `highlights`, `changelog`, `opengraph-image`,
  `sitemap` are already covered.)
- **Shadow guard:** on `POST`/`PATCH` product create/update, if the resulting slug
  matches an existing same-org **source** slug, emit a non-blocking warning
  (`logEvent("warn", …)` + a warning field on the response) and proceed. Shadowing
  is the _intended_ mechanism; the warning exists to catch accidents, not to block.

### Unit 7 — Sitemap (web + API)

- Products → bare `/[org]/[slug]`; drop the `/[org]/product/[slug]` entries.
- Sources essentially unchanged: orphan + non-shadowed sources keep their bare
  URLs and sub-tab entries; relegate only the ~23 **shadowed** sources to
  `/sources/:id`.
- Single dynamic `web/src/app/sitemap.ts` — no `generateSitemaps()` split needed.

## Forward compatibility — the committed destination

**Destination (committed):** orgs and products own slugs; **sources are ID-only**
ingestion config addressed at `/sources/:id`, with no slug in the URL namespace.
This is #1190's stated end-state, and this design is its on-ramp.

**Why not now:** the prod numbers above — 74% of orgs have no product and most have
several distinct orphan sources. Stripping source slugs today would relocate 239
orphan-source pages to `/sources/:id` and regress the primary browse path for most
of the catalog. The dependency must be inverted, not forced.

**The bridge (non-breaking): selective orphan→product wrapping.** A valuable orphan
source is wrapped in a **same-slug** product (set `source.product_id` to a new
product whose slug equals the source's). Because product-first resolution then
returns the wrapper at the _same_ URL, **no link breaks** — `/[org]/[claude-code]`
simply renders the product instead of the source, and the source moves to
`/sources/:id`. Minor sources nobody browses to are left ID-only with no page. This
is exactly the existing 23-collision mechanism, generalized. **Owned by #1194**
(auto-create products at onboarding + backfill), which also owns the resulting
org-page behavior change (orgs gaining products flip from flat feed to product hub)
and the product/source semantics of single-source products.

**What that makes of this cycle's code:**

- The resolver's **`source` fallback branch is transitional** — it serves orphan
  and not-yet-wrapped sources, and gets a sunset once wrapping is done. Deleting it
  later is a branch removal, not a rewrite.
- **`/sources/:id` is the permanent destination home** for all sources — building it
  well now is investing in the real future surface.
- **`links.ts` is the one-place flip.** When source slugs retire, `sourcePath`
  switches from `/[org]/[sourceSlug]` to `sourceIdPath(id)` in a single edit — the
  239 orphan URLs migrate from there.

**Retirement cycle (later, small):** once wrapping has run, flip the seam for orphan
sources, simplify the resolver to product-only (delete the `source` branch),
deprecate the source-slug endpoints (`/v1/orgs/:org/sources/:sourceSlug`,
`/v1/lookups/source-by-slug`) and the CLI `findSource` slug path on the usual
deprecation-alias timeline.

## Testing

- **Resolver precedence + shadow-warn** at the **query/handler layer.** The org feed
  route mixes Drizzle (org resolve) with raw-D1 (`getOrgReleasesFeed`), so
  `createTestApp` cannot integration-test it — test the resolver query and the
  shadow-guard branch directly against the test D1 fixture.
- **`links.ts`** pure-function units (`productPath` bare, `sourceIdPath`,
  `chunkDeepLink` member/orphan branch).
- **Redirect assertions** for each 308 row in the resolution matrix.
- **Reserved-slug** additions (`isReservedSlug("product"|"products"|"playbook"|"fetch-log", "nested")`).
- Gate: `npx tsc --noEmit` (root + web + api), `bun run lint`, `bun test`,
  `scripts/check-openapi-coverage.ts` (the new public-read route must be documented).

## Rollout

Lean enough to be **one PR**, or a light split: land the resolver + `/sources/:id`
dark (nothing links to them yet), let them bake, then the route merge + seam flip +
redirects + sitemap. Recommend at planning time based on diff size. No schema
change in this cycle → the migration-pairing CI gate does not apply (the reserved-set
edit is a `packages/core` constant, not `schema.ts`).

## Risks / tradeoffs

- **Non-uniform member-source URLs.** A non-colliding member stays at `/[org]/[slug]`;
  a shadowed member lives at `/sources/:id`. Invisible to users (links route through
  the seam; the product page uniformly uses `/sources/:id` for members). The uniform
  end-state arrives via wrapping (#1194), not by churning pages now.
- **New public API surface.** The resolver adds a documented endpoint (OpenAPI gate).
  Accepted — #1190 asks for the one-round-trip resolve, and it composes existing
  shapes.
- **Sub-tab 404 on product slugs.** `/[org]/[productSlug]/changelog` 404s; rare today,
  more common post-wrapping. Default 404 now; the real fix (single-source product
  surfaces its source's sub-content) is a product-scoped-views follow-up.
