# Categories, Tags, and Product Auto-Detection Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add category and tag support to organizations and products, then enable the discovery agent to auto-detect products and assign categories/tags during onboarding.

**Architecture:** Categories are a TypeScript const validated at the app layer. Tags live in a `tags` table with `org_tags` and `product_tags` join tables using proper FKs. The agent gets the category list injected into its system prompt and uses CLI commands to assign categories, tags, and create products.

**Tech Stack:** TypeScript, Drizzle ORM, SQLite/D1, Hono, Commander CLI

---

## File Structure

### New files

- `src/lib/categories.ts` — Category const and type
- `workers/api/migrations/0014_categories_tags.sql` — D1 migration
- `src/db/migrations/0010_*.sql` — Local Drizzle migration (generated)

### Modified files

- `src/lib/id.ts` — Add `newTagId()`
- `src/db/schema.ts` — Add `tags`, `org_tags`, `product_tags` tables; add `category` to orgs and products
- `src/db/queries.ts` — Add tag CRUD helpers; update `createOrg`, `createProduct`
- `src/api/client.ts` — Remote-mode tag helpers; update org/product create/update
- `workers/api/src/routes/orgs.ts` — Accept/return `category` and `tags`
- `workers/api/src/routes/products.ts` — Accept/return `category` and `tags`
- `workers/api/src/index.ts` — Cache rules for new routes (if any)
- `src/cli/commands/org.ts` — `--category`, `--tags` flags; `org tag add/remove/list`
- `src/cli/commands/product.ts` — `--category`, `--tags` flags; `product tag add/remove/list`
- `src/cli/commands/import.ts` — Category and tags in manifest
- `src/cli/commands/list.ts` — `--category` filter
- `src/cli/program.ts` — Register `categories` command
- `src/agent/released.ts` — Inject category list into system prompt; add product/tag commands
- `src/agent/skills/finding-changelogs/SKILL.md` — Mention products, categories, tags
- `CLAUDE.md` — Document category/tag conventions
- `README.md` — Document category/tag CLI usage

---

### Task 1: Categories const and tag ID generator

**Files:**

- Create: `src/lib/categories.ts`
- Modify: `src/lib/id.ts`

- [ ] **Step 1: Create categories module**

```typescript
// src/lib/categories.ts
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

export function isValidCategory(value: string): value is Category {
  return (CATEGORIES as readonly string[]).includes(value);
}
```

- [ ] **Step 2: Add tag ID generator**

In `src/lib/id.ts`, add after the `newProductId` line:

```typescript
export const newTagId = () => `tag_${nanoid()}`;
```

- [ ] **Step 3: Type-check**

Run: `npx tsc --noEmit`
Expected: No new errors

- [ ] **Step 4: Commit**

```bash
git add src/lib/categories.ts src/lib/id.ts
git commit -m "feat: add categories const and tag ID generator"
```

---

### Task 2: Schema — tags, org_tags, product_tags tables; category columns

**Files:**

- Modify: `src/db/schema.ts`

- [ ] **Step 1: Add category column to organizations**

In `src/db/schema.ts`, add `category` to the `organizations` table definition, after the `description` field:

```typescript
  category: text("category"),
```

- [ ] **Step 2: Add category column to products**

In `src/db/schema.ts`, add `category` to the `products` table definition, after the `description` field:

```typescript
  category: text("category"),
```

- [ ] **Step 3: Add tags table**

After the `products` table and before the `sources` table, add:

```typescript
export const tags = sqliteTable("tags", {
  id: text("id").primaryKey().$defaultFn(newTagId),
  name: text("name").notNull(),
  slug: text("slug").notNull().unique(),
  createdAt: text("created_at")
    .notNull()
    .$defaultFn(() => new Date().toISOString()),
});
```

- [ ] **Step 4: Add org_tags join table**

After the `tags` table:

```typescript
export const orgTags = sqliteTable(
  "org_tags",
  {
    orgId: text("org_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    tagId: text("tag_id")
      .notNull()
      .references(() => tags.id, { onDelete: "cascade" }),
    createdAt: text("created_at")
      .notNull()
      .$defaultFn(() => new Date().toISOString()),
  },
  (table) => [index("idx_org_tags_tag").on(table.tagId)],
);
```

Note: The composite PK `(orgId, tagId)` is enforced via a unique index in the D1 migration since Drizzle SQLite uses `sqliteTable` which doesn't support composite PKs directly. We'll add a unique index.

Update the table definition to include a unique index:

```typescript
export const orgTags = sqliteTable(
  "org_tags",
  {
    orgId: text("org_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    tagId: text("tag_id")
      .notNull()
      .references(() => tags.id, { onDelete: "cascade" }),
    createdAt: text("created_at")
      .notNull()
      .$defaultFn(() => new Date().toISOString()),
  },
  (table) => [
    uniqueIndex("idx_org_tags_pk").on(table.orgId, table.tagId),
    index("idx_org_tags_tag").on(table.tagId),
  ],
);
```

- [ ] **Step 5: Add product_tags join table**

```typescript
export const productTags = sqliteTable(
  "product_tags",
  {
    productId: text("product_id")
      .notNull()
      .references(() => products.id, { onDelete: "cascade" }),
    tagId: text("tag_id")
      .notNull()
      .references(() => tags.id, { onDelete: "cascade" }),
    createdAt: text("created_at")
      .notNull()
      .$defaultFn(() => new Date().toISOString()),
  },
  (table) => [
    uniqueIndex("idx_product_tags_pk").on(table.productId, table.tagId),
    index("idx_product_tags_tag").on(table.tagId),
  ],
);
```

- [ ] **Step 6: Add type exports**

After the existing type exports, add:

```typescript
export type Tag = typeof tags.$inferSelect;
export type NewTag = typeof tags.$inferInsert;
```

- [ ] **Step 7: Update imports**

Add `newTagId` to the import from `../lib/id.js` at the top of `schema.ts`. Add `uniqueIndex` to the drizzle-orm import if not already there (it's already imported).

- [ ] **Step 8: Type-check**

Run: `npx tsc --noEmit`
Expected: No new errors

- [ ] **Step 9: Generate local Drizzle migration**

Run: `npx drizzle-kit generate`
Expected: A new migration file in `src/db/migrations/`

- [ ] **Step 10: Commit**

```bash
git add src/db/schema.ts src/db/migrations/
git commit -m "feat: add tags, org_tags, product_tags tables and category columns to schema"
```

---

### Task 3: D1 migration

**Files:**

- Create: `workers/api/migrations/0014_categories_tags.sql`

- [ ] **Step 1: Write the D1 migration**

```sql
-- Add category column to organizations
ALTER TABLE organizations ADD COLUMN category TEXT;

-- Add category column to products
ALTER TABLE products ADD COLUMN category TEXT;

-- Tags table
CREATE TABLE tags (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  slug TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL
);

-- Org-tag join table
CREATE TABLE org_tags (
  org_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  tag_id TEXT NOT NULL REFERENCES tags(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL
);
CREATE UNIQUE INDEX idx_org_tags_pk ON org_tags(org_id, tag_id);
CREATE INDEX idx_org_tags_tag ON org_tags(tag_id);

-- Product-tag join table
CREATE TABLE product_tags (
  product_id TEXT NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  tag_id TEXT NOT NULL REFERENCES tags(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL
);
CREATE UNIQUE INDEX idx_product_tags_pk ON product_tags(product_id, tag_id);
CREATE INDEX idx_product_tags_tag ON product_tags(tag_id);
```

- [ ] **Step 2: Commit**

```bash
git add workers/api/migrations/0014_categories_tags.sql
git commit -m "feat: add D1 migration for categories and tags"
```

---

### Task 4: Query helpers — tag CRUD and category support

**Files:**

- Modify: `src/db/queries.ts`

- [ ] **Step 1: Add imports**

Add `tags, orgTags, productTags` to the schema import. Add `Tag` to the type import.

- [ ] **Step 2: Add tag get-or-create helper**

```typescript
export async function getOrCreateTag(name: string): Promise<Tag> {
  if (isRemoteMode()) return apiClient.getOrCreateTag(name);
  const db = getDb();
  const slug = toSlug(name);
  const [existing] = await db.select().from(tags).where(eq(tags.slug, slug));
  if (existing) return existing;
  const [created] = await db.insert(tags).values({ name, slug }).returning();
  return created;
}
```

- [ ] **Step 3: Add tag query helpers for orgs**

```typescript
export async function getTagsForOrg(orgId: string): Promise<string[]> {
  if (isRemoteMode()) return apiClient.getTagsForOrg(orgId);
  const db = getDb();
  const rows = await db
    .select({ name: tags.name })
    .from(orgTags)
    .innerJoin(tags, eq(orgTags.tagId, tags.id))
    .where(eq(orgTags.orgId, orgId))
    .orderBy(tags.name);
  return rows.map((r) => r.name);
}

export async function addTagsToOrg(orgId: string, tagNames: string[]): Promise<void> {
  if (isRemoteMode()) return apiClient.addTagsToOrg(orgId, tagNames);
  const db = getDb();
  for (const name of tagNames) {
    const tag = await getOrCreateTag(name);
    await db.insert(orgTags).values({ orgId, tagId: tag.id }).onConflictDoNothing();
  }
}

export async function removeTagsFromOrg(orgId: string, tagNames: string[]): Promise<void> {
  if (isRemoteMode()) return apiClient.removeTagsFromOrg(orgId, tagNames);
  const db = getDb();
  for (const name of tagNames) {
    const slug = toSlug(name);
    const [tag] = await db.select().from(tags).where(eq(tags.slug, slug));
    if (tag) {
      await db.delete(orgTags).where(and(eq(orgTags.orgId, orgId), eq(orgTags.tagId, tag.id)));
    }
  }
}
```

- [ ] **Step 4: Add tag query helpers for products**

```typescript
export async function getTagsForProduct(productId: string): Promise<string[]> {
  if (isRemoteMode()) return apiClient.getTagsForProduct(productId);
  const db = getDb();
  const rows = await db
    .select({ name: tags.name })
    .from(productTags)
    .innerJoin(tags, eq(productTags.tagId, tags.id))
    .where(eq(productTags.productId, productId))
    .orderBy(tags.name);
  return rows.map((r) => r.name);
}

export async function addTagsToProduct(productId: string, tagNames: string[]): Promise<void> {
  if (isRemoteMode()) return apiClient.addTagsToProduct(productId, tagNames);
  const db = getDb();
  for (const name of tagNames) {
    const tag = await getOrCreateTag(name);
    await db.insert(productTags).values({ productId, tagId: tag.id }).onConflictDoNothing();
  }
}

export async function removeTagsFromProduct(productId: string, tagNames: string[]): Promise<void> {
  if (isRemoteMode()) return apiClient.removeTagsFromProduct(productId, tagNames);
  const db = getDb();
  for (const name of tagNames) {
    const slug = toSlug(name);
    const [tag] = await db.select().from(tags).where(eq(tags.slug, slug));
    if (tag) {
      await db
        .delete(productTags)
        .where(and(eq(productTags.productId, productId), eq(productTags.tagId, tag.id)));
    }
  }
}
```

- [ ] **Step 5: Update createOrg to accept category**

Change the `createOrg` function signature and body:

```typescript
export async function createOrg(
  name: string,
  opts?: { slug?: string; domain?: string; description?: string; category?: string },
): Promise<Organization> {
  if (isRemoteMode()) return apiClient.createOrg(name, opts);
  const db = getDb();
  const slug = opts?.slug ?? toSlug(name);
  const now = new Date().toISOString();
  const [created] = await db
    .insert(organizations)
    .values({
      name,
      slug,
      domain: opts?.domain ?? null,
      description: opts?.description ?? null,
      category: opts?.category ?? null,
      createdAt: now,
      updatedAt: now,
    })
    .returning();
  return created;
}
```

- [ ] **Step 6: Update createProduct to accept category**

Change the `createProduct` function signature and body:

```typescript
export async function createProduct(
  orgId: string,
  name: string,
  opts?: { slug?: string; url?: string; description?: string; category?: string },
): Promise<Product> {
  if (isRemoteMode()) return apiClient.createProduct(orgId, name, opts);
  const db = getDb();
  const slug = opts?.slug ?? toSlug(name);
  const [created] = await db
    .insert(products)
    .values({
      name,
      slug,
      orgId,
      url: opts?.url ?? null,
      description: opts?.description ?? null,
      category: opts?.category ?? null,
    })
    .returning();
  return created;
}
```

- [ ] **Step 7: Update listSourcesWithOrg to support category filter**

Add a `category` option to the `listSourcesWithOrg` opts interface:

```typescript
export async function listSourcesWithOrg(opts?: {
  orgSlug?: string;
  productSlug?: string;
  category?: string;
  hasFeed?: boolean;
  enrichable?: boolean;
  query?: string;
  includeHidden?: boolean;
}): Promise<SourceWithOrg[]> {
```

Add this condition block after the existing `productSlug` condition:

```typescript
if (opts?.category) {
  conditions.push(
    or(eq(organizations.category, opts.category), eq(products.category, opts.category))!,
  );
}
```

- [ ] **Step 8: Type-check**

Run: `npx tsc --noEmit`
Expected: Errors about missing apiClient functions (added in next task)

- [ ] **Step 9: Commit**

```bash
git add src/db/queries.ts
git commit -m "feat: add tag CRUD helpers and category support to query functions"
```

---

### Task 5: API client — remote mode tag/category support

**Files:**

- Modify: `src/api/client.ts`

- [ ] **Step 1: Add Tag type import**

Add `Tag` to the schema type import.

- [ ] **Step 2: Add tag remote functions**

After the product queries section:

```typescript
// ── Tags ──

export async function getOrCreateTag(name: string): Promise<Tag> {
  return apiFetch<Tag>("/api/tags", {
    method: "POST",
    body: JSON.stringify({ name }),
  });
}

export async function getTagsForOrg(orgId: string): Promise<string[]> {
  return apiFetch<string[]>(`/api/orgs/${orgId}/tags`);
}

export async function addTagsToOrg(orgId: string, tagNames: string[]): Promise<void> {
  await apiFetch(`/api/orgs/${orgId}/tags`, {
    method: "PUT",
    body: JSON.stringify({ tags: tagNames }),
  });
}

export async function removeTagsFromOrg(orgId: string, tagNames: string[]): Promise<void> {
  await apiFetch(`/api/orgs/${orgId}/tags`, {
    method: "DELETE",
    body: JSON.stringify({ tags: tagNames }),
  });
}

export async function getTagsForProduct(productId: string): Promise<string[]> {
  return apiFetch<string[]>(`/api/products/${productId}/tags`);
}

export async function addTagsToProduct(productId: string, tagNames: string[]): Promise<void> {
  await apiFetch(`/api/products/${productId}/tags`, {
    method: "PUT",
    body: JSON.stringify({ tags: tagNames }),
  });
}

export async function removeTagsFromProduct(productId: string, tagNames: string[]): Promise<void> {
  await apiFetch(`/api/products/${productId}/tags`, {
    method: "DELETE",
    body: JSON.stringify({ tags: tagNames }),
  });
}
```

- [ ] **Step 3: Update createOrg to pass category**

In the `createOrg` function, add `category` to the body:

```typescript
export async function createOrg(
  name: string,
  opts?: { slug?: string; domain?: string; description?: string; category?: string },
): Promise<Organization> {
  return apiFetch<Organization>("/api/orgs", {
    method: "POST",
    body: JSON.stringify({
      name,
      slug: opts?.slug,
      domain: opts?.domain,
      description: opts?.description,
      category: opts?.category,
    }),
  });
}
```

- [ ] **Step 4: Update createProduct to pass category**

```typescript
export async function createProduct(
  orgId: string,
  name: string,
  opts?: { slug?: string; url?: string; description?: string; category?: string },
): Promise<Product> {
  return apiFetch<Product>(`/api/products`, {
    method: "POST",
    body: JSON.stringify({
      orgId,
      name,
      slug: opts?.slug,
      url: opts?.url,
      description: opts?.description,
      category: opts?.category,
    }),
  });
}
```

- [ ] **Step 5: Update listSourcesWithOrg to pass category**

In the existing `listSourcesWithOrg` function, add category to the query params:

```typescript
if (opts?.category) params.set("category", opts.category);
```

- [ ] **Step 6: Type-check**

Run: `npx tsc --noEmit`
Expected: No new errors (API routes not yet updated but client compiles independently)

- [ ] **Step 7: Commit**

```bash
git add src/api/client.ts
git commit -m "feat: add remote mode tag and category support to API client"
```

---

### Task 6: API routes — org tag/category endpoints

**Files:**

- Modify: `workers/api/src/routes/orgs.ts`

- [ ] **Step 1: Add tags schema import**

Add `tags, orgTags` to the schema import:

```typescript
import {
  organizations,
  orgAccounts,
  sources,
  releases,
  products,
  tags,
  orgTags,
} from "../../../../src/db/schema.js";
```

Add `isValidCategory` import:

```typescript
import { isValidCategory } from "../../../../src/lib/categories.js";
```

- [ ] **Step 2: Update GET /orgs to return category**

In the `GET /orgs` handler, add `o.category` to the raw SQL select and map it in the result:

In the SQL select, add after `o.description,`:

```sql
o.category,
```

In the result mapping, add after `description: row.description,`:

```typescript
category: row.category,
```

Update the type annotation on `rows` to include `category: string | null`.

- [ ] **Step 3: Update GET /orgs/:slug to return category and tags**

After the `accounts` query, add a tags query:

```typescript
const tagRows = await db
  .select({ name: tags.name })
  .from(orgTags)
  .innerJoin(tags, eq(orgTags.tagId, tags.id))
  .where(eq(orgTags.orgId, org.id))
  .orderBy(tags.name);
```

In the response JSON, add:

```typescript
    category: org.category,
    tags: tagRows.map((t) => t.name),
```

- [ ] **Step 4: Update POST /orgs to accept category and tags**

Change the body type to include `category` and `tags`:

```typescript
const body = await c.req.json<{
  name: string;
  slug?: string;
  domain?: string;
  description?: string;
  category?: string;
  tags?: string[];
}>();
```

Add category validation before the insert:

```typescript
if (body.category && !isValidCategory(body.category)) {
  return c.json({ error: "bad_request", message: `Invalid category: "${body.category}"` }, 400);
}
```

Add `category: body.category ?? null` to the values object.

After the org is created, handle tags:

```typescript
if (body.tags && body.tags.length > 0) {
  for (const tagName of body.tags) {
    const tagSlug = toSlug(tagName);
    let [tag] = await db.select().from(tags).where(eq(tags.slug, tagSlug));
    if (!tag) {
      [tag] = await db.insert(tags).values({ name: tagName, slug: tagSlug }).returning();
    }
    await db.insert(orgTags).values({ orgId: org.id, tagId: tag.id }).onConflictDoNothing();
  }
}
```

- [ ] **Step 5: Update PATCH /orgs/:slug to accept category and tags**

Change the body type:

```typescript
const body = await c.req.json<{
  name?: string;
  domain?: string | null;
  description?: string | null;
  category?: string | null;
  tags?: string[];
}>();
```

Add category validation:

```typescript
if (body.category !== undefined && body.category !== null && !isValidCategory(body.category)) {
  return c.json({ error: "bad_request", message: `Invalid category: "${body.category}"` }, 400);
}
```

Add to the updates object:

```typescript
if (body.category !== undefined) updates.category = body.category;
```

After the update, handle tags if provided:

```typescript
if (body.tags !== undefined) {
  // Replace all tags
  await db.delete(orgTags).where(eq(orgTags.orgId, org.id));
  for (const tagName of body.tags) {
    const tagSlug = toSlug(tagName);
    let [tag] = await db.select().from(tags).where(eq(tags.slug, tagSlug));
    if (!tag) {
      [tag] = await db.insert(tags).values({ name: tagName, slug: tagSlug }).returning();
    }
    await db.insert(orgTags).values({ orgId: org.id, tagId: tag.id }).onConflictDoNothing();
  }
}
```

- [ ] **Step 6: Add GET /orgs/:id/tags endpoint**

Before the activity endpoint:

```typescript
orgRoutes.get("/orgs/:slug/tags", async (c) => {
  const db = createDb(c.env.DB);
  const slug = c.req.param("slug");

  const [org] = await db
    .select()
    .from(organizations)
    .where(slug.startsWith("org_") ? eq(organizations.id, slug) : eq(organizations.slug, slug));
  if (!org) return c.json({ error: "not_found", message: "Organization not found" }, 404);

  const rows = await db
    .select({ name: tags.name })
    .from(orgTags)
    .innerJoin(tags, eq(orgTags.tagId, tags.id))
    .where(eq(orgTags.orgId, org.id))
    .orderBy(tags.name);

  return c.json(rows.map((r) => r.name));
});
```

- [ ] **Step 7: Add PUT /orgs/:id/tags endpoint (add tags)**

```typescript
orgRoutes.put("/orgs/:slug/tags", async (c) => {
  const db = createDb(c.env.DB);
  const slug = c.req.param("slug");
  const body = await c.req.json<{ tags: string[] }>();

  const [org] = await db
    .select()
    .from(organizations)
    .where(slug.startsWith("org_") ? eq(organizations.id, slug) : eq(organizations.slug, slug));
  if (!org) return c.json({ error: "not_found", message: "Organization not found" }, 404);

  for (const tagName of body.tags) {
    const tagSlug = toSlug(tagName);
    let [tag] = await db.select().from(tags).where(eq(tags.slug, tagSlug));
    if (!tag) {
      [tag] = await db.insert(tags).values({ name: tagName, slug: tagSlug }).returning();
    }
    await db.insert(orgTags).values({ orgId: org.id, tagId: tag.id }).onConflictDoNothing();
  }

  return c.json({ ok: true });
});
```

- [ ] **Step 8: Add DELETE /orgs/:id/tags endpoint (remove tags)**

```typescript
orgRoutes.delete("/orgs/:slug/tags", async (c) => {
  const db = createDb(c.env.DB);
  const slug = c.req.param("slug");
  const body = await c.req.json<{ tags: string[] }>();

  const [org] = await db
    .select()
    .from(organizations)
    .where(slug.startsWith("org_") ? eq(organizations.id, slug) : eq(organizations.slug, slug));
  if (!org) return c.json({ error: "not_found", message: "Organization not found" }, 404);

  for (const tagName of body.tags) {
    const tagSlug = toSlug(tagName);
    const [tag] = await db.select().from(tags).where(eq(tags.slug, tagSlug));
    if (tag) {
      await db.delete(orgTags).where(and(eq(orgTags.orgId, org.id), eq(orgTags.tagId, tag.id)));
    }
  }

  return c.json({ ok: true });
});
```

- [ ] **Step 9: Add POST /tags endpoint (get-or-create)**

This can go in orgs.ts or a new tags route file. Since it's small, add to orgs.ts:

```typescript
orgRoutes.post("/tags", async (c) => {
  const db = createDb(c.env.DB);
  const body = await c.req.json<{ name: string }>();
  if (!body.name)
    return c.json({ error: "bad_request", message: "Missing required field: name" }, 400);

  const tagSlug = toSlug(body.name);
  const [existing] = await db.select().from(tags).where(eq(tags.slug, tagSlug));
  if (existing) return c.json(existing);

  const [created] = await db.insert(tags).values({ name: body.name, slug: tagSlug }).returning();
  return c.json(created, 201);
});
```

- [ ] **Step 10: Commit**

```bash
git add workers/api/src/routes/orgs.ts
git commit -m "feat: add category and tag support to org API routes"
```

---

### Task 7: API routes — product tag/category endpoints

**Files:**

- Modify: `workers/api/src/routes/products.ts`

- [ ] **Step 1: Add imports**

Add `tags, productTags` to the schema import. Add `isValidCategory`:

```typescript
import {
  products,
  sources,
  organizations,
  orgAccounts,
  tags,
  productTags,
} from "../../../../src/db/schema.js";
import { isValidCategory } from "../../../../src/lib/categories.js";
```

Add `and` to the drizzle-orm import.

- [ ] **Step 2: Update GET /products to return category**

In the select object, add after `createdAt`:

```typescript
      category: products.category,
```

- [ ] **Step 3: Update GET /products/:identifier to return category and tags**

After the product query, add:

```typescript
const tagRows = await db
  .select({ name: tags.name })
  .from(productTags)
  .innerJoin(tags, eq(productTags.tagId, tags.id))
  .where(eq(productTags.productId, product.id))
  .orderBy(tags.name);
```

In the response, add `category: product.category, tags: tagRows.map((t) => t.name)`:

```typescript
return c.json({ ...product, sources: productSources, tags: tagRows.map((t) => t.name) });
```

- [ ] **Step 4: Update POST /products to accept category and tags**

Change the body type:

```typescript
const body = await c.req.json<{
  orgId: string;
  name: string;
  slug?: string;
  url?: string;
  description?: string;
  category?: string;
  tags?: string[];
}>();
```

Add validation:

```typescript
if (body.category && !isValidCategory(body.category)) {
  return c.json({ error: "bad_request", message: `Invalid category: "${body.category}"` }, 400);
}
```

Add `category: body.category ?? null` to the values object.

After creation, handle tags:

```typescript
if (body.tags && body.tags.length > 0) {
  for (const tagName of body.tags) {
    const tagSlug = toSlug(tagName);
    let [tag] = await db.select().from(tags).where(eq(tags.slug, tagSlug));
    if (!tag) {
      [tag] = await db.insert(tags).values({ name: tagName, slug: tagSlug }).returning();
    }
    await db
      .insert(productTags)
      .values({ productId: created.id, tagId: tag.id })
      .onConflictDoNothing();
  }
}
```

- [ ] **Step 5: Update PATCH /products/:slug to accept category and tags**

Change the body type:

```typescript
const body = await c.req.json<{
  name?: string;
  url?: string | null;
  description?: string | null;
  category?: string | null;
  tags?: string[];
}>();
```

Add validation and updates:

```typescript
if (body.category !== undefined && body.category !== null && !isValidCategory(body.category)) {
  return c.json({ error: "bad_request", message: `Invalid category: "${body.category}"` }, 400);
}
if (body.category !== undefined) updates.category = body.category;
```

After the update, handle tags:

```typescript
if (body.tags !== undefined) {
  await db.delete(productTags).where(eq(productTags.productId, product.id));
  for (const tagName of body.tags) {
    const tagSlug = toSlug(tagName);
    let [tag] = await db.select().from(tags).where(eq(tags.slug, tagSlug));
    if (!tag) {
      [tag] = await db.insert(tags).values({ name: tagName, slug: tagSlug }).returning();
    }
    await db
      .insert(productTags)
      .values({ productId: product.id, tagId: tag.id })
      .onConflictDoNothing();
  }
}
```

- [ ] **Step 6: Add product tag endpoints**

```typescript
productRoutes.get("/products/:identifier/tags", async (c) => {
  const db = createDb(c.env.DB);
  const identifier = c.req.param("identifier");
  const [product] = await db
    .select()
    .from(products)
    .where(
      identifier.startsWith("prod_") ? eq(products.id, identifier) : eq(products.slug, identifier),
    );
  if (!product) return c.json({ error: "not_found", message: "Product not found" }, 404);

  const rows = await db
    .select({ name: tags.name })
    .from(productTags)
    .innerJoin(tags, eq(productTags.tagId, tags.id))
    .where(eq(productTags.productId, product.id))
    .orderBy(tags.name);
  return c.json(rows.map((r) => r.name));
});

productRoutes.put("/products/:identifier/tags", async (c) => {
  const db = createDb(c.env.DB);
  const identifier = c.req.param("identifier");
  const body = await c.req.json<{ tags: string[] }>();
  const [product] = await db
    .select()
    .from(products)
    .where(
      identifier.startsWith("prod_") ? eq(products.id, identifier) : eq(products.slug, identifier),
    );
  if (!product) return c.json({ error: "not_found", message: "Product not found" }, 404);

  for (const tagName of body.tags) {
    const tagSlug = toSlug(tagName);
    let [tag] = await db.select().from(tags).where(eq(tags.slug, tagSlug));
    if (!tag) {
      [tag] = await db.insert(tags).values({ name: tagName, slug: tagSlug }).returning();
    }
    await db
      .insert(productTags)
      .values({ productId: product.id, tagId: tag.id })
      .onConflictDoNothing();
  }
  return c.json({ ok: true });
});

productRoutes.delete("/products/:identifier/tags", async (c) => {
  const db = createDb(c.env.DB);
  const identifier = c.req.param("identifier");
  const body = await c.req.json<{ tags: string[] }>();
  const [product] = await db
    .select()
    .from(products)
    .where(
      identifier.startsWith("prod_") ? eq(products.id, identifier) : eq(products.slug, identifier),
    );
  if (!product) return c.json({ error: "not_found", message: "Product not found" }, 404);

  for (const tagName of body.tags) {
    const tagSlug = toSlug(tagName);
    const [tag] = await db.select().from(tags).where(eq(tags.slug, tagSlug));
    if (tag) {
      await db
        .delete(productTags)
        .where(and(eq(productTags.productId, product.id), eq(productTags.tagId, tag.id)));
    }
  }
  return c.json({ ok: true });
});
```

- [ ] **Step 7: Commit**

```bash
git add workers/api/src/routes/products.ts
git commit -m "feat: add category and tag support to product API routes"
```

---

### Task 8: CLI — category and tags on org commands

**Files:**

- Modify: `src/cli/commands/org.ts`

- [ ] **Step 1: Add imports**

```typescript
import { isValidCategory, CATEGORIES } from "../../lib/categories.js";
import { addTagsToOrg, removeTagsFromOrg, getTagsForOrg } from "../../db/queries.js";
```

Also add `getTagsForOrg` to the existing queries import.

- [ ] **Step 2: Update org add — add --category and --tags flags**

Add options:

```typescript
    .option("--category <category>", "Category (e.g. ai, cloud, framework)")
    .option("--tags <tags>", "Comma-separated tags (e.g. typescript,react)")
```

Update the action signature to include `category` and `tags`. Add validation:

```typescript
if (opts.category && !isValidCategory(opts.category)) {
  console.error(chalk.red(`Invalid category: "${opts.category}". Valid: ${CATEGORIES.join(", ")}`));
  process.exit(1);
}
```

Pass category to createOrg:

```typescript
const created = await createOrg(name, {
  slug,
  domain: opts.domain,
  description: opts.description,
  category: opts.category,
});
```

After creation, handle tags:

```typescript
if (opts.tags) {
  const tagList = opts.tags
    .split(",")
    .map((t: string) => t.trim())
    .filter(Boolean);
  if (tagList.length > 0) {
    await addTagsToOrg(created.id, tagList);
  }
}
```

- [ ] **Step 3: Update org show — display category and tags**

After loading the org, fetch tags:

```typescript
const orgTags = await getTagsForOrg(found.id);
```

Add to the display output after the `Updated` line:

```typescript
if (found.category) console.log(`  Category: ${found.category}`);
if (orgTags.length > 0) console.log(`  Tags:    ${orgTags.join(", ")}`);
```

Add to the JSON output:

```typescript
console.log(
  JSON.stringify(
    { ...found, accounts, products: orgProducts, sources: linkedSources, tags: orgTags },
    null,
    2,
  ),
);
```

- [ ] **Step 4: Add org edit subcommand (does not exist yet)**

Before the `unlink` command, add an `org edit` subcommand:

```typescript
org
  .command("edit")
  .description("Edit an organization")
  .argument("<identifier>", "Org slug, domain, or name")
  .option("--name <name>", "Update display name")
  .option("--domain <domain>", "Update domain")
  .option("--description <text>", "Update description")
  .option("--category <category>", "Set category")
  .option("--no-category", "Clear category")
  .option("--json", "Output as JSON")
  .action(
    async (
      identifier: string,
      opts: {
        name?: string;
        domain?: string;
        description?: string;
        category?: string | boolean;
        json?: boolean;
      },
    ) => {
      const found = await findOrg(identifier);
      if (!found) {
        console.error(chalk.red(`Organization not found: ${identifier}`));
        process.exit(1);
      }

      const updates: Record<string, unknown> = {};
      if (opts.name !== undefined) updates.name = opts.name;
      if (opts.domain !== undefined) updates.domain = opts.domain;
      if (opts.description !== undefined) updates.description = opts.description;

      if (opts.category === false) {
        updates.category = null;
      } else if (typeof opts.category === "string") {
        if (!isValidCategory(opts.category)) {
          console.error(
            chalk.red(`Invalid category: "${opts.category}". Valid: ${CATEGORIES.join(", ")}`),
          );
          process.exit(1);
        }
        updates.category = opts.category;
      }

      if (Object.keys(updates).length === 0) {
        console.error(chalk.yellow("No fields to update."));
        process.exit(1);
      }

      // Use the updateOrg query helper (add if not exists, or use the API PATCH)
      if (isRemoteMode()) {
        await apiClient.updateOrg(found.slug, updates);
      } else {
        const db = getDb();
        updates.updatedAt = new Date().toISOString();
        await db.update(organizations).set(updates).where(eq(organizations.id, found.id));
      }

      if (opts.json) {
        const updated = await findOrg(identifier);
        console.log(JSON.stringify(updated, null, 2));
      } else {
        console.log(chalk.green(`Updated organization: ${found.name} (${found.slug})`));
      }
    },
  );
```

Note: This requires adding `updateOrg` to `api/client.ts` and optionally a query helper. Alternatively, the implementer can use the existing PATCH endpoint pattern. The key point is that the `org edit` CLI command needs to exist — it doesn't currently. The implementer should follow the same pattern as `product edit` (which already exists) and use the API client's apiFetch to PATCH.

A simpler approach: add an `updateOrg` function to queries.ts:

```typescript
export async function updateOrg(
  org: Organization,
  data: Record<string, unknown>,
): Promise<Organization> {
  if (isRemoteMode()) return apiClient.updateOrg(org.slug, data);
  const db = getDb();
  data.updatedAt = new Date().toISOString();
  const [updated] = await db
    .update(organizations)
    .set(data)
    .where(eq(organizations.id, org.id))
    .returning();
  return updated;
}
```

And in `api/client.ts`:

```typescript
export async function updateOrg(
  slug: string,
  data: Record<string, unknown>,
): Promise<Organization> {
  return apiFetch<Organization>(`/api/orgs/${slug}`, {
    method: "PATCH",
    body: JSON.stringify(data),
  });
}
```

Then the org edit command becomes:

```typescript
const updated = await updateOrg(found, updates);
if (opts.json) {
  console.log(JSON.stringify(updated, null, 2));
} else {
  console.log(chalk.green(`Updated organization: ${updated.name} (${updated.slug})`));
}
```

- [ ] **Step 5: Add org tag subcommand**

After the `edit` command:

```typescript
const tag = org.command("tag").description("Manage organization tags");

tag
  .command("add")
  .description("Add tags to an organization")
  .argument("<identifier>", "Org slug")
  .argument("<tags...>", "Tag names to add")
  .option("--json", "Output as JSON")
  .action(async (identifier: string, tagNames: string[], opts: { json?: boolean }) => {
    const found = await findOrg(identifier);
    if (!found) {
      console.error(chalk.red(`Organization not found: ${identifier}`));
      process.exit(1);
    }
    await addTagsToOrg(found.id, tagNames);
    if (opts.json) {
      const allTags = await getTagsForOrg(found.id);
      console.log(JSON.stringify({ tags: allTags }, null, 2));
    } else {
      console.log(chalk.green(`Added tags to ${found.name}: ${tagNames.join(", ")}`));
    }
  });

tag
  .command("remove")
  .description("Remove tags from an organization")
  .argument("<identifier>", "Org slug")
  .argument("<tags...>", "Tag names to remove")
  .option("--json", "Output as JSON")
  .action(async (identifier: string, tagNames: string[], opts: { json?: boolean }) => {
    const found = await findOrg(identifier);
    if (!found) {
      console.error(chalk.red(`Organization not found: ${identifier}`));
      process.exit(1);
    }
    await removeTagsFromOrg(found.id, tagNames);
    if (opts.json) {
      const allTags = await getTagsForOrg(found.id);
      console.log(JSON.stringify({ tags: allTags }, null, 2));
    } else {
      console.log(chalk.green(`Removed tags from ${found.name}: ${tagNames.join(", ")}`));
    }
  });

tag
  .command("list")
  .description("List tags for an organization")
  .argument("<identifier>", "Org slug")
  .option("--json", "Output as JSON")
  .action(async (identifier: string, opts: { json?: boolean }) => {
    const found = await findOrg(identifier);
    if (!found) {
      console.error(chalk.red(`Organization not found: ${identifier}`));
      process.exit(1);
    }
    const allTags = await getTagsForOrg(found.id);
    if (opts.json) {
      console.log(JSON.stringify(allTags, null, 2));
    } else if (allTags.length === 0) {
      console.log(chalk.yellow(`No tags for ${found.name}`));
    } else {
      console.log(allTags.join(", "));
    }
  });
```

- [ ] **Step 6: Type-check**

Run: `npx tsc --noEmit`
Expected: No new errors

- [ ] **Step 7: Commit**

```bash
git add src/cli/commands/org.ts src/db/queries.ts src/api/client.ts
git commit -m "feat: add org edit command and category/tag support to org CLI"
```

---

### Task 9: CLI — category and tags on product commands

**Files:**

- Modify: `src/cli/commands/product.ts`

- [ ] **Step 1: Add imports**

```typescript
import { isValidCategory, CATEGORIES } from "../../lib/categories.js";
import { addTagsToProduct, removeTagsFromProduct, getTagsForProduct } from "../../db/queries.js";
```

- [ ] **Step 2: Update product add — add --category and --tags flags**

Add options:

```typescript
    .option("--category <category>", "Category (e.g. ai, framework, developer-tools)")
    .option("--tags <tags>", "Comma-separated tags (e.g. react,ssr)")
```

Add validation and pass category to `createProduct`. After creation, handle tags (same pattern as org add).

- [ ] **Step 3: Update product edit — add --category and --no-category flags**

Add options:

```typescript
    .option("--category <category>", "Set category")
    .option("--no-category", "Clear category")
```

Add to updates mapping:

```typescript
if (opts.category !== undefined) {
  if (opts.category === false) {
    updates.category = null;
  } else {
    if (!isValidCategory(opts.category)) {
      console.error(
        chalk.red(`Invalid category: "${opts.category}". Valid: ${CATEGORIES.join(", ")}`),
      );
      process.exit(1);
    }
    updates.category = opts.category;
  }
}
```

- [ ] **Step 4: Add product tag subcommand**

Same pattern as org tag — `product tag add`, `product tag remove`, `product tag list`. Use `addTagsToProduct`, `removeTagsFromProduct`, `getTagsForProduct`.

- [ ] **Step 5: Type-check and commit**

```bash
git add src/cli/commands/product.ts
git commit -m "feat: add category and tag support to product CLI commands"
```

---

### Task 10: CLI — categories command and list --category filter

**Files:**

- Modify: `src/cli/program.ts`
- Modify: `src/cli/commands/list.ts`

- [ ] **Step 1: Add categories command to program.ts**

After the existing imports, add:

```typescript
import { CATEGORIES } from "../lib/categories.js";
```

After the last `register*Command(program)` call, add:

```typescript
program
  .command("categories")
  .description("List valid category values")
  .option("--json", "Output as JSON")
  .action((opts: { json?: boolean }) => {
    if (opts.json) {
      console.log(JSON.stringify(CATEGORIES, null, 2));
    } else {
      for (const cat of CATEGORIES) {
        console.log(cat);
      }
    }
  });
```

- [ ] **Step 2: Update list command — add --category filter**

In `src/cli/commands/list.ts`, add the option:

```typescript
    .option("--category <category>", "Filter by organization or product category")
```

Pass it to `listSourcesWithOrg`:

```typescript
const allSources = await listSourcesWithOrg({
  orgSlug: opts.org,
  productSlug: opts.product,
  category: opts.category,
  hasFeed: opts.hasFeed,
  enrichable: opts.enrichable,
  query: opts.query,
  includeHidden: opts.includeHidden,
});
```

- [ ] **Step 3: Update program.ts help text**

Add `Categories` line:

```typescript
Categories: categories;
```

- [ ] **Step 4: Type-check and commit**

```bash
git add src/cli/program.ts src/cli/commands/list.ts
git commit -m "feat: add categories command and --category filter to list"
```

---

### Task 11: Import manifest — category and tags support

**Files:**

- Modify: `src/cli/commands/import.ts`

- [ ] **Step 1: Update manifest types**

Add to `ManifestOrg`:

```typescript
  category?: string;
  tags?: string[];
```

Add to `ManifestProduct`:

```typescript
  category?: string;
  tags?: string[];
```

- [ ] **Step 2: Add category validation in validateManifest**

After the existing org validation, add:

```typescript
if (org.category) {
  const { isValidCategory } = await import("../../lib/categories.js");
  if (!isValidCategory(org.category)) {
    throw new Error(`organizations[${i}].category "${org.category}" is not a valid category`);
  }
}
if (org.products) {
  for (const [k, prod] of org.products.entries()) {
    if (prod.category) {
      const { isValidCategory } = await import("../../lib/categories.js");
      if (!isValidCategory(prod.category)) {
        throw new Error(
          `organizations[${i}].products[${k}].category "${prod.category}" is not a valid category`,
        );
      }
    }
  }
}
```

Better: import `isValidCategory` at the top of the file and use it directly.

- [ ] **Step 3: Pass category on org creation**

In the real path (not dry-run), update the `createOrg` call:

```typescript
org = await createOrg(orgEntry.name, {
  slug: orgSlug,
  domain: orgEntry.domain,
  description: orgEntry.description,
  category: orgEntry.category,
});
```

After org creation, add tags:

```typescript
if (orgEntry.tags && orgEntry.tags.length > 0) {
  await addTagsToOrg(org.id, orgEntry.tags);
}
```

- [ ] **Step 4: Pass category on product creation**

Update the `createProduct` call:

```typescript
prod = await createProduct(org.id, prodEntry.name, {
  slug: prodSlug,
  url: prodEntry.url,
  description: prodEntry.description,
  category: prodEntry.category,
});
```

After product creation, add tags:

```typescript
if (prodEntry.tags && prodEntry.tags.length > 0) {
  await addTagsToProduct(prod.id, prodEntry.tags);
}
```

- [ ] **Step 5: Add imports**

Add `addTagsToOrg, addTagsToProduct` to the queries import.

Add `isValidCategory` import:

```typescript
import { isValidCategory } from "../../lib/categories.js";
```

- [ ] **Step 6: Type-check and commit**

```bash
git add src/cli/commands/import.ts
git commit -m "feat: add category and tag support to import manifests"
```

---

### Task 12: Agent prompt — inject categories and update system prompt

**Files:**

- Modify: `src/agent/released.ts`

- [ ] **Step 1: Import categories**

Add at the top:

```typescript
import { CATEGORIES } from "../lib/categories.js";
```

- [ ] **Step 2: Update system prompt**

In the `buildSystemPrompt()` function, add after the existing commands list:

```
- org tag add <slug> <tag1> [tag2...]: Add tags to an organization
- org tag remove <slug> <tag1> [tag2...]: Remove tags from an organization
- product add <name> --org <org> [--category <cat>] [--tags <t1,t2>] [--url <url>] [--description <text>]: Create a product
- product tag add <slug> <tag1> [tag2...]: Add tags to a product
- categories [--json]: List valid category values
```

Add a new section after the commands list:

```
## Categories

Valid categories for organizations and products: ${CATEGORIES.join(", ")}

When onboarding, assign a category to the organization and to each product if multiple products are detected. Use --category on org add and product add. Use org tag add / product tag add for freeform tags describing tech stack, ecosystem, or use case.

## Multi-Product Organizations

Some organizations ship multiple distinct products (e.g., Vercel ships Next.js, Turborepo, v0). When you discover sources that clearly belong to different products:

- **High confidence** (separate GitHub repos, separate domains, distinct names): Create products using \`product add\` and assign sources using \`edit <source-slug> --product <product-slug>\`
- **Medium confidence** (some signals but ambiguous): Note the suggested product groupings in the state file under \`suggestedProducts\` but don't auto-create
- **Low confidence** (unclear): Leave sources at the org level
```

- [ ] **Step 3: Update state file schema in prompt**

Update the JSON state file schema to include:

```
  "category": "<org category>",
  "tags": ["<tag1>", "<tag2>"],
```

On each source, add:

```
      "productSlug": "<product slug if assigned to auto-created product>"
```

Add a new field:

```
  "suggestedProducts": [
    {
      "name": "<product name>",
      "confidence": "medium",
      "reason": "<why this is suggested>",
      "suggestedSources": ["<slug1>", "<slug2>"],
      "suggestedCategory": "<category>",
      "suggestedTags": ["<tag1>"]
    }
  ]
```

- [ ] **Step 4: Type-check and commit**

```bash
git add src/agent/released.ts
git commit -m "feat: inject categories and product detection guidance into agent prompt"
```

---

### Task 13: Agent skill — light-touch finding-changelogs update

**Files:**

- Modify: `src/agent/skills/finding-changelogs/SKILL.md`

- [ ] **Step 1: Add products and tagging section**

At the end of the skill file, add:

```markdown
## Products, Categories, and Tags

Organizations can have multiple distinct products (e.g., Vercel → Next.js, Turborepo, v0). When discovering sources for an org, consider whether they belong to separate products.

Use the `product add`, `product tag add`, `org tag add`, and `categories` CLI commands to organize what you find. The full list of valid categories is provided in your system prompt.

Don't force product groupings when sources are ambiguous — leave them at the org level and note suggestions in the state file.
```

- [ ] **Step 2: Commit**

```bash
git add src/agent/skills/finding-changelogs/SKILL.md
git commit -m "feat: add product and tagging guidance to finding-changelogs skill"
```

---

### Task 14: Documentation updates

**Files:**

- Modify: `CLAUDE.md`
- Modify: `README.md`

- [ ] **Step 1: Update CLAUDE.md**

Add to the Conventions section:

```markdown
- Categories are validated against `CATEGORIES` in `src/lib/categories.ts`. Adding a new category requires a code change. Tags are freeform — get-or-create semantics via `tags` table.
- Tag join tables use separate `org_tags` and `product_tags` tables with proper FK cascades (not polymorphic).
```

Add to Common CLI Patterns:

```markdown
bun src/index.ts categories # List valid categories
bun src/index.ts categories --json # List as JSON
bun src/index.ts org add "Acme" --category cloud --tags typescript,edge
bun src/index.ts org tag add acme react serverless # Add tags to org
bun src/index.ts org tag list acme # List org tags
bun src/index.ts product add "CLI" --org acme --category developer-tools --tags golang
bun src/index.ts product tag add acme-cli testing # Add tags to product
bun src/index.ts list --category ai # Filter sources by category
```

- [ ] **Step 2: Update README.md**

Add a Categories & Tags section after the Products section with usage examples.

- [ ] **Step 3: Commit**

```bash
git add CLAUDE.md README.md
git commit -m "docs: add category and tag documentation"
```

---

### Task 15: Sources list route — category filter support

**Files:**

- Modify: `workers/api/src/routes/sources.ts`

- [ ] **Step 1: Add category query param support**

In the `GET /sources` handler, after the existing query filters, add:

```typescript
const categoryFilter = c.req.query("category");
```

If `categoryFilter` is set, add a condition that joins through orgs/products to filter by category:

```typescript
if (categoryFilter) {
  conditions.push(
    sql`(
        EXISTS (SELECT 1 FROM organizations o WHERE o.id = sources.org_id AND o.category = ${categoryFilter})
        OR EXISTS (SELECT 1 FROM products p WHERE p.id = sources.product_id AND p.category = ${categoryFilter})
      )`,
  );
}
```

- [ ] **Step 2: Commit**

```bash
git add workers/api/src/routes/sources.ts
git commit -m "feat: add category filter to sources API route"
```
