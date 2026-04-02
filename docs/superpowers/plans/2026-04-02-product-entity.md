# Product Entity Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a `products` table between organizations and sources so multi-product orgs (Vercel → Next.js, Turborepo) have proper grouping.

**Architecture:** New `products` table with `orgId` FK. Sources gain a nullable `productId` FK. All existing sources continue to work with `productId = NULL`. New CLI command `product` with subcommands for CRUD and adoption. New API routes for product management.

**Tech Stack:** Drizzle ORM, Hono API routes, Commander CLI, Bun SQLite (local), Cloudflare D1 (remote)

---

### Task 1: Schema and ID generator

**Files:**
- Modify: `src/lib/id.ts`
- Modify: `src/db/schema.ts`

- [ ] **Step 1: Add product ID generator**

In `src/lib/id.ts`, add:

```typescript
export const newProductId = () => `prod_${nanoid()}`;
```

- [ ] **Step 2: Add products table and update sources table in schema**

In `src/db/schema.ts`, add the `products` table after the `orgAccounts` table definition (before `sources`), and add `productId` to the `sources` table. Import `newProductId` in the existing import line.

Add this table:

```typescript
export const products = sqliteTable("products", {
  id: text("id").primaryKey().$defaultFn(newProductId),
  name: text("name").notNull(),
  slug: text("slug").notNull().unique(),
  orgId: text("org_id")
    .notNull()
    .references(() => organizations.id, { onDelete: "cascade" }),
  url: text("url"),
  description: text("description"),
  createdAt: text("created_at").notNull().$defaultFn(() => new Date().toISOString()),
}, (table) => [
  index("idx_products_org").on(table.orgId),
]);
```

Add to the `sources` table definition, after the `orgId` column:

```typescript
productId: text("product_id").references(() => products.id, { onDelete: "set null" }),
```

Add to the sources table indexes:

```typescript
index("idx_sources_product").on(table.productId),
```

Add type exports after the existing `NewOrgAccount` export:

```typescript
export type Product = typeof products.$inferSelect;
export type NewProduct = typeof products.$inferInsert;
```

- [ ] **Step 3: Run type check**

Run: `npx tsc --noEmit`
Expected: PASS (no type errors)

- [ ] **Step 4: Commit**

```bash
git add src/lib/id.ts src/db/schema.ts
git commit -m "feat: add products table and productId to sources schema"
```

---

### Task 2: D1 migration

**Files:**
- Create: `workers/api/migrations/0013_products.sql`

- [ ] **Step 1: Write the D1 migration**

Create `workers/api/migrations/0013_products.sql`:

```sql
-- Create products table
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

-- Add product_id to sources
ALTER TABLE sources ADD COLUMN product_id TEXT REFERENCES products(id) ON DELETE SET NULL;
CREATE INDEX idx_sources_product ON sources(product_id);
```

- [ ] **Step 2: Generate local Drizzle migration**

Run: `npx drizzle-kit generate`
Expected: A new migration file is created in `src/db/migrations/`

- [ ] **Step 3: Commit**

```bash
git add workers/api/migrations/0013_products.sql src/db/migrations/
git commit -m "feat: add D1 and local migrations for products table"
```

---

### Task 3: Query layer — product CRUD

**Files:**
- Modify: `src/db/queries.ts`

- [ ] **Step 1: Add product CRUD queries**

Add the `products` import to the schema import line at the top of `src/db/queries.ts`:

```typescript
import {
  sources, releases, organizations, orgAccounts, ignoredUrls, blockedUrls, fetchLog, usageLog, releaseSummaries, mediaAssets, products,
  type Source, type Release, type Organization, type OrgAccount, type IgnoredUrl, type BlockedUrl,
  type ReleaseSummary, type NewReleaseSummary, type MediaAsset, type Product,
} from "./schema.js";
```

Then add these functions after the org queries section (after `getOrgAccountsBySlug`):

```typescript
// ── Product queries ──

export async function createProduct(
  orgId: string,
  name: string,
  opts?: { slug?: string; url?: string; description?: string },
): Promise<Product> {
  if (isRemoteMode()) return apiClient.createProduct(orgId, name, opts);
  const db = getDb();
  const slug = opts?.slug ?? toSlug(name);
  const [created] = await db.insert(products).values({
    name,
    slug,
    orgId,
    url: opts?.url ?? null,
    description: opts?.description ?? null,
  }).returning();
  return created;
}

export async function findProduct(identifier: string): Promise<Product | null> {
  if (isRemoteMode()) return apiClient.findProduct(identifier);
  const db = getDb();
  // Try slug first, then ID
  const [bySlug] = await db.select().from(products).where(eq(products.slug, identifier));
  if (bySlug) return bySlug;
  if (identifier.startsWith("prod_")) {
    const [byId] = await db.select().from(products).where(eq(products.id, identifier));
    if (byId) return byId;
  }
  return null;
}

export async function getProductsByOrg(orgId: string): Promise<Array<Product & { sourceCount: number }>> {
  if (isRemoteMode()) return apiClient.getProductsByOrg(orgId);
  const db = getDb();
  const rows = await db
    .select({
      id: products.id,
      name: products.name,
      slug: products.slug,
      orgId: products.orgId,
      url: products.url,
      description: products.description,
      createdAt: products.createdAt,
      sourceCount: sql<number>`(SELECT COUNT(*) FROM sources WHERE sources.product_id = ${products.id})`,
    })
    .from(products)
    .where(eq(products.orgId, orgId))
    .orderBy(products.name);
  return rows;
}

export async function updateProduct(product: Product, data: Record<string, unknown>): Promise<Product> {
  if (isRemoteMode()) return apiClient.updateProduct(product.slug, data);
  const db = getDb();
  const [updated] = await db.update(products).set(data).where(eq(products.id, product.id)).returning();
  return updated;
}

export async function deleteProduct(productId: string): Promise<void> {
  if (isRemoteMode()) return apiClient.deleteProduct(productId);
  const db = getDb();
  await db.delete(products).where(eq(products.id, productId));
}
```

- [ ] **Step 2: Update createSource to accept productId**

In `src/db/queries.ts`, modify the `createSource` function's parameter type and insert logic:

Change the parameter type from:
```typescript
export async function createSource(data: {
  name: string;
  slug: string;
  type: string;
  url: string;
  orgId?: string | null;
  metadata?: string;
}): Promise<Source> {
```

To:
```typescript
export async function createSource(data: {
  name: string;
  slug: string;
  type: string;
  url: string;
  orgId?: string | null;
  productId?: string | null;
  metadata?: string;
}): Promise<Source> {
```

And in the insert values, add `productId`:

```typescript
  const [created] = await db.insert(sources).values({
    name: data.name,
    slug: data.slug,
    type: data.type as "github" | "scrape" | "feed" | "agent",
    url: data.url,
    orgId: data.orgId ?? null,
    productId: data.productId ?? null,
    metadata: data.metadata,
  }).returning();
```

- [ ] **Step 3: Update listSourcesWithOrg to include product info**

In `src/db/queries.ts`, update the `SourceWithOrg` interface to add product fields:

```typescript
export interface SourceWithOrg {
  id: string;
  name: string;
  slug: string;
  type: string;
  url: string;
  lastFetchedAt: string | null;
  orgName: string | null;
  productName: string | null;
  productSlug: string | null;
  metadata: string | null;
  isPrimary: boolean;
  isHidden?: boolean | null;
}
```

Update the `listSourcesWithOrg` function's select to include product fields and add a second left join:

```typescript
  const query = db
    .select({
      id: sources.id,
      name: sources.name,
      slug: sources.slug,
      type: sources.type,
      url: sources.url,
      lastFetchedAt: sources.lastFetchedAt,
      orgName: organizations.name,
      productName: products.name,
      productSlug: products.slug,
      metadata: sources.metadata,
      isPrimary: sql<boolean>`coalesce(${sources.isPrimary}, 0)`.as("isPrimary"),
      isHidden: sources.isHidden,
    })
    .from(sources)
    .leftJoin(organizations, eq(sources.orgId, organizations.id))
    .leftJoin(products, eq(sources.productId, products.id));
```

Add support for a `productSlug` filter in the opts and conditions:

```typescript
export async function listSourcesWithOrg(opts?: {
  orgSlug?: string;
  productSlug?: string;
  hasFeed?: boolean;
  enrichable?: boolean;
  query?: string;
  includeHidden?: boolean;
}): Promise<SourceWithOrg[]> {
```

And inside the conditions block, after the orgSlug condition:

```typescript
  if (opts?.productSlug) {
    const product = await findProduct(opts.productSlug);
    if (!product) return [];
    conditions.push(eq(sources.productId, product.id));
  }
```

- [ ] **Step 4: Run type check**

Run: `npx tsc --noEmit`
Expected: Type errors in `src/api/client.ts` (missing product functions) and possibly `src/cli/commands/list.ts` (new `productName`/`productSlug` fields). These will be fixed in subsequent tasks.

- [ ] **Step 5: Commit**

```bash
git add src/db/queries.ts
git commit -m "feat: add product CRUD queries and update source queries for product support"
```

---

### Task 4: API client — product functions for remote mode

**Files:**
- Modify: `src/api/client.ts`

- [ ] **Step 1: Add Product type import and product API functions**

Add `Product` to the type import at the top of `src/api/client.ts`:

```typescript
import type {
  Source, Release, Organization, OrgAccount, IgnoredUrl, BlockedUrl,
  ReleaseSummary, NewReleaseSummary, Product,
} from "../db/schema.js";
```

Add these functions after the org CRUD section:

```typescript
// ── Product queries ──

export async function createProduct(
  orgId: string,
  name: string,
  opts?: { slug?: string; url?: string; description?: string },
): Promise<Product> {
  return apiFetch<Product>(`/api/products`, {
    method: "POST",
    body: JSON.stringify({ orgId, name, slug: opts?.slug, url: opts?.url, description: opts?.description }),
  });
}

export async function findProduct(identifier: string): Promise<Product | null> {
  return apiFetch<Product | null>(`/api/products/${identifier}`);
}

export async function getProductsByOrg(orgId: string): Promise<Array<Product & { sourceCount: number }>> {
  return apiFetch<Array<Product & { sourceCount: number }>>(`/api/products?orgId=${orgId}`);
}

export async function updateProduct(slug: string, data: Record<string, unknown>): Promise<Product> {
  return apiFetch<Product>(`/api/products/${slug}`, {
    method: "PATCH",
    body: JSON.stringify(data),
  });
}

export async function deleteProduct(productId: string): Promise<void> {
  await apiFetch(`/api/products/${productId}`, { method: "DELETE" });
}
```

- [ ] **Step 2: Update SourceWithOrg to include product fields**

Update the `SourceWithOrg` interface in `src/api/client.ts`:

```typescript
export interface SourceWithOrg {
  id: string;
  name: string;
  slug: string;
  type: string;
  url: string;
  lastFetchedAt: string | null;
  orgName: string | null;
  productName: string | null;
  productSlug: string | null;
  metadata: string | null;
  isPrimary: boolean;
  isHidden?: boolean;
}
```

Update `listSourcesWithOrg` to accept `productSlug` and pass it to the API, and map the response to include the new fields:

In the opts type, add `productSlug?: string;`.

In the params block, add:
```typescript
  if (opts?.productSlug) params.set("productSlug", opts.productSlug);
```

In the mapping, add:
```typescript
    productName: (r as any).productName ?? null,
    productSlug: (r as any).productSlug ?? null,
```

- [ ] **Step 3: Update createSource to accept productId**

Update the `createSource` function in `src/api/client.ts`:

```typescript
export async function createSource(data: {
  name: string;
  slug: string;
  type: string;
  url: string;
  orgId?: string | null;
  productId?: string | null;
  metadata?: string;
}): Promise<Source> {
  return apiFetch<Source>("/api/sources", {
    method: "POST",
    body: JSON.stringify(data),
  });
}
```

- [ ] **Step 4: Run type check**

Run: `npx tsc --noEmit`
Expected: PASS (or remaining errors only in CLI commands, fixed in Task 6)

- [ ] **Step 5: Commit**

```bash
git add src/api/client.ts
git commit -m "feat: add product API client functions for remote mode"
```

---

### Task 5: API routes — product endpoints

**Files:**
- Create: `workers/api/src/routes/products.ts`
- Modify: `workers/api/src/index.ts`
- Modify: `workers/api/src/routes/stats.ts`
- Modify: `workers/api/src/routes/sources.ts` (lines 13-23 area)

- [ ] **Step 1: Create product routes file**

Create `workers/api/src/routes/products.ts`:

```typescript
import { Hono } from "hono";
import { eq, count, sql } from "drizzle-orm";
import { createDb } from "../db.js";
import { products, sources, organizations } from "../../../../src/db/schema.js";
import { toSlug } from "../../../../src/lib/slug.js";
import { isConflictError } from "../utils.js";
import type { Env } from "../index.js";

export const productRoutes = new Hono<Env>();

// List products, optionally filtered by orgId
productRoutes.get("/products", async (c) => {
  const db = createDb(c.env.DB);
  const orgId = c.req.query("orgId");

  const conditions = [];
  if (orgId) conditions.push(eq(products.orgId, orgId));

  const rows = await db
    .select({
      id: products.id,
      name: products.name,
      slug: products.slug,
      orgId: products.orgId,
      url: products.url,
      description: products.description,
      createdAt: products.createdAt,
      sourceCount: sql<number>`(SELECT COUNT(*) FROM sources WHERE sources.product_id = ${products.id})`,
    })
    .from(products)
    .where(conditions.length > 0 ? conditions[0] : undefined)
    .orderBy(products.name);

  return c.json(rows);
});

// Get product by slug or ID
productRoutes.get("/products/:identifier", async (c) => {
  const db = createDb(c.env.DB);
  const identifier = c.req.param("identifier");

  const [product] = await db.select().from(products).where(
    identifier.startsWith("prod_") ? eq(products.id, identifier) : eq(products.slug, identifier),
  );

  if (!product) return c.json({ error: "not_found", message: "Product not found" }, 404);

  const productSources = await db
    .select({ id: sources.id, slug: sources.slug, name: sources.name, type: sources.type, url: sources.url })
    .from(sources)
    .where(eq(sources.productId, product.id))
    .orderBy(sources.name);

  return c.json({ ...product, sources: productSources });
});

// Create product
productRoutes.post("/products", async (c) => {
  const db = createDb(c.env.DB);
  const body = await c.req.json<{ orgId: string; name: string; slug?: string; url?: string; description?: string }>();

  if (!body.orgId || !body.name) {
    return c.json({ error: "bad_request", message: "Missing required fields: orgId, name" }, 400);
  }

  // Verify org exists
  const [org] = await db.select().from(organizations).where(eq(organizations.id, body.orgId));
  if (!org) return c.json({ error: "not_found", message: "Organization not found" }, 404);

  const slug = body.slug ?? toSlug(body.name);

  try {
    const [created] = await db
      .insert(products)
      .values({
        name: body.name,
        slug,
        orgId: body.orgId,
        url: body.url ?? null,
        description: body.description ?? null,
      })
      .returning();
    return c.json(created, 201);
  } catch (err) {
    if (isConflictError(err)) {
      return c.json({ error: "conflict", message: `Product with slug "${slug}" already exists` }, 409);
    }
    throw err;
  }
});

// Update product
productRoutes.patch("/products/:slug", async (c) => {
  const db = createDb(c.env.DB);
  const slug = c.req.param("slug");
  const body = await c.req.json<{ name?: string; url?: string | null; description?: string | null }>();

  const [product] = await db.select().from(products).where(eq(products.slug, slug));
  if (!product) return c.json({ error: "not_found", message: "Product not found" }, 404);

  const updates: Record<string, string | null> = {};
  if (body.name) updates.name = body.name;
  if (body.url !== undefined) updates.url = body.url;
  if (body.description !== undefined) updates.description = body.description;

  if (Object.keys(updates).length === 0) {
    return c.json(product);
  }

  const [updated] = await db.update(products).set(updates).where(eq(products.id, product.id)).returning();
  return c.json(updated);
});

// Delete product
productRoutes.delete("/products/:identifier", async (c) => {
  const db = createDb(c.env.DB);
  const identifier = c.req.param("identifier");

  const [product] = await db.select().from(products).where(
    identifier.startsWith("prod_") ? eq(products.id, identifier) : eq(products.slug, identifier),
  );
  if (!product) return c.json({ error: "not_found", message: "Product not found" }, 404);

  await db.delete(products).where(eq(products.id, product.id));
  return c.json({ deleted: true });
});

// Adopt: migrate an org into a product under another org
productRoutes.post("/products/adopt", async (c) => {
  const db = createDb(c.env.DB);
  const body = await c.req.json<{
    sourceOrgSlug: string;
    targetOrgSlug: string;
    slug?: string;
    url?: string;
    dryRun?: boolean;
  }>();

  if (!body.sourceOrgSlug || !body.targetOrgSlug) {
    return c.json({ error: "bad_request", message: "Missing required fields: sourceOrgSlug, targetOrgSlug" }, 400);
  }

  // Resolve both orgs
  const [sourceOrg] = await db.select().from(organizations).where(eq(organizations.slug, body.sourceOrgSlug));
  if (!sourceOrg) return c.json({ error: "not_found", message: `Source org not found: ${body.sourceOrgSlug}` }, 404);

  const [targetOrg] = await db.select().from(organizations).where(eq(organizations.slug, body.targetOrgSlug));
  if (!targetOrg) return c.json({ error: "not_found", message: `Target org not found: ${body.targetOrgSlug}` }, 404);

  // Gather sources to move
  const sourcesToMove = await db.select().from(sources).where(eq(sources.orgId, sourceOrg.id));

  const productSlug = body.slug ?? sourceOrg.slug;
  const productUrl = body.url ?? (sourceOrg.domain ? `https://${sourceOrg.domain}` : null);

  if (body.dryRun) {
    return c.json({
      dryRun: true,
      product: { name: sourceOrg.name, slug: productSlug, url: productUrl, orgSlug: targetOrg.slug },
      sourcesToMove: sourcesToMove.map((s) => s.slug),
      sourceOrgToDelete: sourceOrg.slug,
    });
  }

  // Create product under target org
  const [product] = await db.insert(products).values({
    name: sourceOrg.name,
    slug: productSlug,
    orgId: targetOrg.id,
    url: productUrl,
    description: sourceOrg.description,
  }).returning();

  // Move sources: update orgId to target, set productId
  if (sourcesToMove.length > 0) {
    await db.update(sources)
      .set({ orgId: targetOrg.id, productId: product.id })
      .where(eq(sources.orgId, sourceOrg.id));
  }

  // Delete source org (cascade deletes its org_accounts)
  await db.delete(organizations).where(eq(organizations.id, sourceOrg.id));

  return c.json({
    product,
    sourcesMoved: sourcesToMove.length,
    sourceOrgDeleted: sourceOrg.slug,
  });
});
```

- [ ] **Step 2: Register product routes in API index**

In `workers/api/src/index.ts`, add the import:

```typescript
import { productRoutes } from "./routes/products.js";
```

Add cache-control middleware (after the existing orgs cache lines):

```typescript
app.use("/api/products", cacheControl(60, { staleWhileRevalidate: 30 }));
app.use("/api/products/:slug", cacheControl(60, { staleWhileRevalidate: 30 }));
```

Register the route (after `orgRoutes`):

```typescript
app.route("/api", productRoutes);
```

- [ ] **Step 3: Update stats route to include product count**

In `workers/api/src/routes/stats.ts`, add `products` to the import:

```typescript
import { organizations, sources, releases, products } from "../../../../src/db/schema.js";
```

Add the product count query and include it in the response:

```typescript
statsRoutes.get("/stats", async (c) => {
  const db = createDb(c.env.DB);
  const [orgCount] = await db.select({ n: count() }).from(organizations);
  const [sourceCount] = await db.select({ n: count() }).from(sources);
  const [releaseCount] = await db.select({ n: count() }).from(releases);
  const [productCount] = await db.select({ n: count() }).from(products);
  return c.json({ orgs: orgCount.n, sources: sourceCount.n, releases: releaseCount.n, products: productCount.n });
});
```

- [ ] **Step 4: Update sources route to accept productSlug filter**

In `workers/api/src/routes/sources.ts`, add `products` to the schema import:

```typescript
import { sources, releases, organizations, fetchLog, releaseSummaries, products } from "../../../../src/db/schema.js";
```

In the `GET /sources` handler, after the `orgSlug` block (~line 46-49), add `productSlug` resolution:

```typescript
  const productSlug = c.req.query("productSlug");
  if (productSlug) {
    const [product] = await db.select().from(products).where(eq(products.slug, productSlug));
    if (!product) return c.json([]);
    conditions.push(eq(sources.productId, product.id));
  }
```

Also add `eq` import — it's already imported on line 2.

- [ ] **Step 5: Run type check**

Run: `npx tsc --noEmit`
Expected: PASS (or only remaining CLI errors)

- [ ] **Step 6: Commit**

```bash
git add workers/api/src/routes/products.ts workers/api/src/index.ts workers/api/src/routes/stats.ts workers/api/src/routes/sources.ts
git commit -m "feat: add product API routes and update stats/sources endpoints"
```

---

### Task 6: CLI — product command

**Files:**
- Create: `src/cli/commands/product.ts`
- Modify: `src/cli/program.ts`

- [ ] **Step 1: Create the product CLI command**

Create `src/cli/commands/product.ts`:

```typescript
import { Command } from "commander";
import chalk from "chalk";
import Table from "cli-table3";
import {
  findOrg, findProduct, getProductsByOrg, createProduct, updateProduct, deleteProduct,
  getSourcesByOrg, getOrgAccountsBySlug, updateSource, removeOrg,
} from "../../db/queries.js";
import { toSlug } from "../../lib/slug.js";
import { logger } from "../../lib/logger.js";

export function registerProductCommand(program: Command) {
  const product = program
    .command("product")
    .description("Manage products within organizations");

  // ── product list ──
  product
    .command("list")
    .description("List products, optionally filtered by organization")
    .argument("[org-slug]", "Filter by organization slug")
    .option("--json", "Output as JSON")
    .addHelpText("after", `
Examples:
  released product list
  released product list vercel
  released product list --json`)
    .action(async (orgSlug: string | undefined, opts: { json?: boolean }) => {
      if (orgSlug) {
        const org = await findOrg(orgSlug);
        if (!org) {
          console.error(chalk.red(`Organization not found: ${orgSlug}`));
          process.exit(1);
        }

        const prods = await getProductsByOrg(org.id);

        if (prods.length === 0) {
          if (opts.json) {
            console.log(JSON.stringify([], null, 2));
          } else {
            console.log(chalk.yellow(`No products found for ${org.name}.`));
          }
          return;
        }

        if (opts.json) {
          console.log(JSON.stringify(prods, null, 2));
          return;
        }

        const table = new Table({
          head: [
            chalk.cyan("Name"),
            chalk.cyan("Slug"),
            chalk.cyan("URL"),
            chalk.cyan("Sources"),
          ],
        });

        for (const p of prods) {
          table.push([
            p.name,
            p.slug,
            p.url ?? chalk.dim("—"),
            String(p.sourceCount),
          ]);
        }

        console.log(chalk.bold(`Products for ${org.name}:`));
        console.log(table.toString());
        return;
      }

      // No org filter — this would need a listAllProducts query.
      // For now, inform the user to specify an org.
      console.log(chalk.yellow("Specify an organization slug to list its products."));
      console.log(chalk.dim("  released product list <org-slug>"));
    });

  // ── product add ──
  product
    .command("add")
    .description("Add a new product to an organization")
    .argument("<name>", "Product name")
    .requiredOption("--org <org>", "Organization slug")
    .option("--slug <slug>", "Custom slug (auto-derived from name if omitted)")
    .option("--url <url>", "Canonical product URL (e.g., https://nextjs.org)")
    .option("--description <text>", "Brief product description")
    .option("--json", "Output as JSON")
    .addHelpText("after", `
Examples:
  released product add "Next.js" --org vercel --url https://nextjs.org
  released product add "Turborepo" --org vercel --slug turborepo
  released product add "AI SDK" --org vercel --description "TypeScript toolkit for AI apps" --json`)
    .action(async (name: string, opts: { org: string; slug?: string; url?: string; description?: string; json?: boolean }) => {
      const org = await findOrg(opts.org);
      if (!org) {
        console.error(chalk.red(`Organization not found: ${opts.org}`));
        process.exit(1);
      }

      const slug = opts.slug ?? toSlug(name);
      const existing = await findProduct(slug);
      if (existing) {
        console.error(chalk.red(`Product with slug "${slug}" already exists.`));
        process.exit(1);
      }

      const created = await createProduct(org.id, name, {
        slug,
        url: opts.url,
        description: opts.description,
      });

      if (opts.json) {
        console.log(JSON.stringify(created, null, 2));
      } else {
        console.log(chalk.green(`Product added: ${name} (${slug}) under ${org.name}`));
      }
    });

  // ── product edit ──
  product
    .command("edit")
    .description("Edit a product")
    .argument("<slug>", "Product slug")
    .option("--name <name>", "Update product name")
    .option("--url <url>", "Update canonical URL")
    .option("--description <text>", "Update description")
    .option("--json", "Output as JSON")
    .addHelpText("after", `
Examples:
  released product edit nextjs --url https://nextjs.org
  released product edit nextjs --name "Next.js" --json`)
    .action(async (slug: string, opts: { name?: string; url?: string; description?: string; json?: boolean }) => {
      const prod = await findProduct(slug);
      if (!prod) {
        console.error(chalk.red(`Product not found: ${slug}`));
        process.exit(1);
      }

      const updates: Record<string, unknown> = {};
      const changes: string[] = [];

      if (opts.name) { updates.name = opts.name; changes.push(`name → ${opts.name}`); }
      if (opts.url !== undefined) { updates.url = opts.url; changes.push(`url → ${opts.url}`); }
      if (opts.description !== undefined) { updates.description = opts.description; changes.push(`description updated`); }

      if (changes.length === 0) {
        console.log(chalk.yellow("No changes specified. Use --help to see options."));
        return;
      }

      const updated = await updateProduct(prod, updates);

      if (opts.json) {
        console.log(JSON.stringify(updated, null, 2));
      } else {
        console.log(chalk.green(`Updated product ${prod.name} (${slug}):`));
        for (const change of changes) {
          console.log(`  ${change}`);
        }
      }
    });

  // ── product remove ──
  product
    .command("remove")
    .description("Remove a product (sources become unlinked, not deleted)")
    .argument("<slug>", "Product slug")
    .option("--dry-run", "Show what would be removed without deleting")
    .option("--json", "Output as JSON")
    .addHelpText("after", `
Examples:
  released product remove nextjs
  released product remove nextjs --dry-run`)
    .action(async (slug: string, opts: { dryRun?: boolean; json?: boolean }) => {
      const prod = await findProduct(slug);
      if (!prod) {
        console.error(chalk.red(`Product not found: ${slug}`));
        process.exit(1);
      }

      if (opts.dryRun) {
        if (opts.json) {
          console.log(JSON.stringify({ wouldRemove: prod.slug, name: prod.name }, null, 2));
        } else {
          console.log(chalk.yellow(`[dry-run] Would remove product: ${prod.name} (${prod.slug})`));
          console.log(chalk.dim("  Sources linked to this product would have their product association cleared."));
        }
        return;
      }

      await deleteProduct(prod.id);

      if (opts.json) {
        console.log(JSON.stringify({ removed: prod.slug }, null, 2));
      } else {
        console.log(chalk.green(`Removed product: ${prod.name} (${prod.slug})`));
      }
    });

  // ── product adopt ──
  product
    .command("adopt")
    .description("Migrate an org into a product under another org")
    .argument("<source-org-slug>", "Org to convert into a product")
    .requiredOption("--into <target-org-slug>", "Target parent organization")
    .option("--slug <slug>", "Override product slug (defaults to source org slug)")
    .option("--url <url>", "Override product URL (defaults to source org domain)")
    .option("--dry-run", "Show what would happen without making changes")
    .option("--json", "Output as JSON")
    .addHelpText("after", `
Examples:
  released product adopt nextjs --into vercel
  released product adopt nextjs --into vercel --dry-run
  released product adopt nextjs --into vercel --url https://nextjs.org --json`)
    .action(async (sourceOrgSlug: string, opts: { into: string; slug?: string; url?: string; dryRun?: boolean; json?: boolean }) => {
      const sourceOrg = await findOrg(sourceOrgSlug);
      if (!sourceOrg) {
        console.error(chalk.red(`Source organization not found: ${sourceOrgSlug}`));
        process.exit(1);
      }

      const targetOrg = await findOrg(opts.into);
      if (!targetOrg) {
        console.error(chalk.red(`Target organization not found: ${opts.into}`));
        process.exit(1);
      }

      if (sourceOrg.id === targetOrg.id) {
        console.error(chalk.red("Source and target organizations cannot be the same."));
        process.exit(1);
      }

      const sourcesToMove = await getSourcesByOrg(sourceOrg.id);
      const productSlug = opts.slug ?? sourceOrg.slug;
      const productUrl = opts.url ?? (sourceOrg.domain ? `https://${sourceOrg.domain}` : null);

      if (opts.dryRun) {
        const summary = {
          product: { name: sourceOrg.name, slug: productSlug, url: productUrl, parentOrg: targetOrg.slug },
          sourcesToMove: sourcesToMove.map((s) => s.slug),
          sourceOrgToDelete: sourceOrg.slug,
        };

        if (opts.json) {
          console.log(JSON.stringify({ dryRun: true, ...summary }, null, 2));
        } else {
          console.log(chalk.bold(`[dry-run] Would adopt "${sourceOrg.name}" as a product under "${targetOrg.name}":`));
          console.log(`  Product: ${summary.product.name} (${summary.product.slug})`);
          if (summary.product.url) console.log(`  URL: ${summary.product.url}`);
          console.log(`  Sources to move: ${summary.sourcesToMove.length}`);
          for (const s of summary.sourcesToMove) {
            console.log(`    ${chalk.dim("→")} ${s}`);
          }
          console.log(`  Would delete org: ${sourceOrg.name} (${sourceOrg.slug})`);
        }
        return;
      }

      // Create product
      const created = await createProduct(targetOrg.id, sourceOrg.name, {
        slug: productSlug,
        url: productUrl,
        description: sourceOrg.description ?? undefined,
      });

      // Move sources — update orgId and productId
      let moved = 0;
      for (const src of sourcesToMove) {
        await updateSource(src, { orgId: targetOrg.id, productId: created.id });
        moved++;
      }

      // Delete the now-empty source org
      await removeOrg(sourceOrg.id, sourceOrg.slug);

      if (opts.json) {
        console.log(JSON.stringify({
          product: created,
          sourcesMoved: moved,
          sourceOrgDeleted: sourceOrg.slug,
        }, null, 2));
      } else {
        console.log(chalk.green(`Adopted "${sourceOrg.name}" as product under "${targetOrg.name}"`));
        console.log(`  Product: ${created.name} (${created.slug})`);
        if (created.url) console.log(`  URL: ${created.url}`);
        console.log(`  Sources moved: ${moved}`);
        console.log(`  Deleted org: ${sourceOrg.slug}`);
      }
    });
}
```

- [ ] **Step 2: Register product command in program.ts**

In `src/cli/program.ts`, add the import:

```typescript
import { registerProductCommand } from "./commands/product.js";
```

Add the registration call (after `registerOrgCommand`):

```typescript
registerProductCommand(program);
```

Update the help text to include Products:

Change:
```
  Organizations: org (add, list, show, remove, link, unlink)
```
To:
```
  Organizations: org (add, list, show, remove, link, unlink)
  Products:      product (list, add, edit, remove, adopt)
```

- [ ] **Step 3: Run type check**

Run: `npx tsc --noEmit`
Expected: PASS

- [ ] **Step 4: Commit**

```bash
git add src/cli/commands/product.ts src/cli/program.ts
git commit -m "feat: add product CLI command with list, add, edit, remove, adopt subcommands"
```

---

### Task 7: CLI updates — add --product to existing commands

**Files:**
- Modify: `src/cli/commands/add.ts`
- Modify: `src/cli/commands/edit.ts`
- Modify: `src/cli/commands/list.ts`

- [ ] **Step 1: Add --product flag to add command**

In `src/cli/commands/add.ts`, add `findProduct` to the import from queries:

```typescript
import { findOrg, createOrg, createSource, isUrlExcluded, findProduct } from "../../db/queries.js";
```

Add `product` field to the `AddSourceInput` interface:

```typescript
interface AddSourceInput {
  name: string;
  url: string;
  type?: string;
  slug?: string;
  org?: string;
  product?: string;
  feedUrl?: string;
  skipEval?: boolean;
  batch?: boolean;
}
```

In `addSingleSource`, after the org resolution block (around line 68, after `orgName = org.name;`), add product resolution:

```typescript
  let productId: string | null = null;
  if (input.product) {
    const prod = await findProduct(input.product);
    if (!prod) {
      return { name, slug: input.slug ?? toSlug(name), type: "scrape", url, status: "error", error: `Product not found: "${input.product}"` };
    }
    productId = prod.id;
    // If product has an org and no org was specified, inherit it
    if (!orgId) {
      orgId = prod.orgId;
    }
  }
```

In the `createSource` call (around line 139), add `productId`:

```typescript
    await createSource({
      name,
      slug,
      type: sourceType,
      url,
      orgId,
      productId,
      metadata: Object.keys(metadata).length > 0 ? JSON.stringify(metadata) : undefined,
    });
```

In `registerAddCommand`, add the option (after `--org`):

```typescript
    .option("--product <product>", "Product slug to assign this source to")
```

Pass it through in both single-add and batch paths. In the single-add action (around line 255):

```typescript
      const result = await addSingleSource({
        name: effectiveName,
        url: opts.url,
        type: opts.type,
        slug: opts.slug,
        org: opts.org,
        product: opts.product,
        feedUrl: opts.feedUrl,
        skipEval: opts.skipEval,
      });
```

Also update the opts type in the action to include `product?: string`.

- [ ] **Step 2: Add --product flag to edit command**

In `src/cli/commands/edit.ts`, add `findProduct` to the import:

```typescript
import { findSourceBySlug, findOrg, createOrg, updateSource, findProduct } from "../../db/queries.js";
```

Add the option (after `--no-org`):

```typescript
    .option("--product <product>", "Set product (slug)")
    .option("--no-product", "Remove product association")
```

In the action, add `product` to the opts type: `product?: string | boolean;`

Add this handling block after the `--org / --no-org` block (around line 109):

```typescript
      // Handle --product / --no-product
      if (opts.product === false) {
        updates.productId = null;
        changes.push("product removed");
      } else if (typeof opts.product === "string") {
        const prod = await findProduct(opts.product);
        if (!prod) {
          console.error(chalk.red(`Product not found: ${opts.product}`));
          process.exit(1);
        }
        updates.productId = prod.id;
        changes.push(`product → ${prod.name}`);
      }
```

- [ ] **Step 3: Add --product filter to list command and show product column**

In `src/cli/commands/list.ts`, add the option (after `--org`):

```typescript
    .option("--product <product>", "Filter by product slug")
```

Update the opts type to include `product?: string`.

Pass it through to `listSourcesWithOrg`:

```typescript
      const allSources = await listSourcesWithOrg({
        orgSlug: opts.org,
        productSlug: opts.product,
        hasFeed: opts.hasFeed,
        enrichable: opts.enrichable,
        query: opts.query,
        includeHidden: opts.includeHidden,
      });
```

Update the table header to include Product (add after "Org"):

```typescript
      const table = new Table({
        head: ["Name", "Slug", "Type", "Method", "URL", "Org", "Product", "Last Fetched"],
      });
```

Update the table row push to include the product name:

```typescript
      for (const row of allSources) {
        const method = getFetchMethod(row.type, row.metadata);
        table.push([
          row.isPrimary ? `${row.name} ${chalk.yellow("\u2605")}` : row.name,
          row.slug,
          row.type,
          method,
          row.url,
          row.orgName ?? chalk.dim("\u2014"),
          row.productName ?? chalk.dim("\u2014"),
          row.lastFetchedAt ?? chalk.dim("never"),
        ]);
      }
```

- [ ] **Step 4: Run type check**

Run: `npx tsc --noEmit`
Expected: PASS

- [ ] **Step 5: Smoke test CLI**

Run: `bun src/index.ts product --help`
Expected: Shows product subcommands (list, add, edit, remove, adopt)

Run: `bun src/index.ts add --help`
Expected: Shows `--product` option

Run: `bun src/index.ts list --help`
Expected: Shows `--product` option

- [ ] **Step 6: Commit**

```bash
git add src/cli/commands/add.ts src/cli/commands/edit.ts src/cli/commands/list.ts
git commit -m "feat: add --product flag to add, edit, and list commands"
```

---

### Task 8: Update import command to support products in manifest

**Files:**
- Modify: `src/cli/commands/import.ts`

- [ ] **Step 1: Add product types and processing to import command**

In `src/cli/commands/import.ts`, add `findProduct, createProduct` to the imports:

```typescript
import {
  findOrg,
  createOrg,
  findSourcesByUrls,
  getOrgAccountByPlatform,
  linkOrgAccount,
  createSource,
  findProduct,
  createProduct,
} from "../../db/queries.js";
```

Add the manifest product interface (after `ManifestSource`):

```typescript
interface ManifestProduct {
  name: string;
  slug?: string;
  url?: string;
  description?: string;
  sources?: ManifestSource[];
}
```

Update `ManifestOrg` to include products:

```typescript
interface ManifestOrg {
  name: string;
  slug?: string;
  domain?: string;
  description?: string;
  accounts?: ManifestAccount[];
  products?: ManifestProduct[];
  sources?: ManifestSource[];
}
```

Update `ImportReport.created` to include products:

```typescript
interface ImportReport {
  created: { orgs: number; accounts: number; sources: number; products: number };
  skipped: number;
  errors: string[];
}
```

Initialize `products: 0` in the report creation.

In `validateManifest`, add validation for products (after the accounts validation, around line 93):

```typescript
      if (org.products) {
        for (const [k, prod] of org.products.entries()) {
          if (!prod.name) {
            throw new Error(`organizations[${i}].products[${k}] is missing required 'name' field`);
          }
          if (prod.sources) {
            for (const [j, src] of prod.sources.entries()) {
              if (!src.name || !src.url) {
                throw new Error(`organizations[${i}].products[${k}].sources[${j}] is missing required 'name' or 'url' field`);
              }
            }
          }
        }
      }
```

In `collectAllUrls`, add product source URLs (after org sources):

```typescript
      if (org.products) {
        for (const prod of org.products) {
          if (prod.sources) {
            for (const src of prod.sources) {
              urls.push(src.url);
            }
          }
        }
      }
```

In the org processing loop (after accounts handling, before org sources), add product processing. This goes after the accounts block and before the `if (orgEntry.sources)` block. For both dry-run and real modes:

**Dry-run product handling** (inside the `if (opts.dryRun)` block, after accounts):

```typescript
            // Products
            if (orgEntry.products) {
              for (const prodEntry of orgEntry.products) {
                report.created.products++;
                if (!opts.json) {
                  logger.info(chalk.green(`[dry-run] Would create product: ${prodEntry.name} -> ${orgSlug}`));
                }
                if (prodEntry.sources) {
                  for (const srcEntry of prodEntry.sources) {
                    if (existingUrlSet.has(srcEntry.url)) {
                      report.skipped++;
                      if (!opts.json) {
                        logger.info(chalk.yellow(`[dry-run] Source URL already exists, would skip: ${srcEntry.url}`));
                      }
                    } else {
                      report.created.sources++;
                      const srcType = resolveSourceType(srcEntry);
                      if (!opts.json) {
                        logger.info(chalk.green(`[dry-run] Would create source: ${srcEntry.name} [${srcType}] -> ${prodEntry.name}`));
                      }
                    }
                  }
                }
              }
            }
```

**Real product handling** (in the non-dry-run path, after accounts, before org sources):

```typescript
          // Create products and their sources
          if (orgEntry.products) {
            for (const prodEntry of orgEntry.products) {
              const prodSlug = prodEntry.slug ?? toSlug(prodEntry.name);
              let prod = await findProduct(prodSlug);

              if (prod) {
                if (!opts.json) {
                  logger.info(chalk.yellow(`Product already exists: ${prod.name} (${prod.slug})`));
                }
              } else {
                try {
                  prod = await createProduct(org.id, prodEntry.name, {
                    slug: prodSlug,
                    url: prodEntry.url,
                    description: prodEntry.description,
                  });
                  report.created.products++;
                  if (!opts.json) {
                    logger.info(chalk.green(`Created product: ${prod.name} (${prod.slug}) -> ${org.slug}`));
                  }
                } catch (err) {
                  const msg = `Failed to create product "${prodEntry.name}": ${err instanceof Error ? err.message : String(err)}`;
                  report.errors.push(msg);
                  if (!opts.json) {
                    logger.error(chalk.red(msg));
                  }
                  continue;
                }
              }

              // Insert product sources
              if (prodEntry.sources) {
                for (const srcEntry of prodEntry.sources) {
                  if (existingUrlSet.has(srcEntry.url)) {
                    report.skipped++;
                    if (opts.skipExisting) {
                      if (!opts.json) {
                        logger.info(chalk.yellow(`Skipped existing source: ${srcEntry.url}`));
                      }
                    } else {
                      const msg = `Source URL already exists: ${srcEntry.url}`;
                      report.errors.push(msg);
                      if (!opts.json) {
                        logger.error(chalk.red(msg));
                      }
                    }
                    continue;
                  }

                  const srcSlug = srcEntry.slug ?? toSlug(srcEntry.name);
                  const srcType = resolveSourceType(srcEntry);

                  try {
                    await createSource({
                      name: srcEntry.name,
                      slug: srcSlug,
                      type: srcType,
                      url: srcEntry.url,
                      orgId: org.id,
                      productId: prod.id,
                    });
                    report.created.sources++;
                    if (!opts.json) {
                      logger.info(chalk.green(`Created source: ${srcEntry.name} (${srcSlug}) [${srcType}] -> ${prod.slug}`));
                    }
                  } catch (err) {
                    const msg = `Failed to create source "${srcEntry.name}": ${err instanceof Error ? err.message : String(err)}`;
                    report.errors.push(msg);
                    if (!opts.json) {
                      logger.error(chalk.red(msg));
                    }
                  }
                }
              }
            }
          }
```

Update the summary output to include products:

```typescript
        console.log(`  Products created:      ${report.created.products}`);
```

- [ ] **Step 2: Run type check**

Run: `npx tsc --noEmit`
Expected: PASS

- [ ] **Step 3: Commit**

```bash
git add src/cli/commands/import.ts
git commit -m "feat: add product support to import manifest"
```

---

### Task 9: Update org show to display products

**Files:**
- Modify: `src/cli/commands/org.ts`

- [ ] **Step 1: Update org show to include products**

In `src/cli/commands/org.ts`, add `getProductsByOrg` to the import:

```typescript
import {
  findOrg, getSourcesByOrg, listOrgs, createOrg, removeOrg,
  getOrgAccountsBySlug, linkOrgAccount, unlinkOrgAccount,
  getProductsByOrg,
} from "../../db/queries.js";
```

In the `org show` action (around line 117), after fetching accounts and sources, fetch products:

```typescript
      const orgProducts = await getProductsByOrg(found.id);
```

In the JSON output, include products:

```typescript
        console.log(JSON.stringify({ ...found, accounts, products: orgProducts, sources: linkedSources }, null, 2));
```

In the text output, after the accounts block and before the sources block, add:

```typescript
      if (orgProducts.length > 0) {
        console.log();
        console.log(chalk.bold("Products:"));
        for (const p of orgProducts) {
          const urlLabel = p.url ? chalk.dim(` ${p.url}`) : "";
          console.log(`  ${chalk.cyan(p.slug)}  ${p.name}  (${p.sourceCount} sources)${urlLabel}`);
        }
      }
```

- [ ] **Step 2: Run type check**

Run: `npx tsc --noEmit`
Expected: PASS

- [ ] **Step 3: Smoke test**

Run: `bun src/index.ts org show --help`
Expected: Help output (no errors)

- [ ] **Step 4: Commit**

```bash
git add src/cli/commands/org.ts
git commit -m "feat: display products in org show output"
```

---

### Task 10: Update org detail API to include products

**Files:**
- Modify: `workers/api/src/routes/orgs.ts`

- [ ] **Step 1: Add products to org detail response**

In `workers/api/src/routes/orgs.ts`, add `products` to the schema import:

```typescript
import { organizations, orgAccounts, sources, releases, products } from "../../../../src/db/schema.js";
```

In the `GET /orgs/:slug` handler, after fetching `sourceRows` (around line 87), add a products query:

```typescript
  const productRows = await db
    .select({
      id: products.id,
      slug: products.slug,
      name: products.name,
      url: products.url,
      description: products.description,
      sourceCount: sql<number>`(SELECT COUNT(*) FROM sources WHERE sources.product_id = ${products.id})`,
    })
    .from(products)
    .where(eq(products.orgId, org.id))
    .orderBy(products.name);
```

Include it in the response JSON (add after `accounts`, before `sources`):

```typescript
    products: productRows,
```

- [ ] **Step 2: Run type check**

Run: `npx tsc --noEmit`
Expected: PASS

- [ ] **Step 3: Commit**

```bash
git add workers/api/src/routes/orgs.ts
git commit -m "feat: include products in org detail API response"
```

---

### Task 11: Final type check and smoke test

**Files:** None (verification only)

- [ ] **Step 1: Full type check**

Run: `npx tsc --noEmit`
Expected: PASS — zero errors

- [ ] **Step 2: Smoke test product commands**

Run: `bun src/index.ts product --help`
Expected: Shows list, add, edit, remove, adopt subcommands

Run: `bun src/index.ts product add --help`
Expected: Shows --org, --slug, --url, --description, --json options

Run: `bun src/index.ts product adopt --help`
Expected: Shows --into, --slug, --url, --dry-run, --json options

- [ ] **Step 3: Smoke test list with product column**

Run: `bun src/index.ts list --help`
Expected: Shows --product option

- [ ] **Step 4: Commit (if any fixups needed)**

Only if previous steps revealed issues that required fixes.
