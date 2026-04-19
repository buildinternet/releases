# Categories, Tags, and Product Auto-Detection

**Date:** 2026-04-02
**Status:** Draft

## Problem

Released tracks hundreds of organizations and products but has no way to categorize or browse them by domain. "Show me all AI developer tools" requires manual inspection. Additionally, when the discovery agent onboards a multi-product organization (e.g., Vercel ships Next.js, Turborepo, v0), it creates flat org→source relationships without grouping sources into products — even though the product entity now exists.

## Solution

Two connected features:

1. **Categories and tags** on organizations and products — a controlled category vocabulary for reliable filtering, plus freeform tags for specifics.
2. **Product auto-detection** during discovery — the agent evaluates whether an org's sources represent distinct products and creates product entities when confidence is high.

Categories and tags must exist before the agent can assign them, so they're built first.

## Part 1: Categories & Tags

### Categories (in code)

A controlled list defined as a TypeScript const in `src/lib/categories.ts`:

```typescript
export const CATEGORIES = [
  "ai",
  "cloud",
  "database",
  "design",
  "developer-tools",
  "devops",
  "framework",
  "infrastructure",
  "observability",
  "security",
] as const;

export type Category = (typeof CATEGORIES)[number];
```

Both `organizations` and `products` gain a nullable `category` text column. Validated at the application layer against the `CATEGORIES` list — not enforced by the database. Adding a new category is a code change.

### Tags (in database)

**`tags` table:**

| Column    | Type | Constraints                |
| --------- | ---- | -------------------------- |
| id        | text | PK, `tag_` prefixed nanoid |
| name      | text | NOT NULL                   |
| slug      | text | NOT NULL, UNIQUE           |
| createdAt | text | NOT NULL, ISO timestamp    |

**`org_tags` join table:**

| Column    | Type | Constraints                                        |
| --------- | ---- | -------------------------------------------------- |
| orgId     | text | NOT NULL, FK → organizations(id) ON DELETE CASCADE |
| tagId     | text | NOT NULL, FK → tags(id) ON DELETE CASCADE          |
| createdAt | text | NOT NULL, ISO timestamp                            |

Primary key: `(orgId, tagId)`.

**`product_tags` join table:**

| Column    | Type | Constraints                                   |
| --------- | ---- | --------------------------------------------- |
| productId | text | NOT NULL, FK → products(id) ON DELETE CASCADE |
| tagId     | text | NOT NULL, FK → tags(id) ON DELETE CASCADE     |
| createdAt | text | NOT NULL, ISO timestamp                       |

Primary key: `(productId, tagId)`.

Separate join tables (rather than a single polymorphic table) so foreign keys and cascade deletes work correctly without application-layer cleanup or triggers.

Tags use **get-or-create** semantics: when tagging an entity with "typescript", if the tag row doesn't exist, it's created. Slug is auto-derived from name via `toSlug()`.

### Schema Changes

**organizations table** — add column:

- `category text` (nullable)

**products table** — add column:

- `category text` (nullable)

**New tables:** `tags`, `org_tags`, `product_tags` as defined above.

**New ID generator:** `newTagId()` in `src/lib/id.ts` producing `tag_` prefixed IDs.

### CLI

**Category on existing commands:**

- `org add "Vercel" --category cloud` — set at creation
- `org edit vercel --category developer-tools` — update
- `org edit vercel --no-category` — clear
- `product add --org vercel "Next.js" --category framework`
- `product edit nextjs --category framework`

**Tags on existing commands (inline at creation):**

- `org add "Vercel" --category cloud --tags typescript,cloud-hosting`
- `product add --org vercel "Next.js" --category framework --tags react,ssr`

**Tag subcommands:**

- `org tag add vercel typescript cloud-hosting` — add one or more tags (positional args)
- `org tag remove vercel cloud-hosting` — remove tags
- `org tag list vercel` — list tags for an org
- `product tag add nextjs react ssr` — same pattern
- `product tag remove nextjs ssr`
- `product tag list nextjs`

**Filtering:**

- `list --category ai` — filter sources whose org or product matches that category

**New command:**

- `released categories` — print the list of valid categories (supports `--json`)

### API

**Updated endpoints:**

`POST /orgs` and `PATCH /orgs/:slug` accept:

- `category?: string` — validated against CATEGORIES
- `tags?: string[]` — array of tag names, get-or-create

`GET /orgs` and `GET /orgs/:slug` return:

- `category: string | null`
- `tags: string[]` (tag names)

Same for all product endpoints: `POST /products`, `PATCH /products/:slug`, `GET /products`, `GET /products/:identifier`.

No separate tag CRUD API endpoints. Tags are managed through the parent entity's create/update endpoints and the CLI tag subcommands.

### Import Manifest

The manifest format gains optional `category` and `tags` on both org and product objects:

```json
{
  "organizations": [
    {
      "name": "Vercel",
      "category": "cloud",
      "tags": ["typescript", "edge-computing"],
      "products": [
        {
          "name": "Next.js",
          "category": "framework",
          "tags": ["react", "ssr"]
        }
      ]
    }
  ]
}
```

### Query Helpers

In `src/db/queries.ts`:

- `getTagsForOrg(orgId)` → `string[]`
- `getTagsForProduct(productId)` → `string[]`
- `setTagsForOrg(orgId, tagNames[])` — replaces all tags (get-or-create each, sync join table)
- `setTagsForProduct(productId, tagNames[])` — same
- `addTagsToOrg(orgId, tagNames[])` — additive
- `addTagsToProduct(productId, tagNames[])` — additive
- `removeTagsFromOrg(orgId, tagNames[])` — removal
- `removeTagsFromProduct(productId, tagNames[])` — removal

In `src/api/client.ts`: remote-mode equivalents that call the API.

## Part 2: Product Auto-Detection

### When It Runs

During the existing discovery/onboard flow in `src/agent/run-discovery.ts`. After the agent discovers sources for an org, it evaluates whether those sources should be grouped into products.

### Detection Signals

The agent uses its judgment based on available signals:

- **Distinct GitHub repos** — `vercel/next.js` and `vercel/turbo` are clearly different products
- **Different subdomains or domains** — `nextjs.org/blog/changelog` vs `turbo.build/changelog`
- **Changelog titles and naming** — source names that reference a specific product name distinct from the org name
- **General knowledge** — the agent knows that well-known orgs ship specific products

### Confidence and Actions

| Confidence | Criteria                                                                          | Agent action                                                          |
| ---------- | --------------------------------------------------------------------------------- | --------------------------------------------------------------------- |
| High       | Multiple clear signals (separate repos + separate domains + distinct names)       | Auto-create product via CLI, assign sources, set category and tags    |
| Medium     | Some signals (different repo names but shared domain, or general knowledge alone) | Record in discovery state as `suggestedProducts[]`, don't auto-create |
| Low        | Ambiguous (different pages but could be same product)                             | No product suggestion                                                 |

### Agent Prompt Changes

The category list is injected into the agent's initial prompt by `run-discovery.ts` — not hardcoded into skills. The agent has the full list available and uses its judgment to assign categories and tags.

### Agent Skill Updates

Light-touch updates to the `finding-changelogs` skill:

- Mention that the product entity exists and when to use it
- Reference the CLI commands for creating products and managing tags (`product add`, `org tag add`, etc.)
- No rigid process or decision trees — the agent uses its judgment given the context

### Discovery State File

The state file (`/tmp/discovery-state.json`) gains:

On the top-level org object:

- `category: string` — assigned category
- `tags: string[]` — assigned tags

On each source:

- `productSlug?: string` — if assigned to an auto-created product

New field for medium-confidence suggestions:

```json
{
  "suggestedProducts": [
    {
      "name": "Next.js",
      "confidence": "medium",
      "reason": "Separate GitHub repo vercel/next.js with dedicated changelog",
      "suggestedSources": ["nextjs-github", "nextjs-blog"],
      "suggestedCategory": "framework",
      "suggestedTags": ["react", "ssr"]
    }
  ]
}
```

## Migration

### D1 Migration

Single migration adding:

1. `category` column to `organizations`
2. `category` column to `products`
3. `tags` table
4. `org_tags` table with FKs and composite PK
5. `product_tags` table with FKs and composite PK

### Local Drizzle Migration

Generated via `npx drizzle-kit generate` after schema changes.

### Data Backfill

No backfill required. Existing orgs and products start with `category = null` and no tags. Categories and tags are populated organically through CLI use, import manifests, and agent discovery.
