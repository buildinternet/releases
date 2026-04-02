# Product Entity

**Date:** 2026-04-02
**Status:** Draft

## Problem

Released tracks changelog sources per organization, but many orgs ship multiple distinct products. Vercel ships Next.js, Turborepo, v0, and the Vercel platform itself. Without a product entity, these are either flattened under one org (losing grouping) or split into separate orgs (losing the parent relationship). "What's new in Next.js?" requires heuristic slug matching instead of a first-class query.

## Solution

Add a `products` table between organizations and sources. Products are optional — simple orgs with one changelog skip this layer entirely. Sources gain a nullable `productId` foreign key.

```
organizations
  └── products       (name, slug, orgId, url, description)
        └── sources  (adds nullable productId FK)
              └── releases
```

## Data Model

### New table: `products`

| Column | Type | Constraints | Notes |
|--------|------|-------------|-------|
| id | text | PK | `newProductId()` prefixed ID |
| name | text | NOT NULL | Display name ("Next.js") |
| slug | text | NOT NULL, UNIQUE | URL-safe identifier ("nextjs") |
| orgId | text | NOT NULL, FK → organizations (cascade) | Parent org |
| url | text | nullable | Canonical product URL (e.g., `https://nextjs.org`) |
| description | text | nullable | Brief description |
| createdAt | text | NOT NULL | ISO timestamp |

Indexes: `idx_products_org` on `(orgId)`.

### Modified table: `sources`

Add column:
- `productId text` — nullable FK → products (set null on delete)
- Index: `idx_sources_product` on `(productId)`

Existing sources retain `productId = NULL`. Both `orgId` and `productId` can be set — `orgId` remains the org-level grouping, `productId` adds the product-level grouping within that org.

### Types

```typescript
export type Product = typeof products.$inferSelect;
export type NewProduct = typeof products.$inferInsert;
```

## Database Migration (D1)

```sql
CREATE TABLE products (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  slug TEXT NOT NULL UNIQUE,
  org_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  url TEXT,
  description TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX idx_products_org ON products(org_id);

ALTER TABLE sources ADD COLUMN product_id TEXT REFERENCES products(id) ON DELETE SET NULL;
CREATE INDEX idx_sources_product ON sources(product_id);
```

## Query Layer (`src/db/queries.ts`)

### New functions

- `createProduct(orgId, name, opts?)` — Create product under org. Opts: slug, url, description.
- `findProduct(identifier)` — Find by slug, name, or ID.
- `getProductsByOrg(orgId)` — List products for an org, with source counts.
- `updateProduct(product, data)` — Update product fields.
- `deleteProduct(productId)` — Delete product (sources get productId set to null).
- `adoptOrgAsProduct(sourceOrgSlug, targetOrgSlug, opts?)` — Migration helper (see CLI section).

### Modified functions

- `listSourcesWithOrg()` — Join products table, include `productSlug` and `productName` in result.
- `getStatsSummary()` — Add product count.
- `getSourcesByOrg()` — Accept optional `productId` filter.
- `createSource()` — Accept optional `productId`.

## API Routes

### New: `workers/api/src/routes/products.ts`

| Method | Path | Description |
|--------|------|-------------|
| GET | `/orgs/:slug/products` | List products for org (with source counts) |
| GET | `/products/:slug` | Get product by slug |
| POST | `/orgs/:slug/products` | Create product under org |
| PATCH | `/products/:slug` | Update product |
| DELETE | `/products/:slug` | Delete product |
| POST | `/products/:slug/adopt` | Adopt org-as-product migration |

### Modified routes

- `GET /sources` — Accept `productSlug` filter param. Include `productSlug`/`productName` in response.
- `GET /orgs/:slug` — Include products array in org detail response.
- `GET /stats` — Include product count.

## API Client (`src/api/client.ts`)

Mirror new product endpoints for remote mode:
- `createProduct(orgSlug, name, opts)`
- `findProduct(slug)`
- `getProductsByOrg(orgSlug)`
- `updateProduct(slug, data)`
- `deleteProduct(slug)`
- `adoptOrgAsProduct(sourceOrgSlug, targetOrgSlug, opts)`

## CLI Commands

### New: `src/cli/commands/product.ts`

**`product list [org-slug]`** — List products, optionally filtered by org. Shows source count per product.

**`product add <name> --org <org-slug>`** — Create product under org. Options: `--slug`, `--url`, `--description`.

**`product remove <slug>`** — Delete product. Sources become unlinked (productId → null), not deleted.

**`product adopt <source-org-slug> --into <target-org-slug>`** — Migrate an org that should be a product:
1. Create a new product under the target org, using the source org's name/slug/description. If the source org has a `domain`, use it as the product's `url` (e.g., `nextjs.org` → `https://nextjs.org`). Override with `--url`.
2. Move all sources from the source org to the target org, linking them to the new product.
3. Move org accounts from the source org to the target org (skip duplicates).
4. Prompt for confirmation, then delete the now-empty source org.
5. Supports `--dry-run` and `--json`.

**`product edit <slug>`** — Update product fields. Options: `--name`, `--url`, `--description`.

### Modified commands

- **`add`** — Accept `--product <slug>` to assign source to a product.
- **`edit`** (source) — Accept `--product <slug>` to move a source to a product.
- **`list`** — Show product name in source listing when present. Accept `--product <slug>` filter.
- **`import`** — Accept `products` array in manifest (see below).
- **`org`** — Show product count in org detail.

### Import manifest extension

```typescript
interface ManifestProduct {
  name: string;
  slug?: string;
  url?: string;
  description?: string;
  sources?: ManifestSource[];
}

interface ManifestOrg {
  // ...existing fields...
  products?: ManifestProduct[];
}
```

Sources can appear at three levels:
1. `org.sources[]` — org-level, no product
2. `org.products[].sources[]` — product-level
3. Top-level `manifest.sources[]` — independent, no org or product

## Registry Schema

The product entity maps into the registry schema discussed previously:

```json
{
  "name": "Vercel",
  "slug": "vercel",
  "domain": "vercel.com",
  "products": [
    {
      "name": "Next.js",
      "slug": "nextjs",
      "url": "https://nextjs.org",
      "sources": [
        { "name": "Next.js GitHub Releases", "url": "https://github.com/vercel/next.js/releases", "type": "github" },
        { "name": "Next.js Blog", "url": "https://nextjs.org/blog", "type": "scrape", "isPrimary": true }
      ]
    },
    {
      "name": "Turborepo",
      "slug": "turborepo",
      "url": "https://turbo.build",
      "sources": [
        { "name": "Turborepo Releases", "url": "https://github.com/vercel/turborepo/releases", "type": "github" }
      ]
    }
  ],
  "sources": [
    { "name": "Vercel Changelog", "url": "https://vercel.com/changelog", "type": "feed", "isPrimary": true }
  ]
}
```

Org-level `sources` (no product) and product-level `sources` coexist. The Vercel platform changelog doesn't belong to any specific product — it stays at the org level.

## Not Changing

- **Releases table** — still keyed to sourceId, no product FK needed.
- **Fetch pipeline** — operates on sources, unaware of products.
- **Search/enrich/summarize** — source-level operations, unaffected.
- **Agent/discovery** — can be updated later to assign products during onboarding.
- **Block/ignore lists** — URL-level, unaffected.
- **Session management** — source-level, unaffected.

## Migration Path

Existing data requires no backfill. All sources start with `productId = NULL`. Products are added incrementally via:
1. `product add` for new products
2. `product adopt` to migrate orgs that should be products
3. `import` with product-aware manifests

The `product adopt` command is the primary tool for cleaning up early data where products were incorrectly added as standalone orgs.
