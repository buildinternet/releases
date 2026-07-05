# 2026-05-26 — Product pages as the default unit

## Problem

Product pages exist in the web app (`web/src/app/[orgSlug]/product/[productSlug]/page.tsx`) but
today they are thin **source directories**: they list a product's sources as cards (with
`releaseCount: 0` placeholders) plus app-store icons, a CLI command, and a taxonomy sidebar. They
carry **no release feed**. The rich feed surface is the org page (`ReleaseTimeline` on
`/[orgSlug]`); the per-source feed lives at `/[orgSlug]/[sourceSlug]`.

Three things motivate promoting products to the primary unit:

1. **Mental-model mismatch** — people think in products ("Next.js", "ChatGPT"), not in sources
   ("Next.js GitHub releases" + "Next.js blog"). The source layer is plumbing that should not be
   the navigational default.
2. **Fragmented feeds** — a product's news is split across multiple sources (changelog + blog + app
   notes), so no single page shows "everything new in this product."
3. **SEO / landing pages** — product pages are the natural search-landing target ("Next.js release
   notes") but are currently thin stubs. The rich content lives on org/source pages instead.

Target model: org hub = product card grid above an aggregate feed, plus a per-product feed page —
the shape most multi-product release hubs converge on.

## Constraints and prior art

- Products are an **optional** layer: `sources.product_id` is nullable, and most sources today sit
  directly under the org with no product. Any design must degrade gracefully for productless orgs —
  **no data migration**.
- The org release-feed query (`getOrgReleasesFeed`, `workers/api/src/queries/orgs.ts`) already
  `LEFT JOIN products_active p ON p.id = s.product_id`, so a product filter is a one-line
  `AND s.product_id = ?`.
- **Product overviews already exist**: `GET /v1/products/:slug/overview` returns the AI-generated
  knowledge page (scope `product`).
- The Releases tab (`web/src/app/[orgSlug]/(org)/releases/page.tsx`) renders `<OrgReleaseList>`,
  which already does cursor pagination + `source_type`/`q` filtering against the web proxy
  `/api/org-releases/[slug]`. This is the component the product feed page reuses.
- **No** product-scoped activity/heatmap exists — `orgActivity`/`orgHeatmap` are org-only. The rich
  contribution-graph viz is therefore explicitly out of scope for v1 (feed-only).

## Page model

The product layer "turns on" only at **2 or more products**. Orgs with 0–1 products keep today's
behavior exactly — zero risk to the bulk of the catalog.

| Org shape                         | `/[orgSlug]`                                      | `/[orgSlug]/product/[slug]`    |
| --------------------------------- | ------------------------------------------------- | ------------------------------ |
| **0–1 products** (Stripe, Linear) | The feed itself — **unchanged**                   | n/a (≤1 product → 301 to org)  |
| **2+ products** (Vercel, OpenAI)  | **Hub:** product card grid + aggregate feed below | **Rich feed page** (new build) |

### Threshold rationale

A product page only makes sense when it isolates one product's feed from at least one _other_
product's feed. With ≤1 product the org page is already that single product's feed, so a separate
product page would be duplicate content. The threshold is `org.products.length >= 2`.

**Edge case — 1 product + orphan sources:** treated as "single product" (org page shows everything,
no product page, product card grid hidden). This keeps the rule a simple product-count check.
Revisit only if a concrete org makes the orphan/product split confusing.

## Components

### 1. Org hub (2+ products) — additive

Add a **"Products" card grid** to the org Overview tab, rendered **above** the existing
`ReleaseTimeline`, only when `org.products.length >= 2`. Each card:

- product name
- release count (e.g. "167 release notes")
- links (`→`) to `/[orgSlug]/product/[slug]`

The aggregate cross-product feed and the Overview / Releases / Sources tabs stay exactly as they are.
This is purely additive to `web/src/app/[orgSlug]/(org)/page.tsx` (and a new `ProductGrid` component).

**No emojis** in the card UI (project convention) — use the existing chip / icon-component patterns;
the `→` affordance should be an icon component, not a literal arrow glyph.

### 2. Product feed page (v1, feed-only)

Rewrite `web/src/app/[orgSlug]/product/[productSlug]/page.tsx` from source-directory stub to feed
page:

```
/vercel/product/nextjs
Home / Vercel / Next.js            ← breadcrumb (exists)

Next.js                            ← name (exists)
"The React framework…"             ← overview blurb (GET /v1/products/:slug/overview)
──────────────────────────────────
 ● Next.js 15.2  — Mar 3           ← <OrgReleaseList> pinned to product
 ● Next.js 15.1.8
 ● Next.js 15.1.7
                                   ← sidebar: sources, CLI, taxonomy (exists)
```

- **Feed:** reuse `<OrgReleaseList>` with a new optional `product` prop. When set, the component
  pins the feed to that product and does **not** expose product as a user-flippable filter.
- **Overview:** fetch `GET /v1/products/:slug/overview`; render the blurb when present, omit silently
  when `null`.
- **Sidebar:** keep the existing sources/CLI/taxonomy sidebar.
- **OG image:** existing `product/[productSlug]/opengraph-image.tsx` is reused as-is.
- **JSON-LD:** upgrade from bare `CollectionPage` to a `CollectionPage` + `BreadcrumbList` +
  `ItemList` of releases, matching the org Releases tab's `buildReleaseItemListJsonLd(...)` usage.

### 3. Single-product collapse + canonical (SEO)

When the resolved org has **≤1 product**, `/[orgSlug]/product/[slug]` issues a **301 →
`/[orgSlug]`** (`permanentRedirect`). The org page stays canonical; no duplicate-content split.
Implemented in the product page: fetch org, count products, redirect before rendering.

## API changes (additive)

### Product feed filter

Add `?product=<slug|prod_id>` to `GET /v1/orgs/:slug/releases`:

1. Resolve the param to a product id scoped to the org (slug or `prod_…` id). Unknown product →
   `404 not_found` (the product is part of the addressed resource, not an optional filter).
2. Thread `productId` into `getOrgReleasesFeed`'s `opts` → `AND s.product_id = ?` in the WHERE clause
   (the query already `LEFT JOIN products_active`).
3. Web proxy `/api/org-releases/[slug]` passes `?product=` through verbatim.
4. `<OrgReleaseList>`'s `buildQuery()` includes `product` when the prop is set.

**Decision — filter param over a dedicated endpoint.** Chosen over a new
`/v1/products/:slug/releases` (or `/v1/orgs/:orgSlug/products/:productSlug/releases`) because the
filter reuses cursor pagination, FTS, time-windows, and the `kind` filter for free and adds
near-zero `api-types` surface. A dedicated RESTful route can be aliased onto the same query later if
a first-class endpoint is wanted; nothing here forecloses it.

### Per-product release counts (hub cards)

- Extend `OrgDetailProductSchema` (`packages/api-types/src/schemas/orgs.ts`) with
  `releaseCount: z.number().int().min(0)` (additive, non-breaking).
- Add a release-count subquery to the org-detail handler in `workers/api/src/routes/orgs.ts`,
  sitting next to the existing `sourceCount` subquery
  (`SELECT COUNT(*) FROM sources_active s WHERE s.product_id = products_active.id`). The count is
  releases across the product's sources (visible rows only).

No schema/migration change — both are query + wire-shape additions.

## "Default unit" wiring

Product pages become the preferred link target wherever a product exists:

- **v1:** org hub product cards link to product pages.
- **Phase 2 (fast-follow, out of scope here):** search results and catalog rows point at the product
  page instead of individual sources when the hit resolves to a product. Kept out of v1 so the first
  cut stays a tight web + one-filter-param change.

## Out of scope for v1

- Product-scoped activity timeline + contribution heatmap (feed-only per the scope decision).
- Per-product Atom / feed-format buttons (RSS/Email/CSV/MCP/…).
- Auto-creating products during org onboarding.
- Search / catalog link-target rewiring (phase 2).
- A dedicated `/v1/products/:slug/releases` REST endpoint (filter param covers v1).

## Testing

- **API:** `getOrgReleasesFeed` returns only the product's releases when `productId` is set; the org
  feed is unchanged when it is absent; unknown product slug → 404. `OrgDetailProductSchema`
  round-trips `releaseCount`; the org-detail handler returns correct per-product counts (including 0).
- **Web:** product page renders the feed for a 2+-product org; ≤1-product org 301s to the org page;
  product grid appears on the org Overview only at 2+ products; `<OrgReleaseList product=…>` fires
  the proxy with `product=` and does not surface product as a flippable filter.
- Type-check (`npx tsc --noEmit` root + workers), `bun test`, `bun run lint`.

## Build sequence

1. API: `?product=` filter on `/v1/orgs/:slug/releases` + `getOrgReleasesFeed` `productId` opt.
2. API: `releaseCount` on `OrgDetailProductSchema` + org-detail subquery.
3. Web: thread `product` through `/api/org-releases/[slug]` proxy and `<OrgReleaseList>`.
4. Web: rewrite the product page (overview + feed + sidebar + JSON-LD ItemList) and the ≤1-product
   301 collapse.
5. Web: `ProductGrid` on the org Overview tab (2+ products), using `releaseCount`.
