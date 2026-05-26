# Product Pages as the Default Unit — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Promote product pages from thin source-directory stubs to the primary, aggregated, SEO-facing feed unit (releasebot-style), gated at 2+ products with a migration-free collapse for simpler orgs.

**Architecture:** Additive only. A `?product=` filter on the existing org release feed powers a product-scoped feed (the query already `LEFT JOIN`s products). The org-detail response gains a per-product `releaseCount` for hub cards. The web product page is rewritten to render that feed; the org Overview page gains a product card grid; single-product orgs 301 to the org page. No schema/DB migration.

**Tech Stack:** Bun, TypeScript (strict), Cloudflare Worker + Hono + Drizzle (D1), Zod (`@buildinternet/releases-api-types`), Next.js (App Router) web frontend.

**Spec:** `docs/superpowers/specs/2026-05-26-product-pages-default-unit-design.md`

---

## Setup (run once before Task 1)

This worktree has no `node_modules`, and the plan edits a workspace package (`packages/api-types`). Install first so tsc/tests resolve the in-tree change.

- [ ] **Step 0: Install deps in the worktree**

Run: `bun install`
Expected: completes; `node_modules/` now present at the worktree root.

---

## File structure

| File                                                        | Responsibility                                                                                                              | Action |
| ----------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------- | ------ |
| `workers/api/src/queries/orgs.ts`                           | `getOrgReleasesFeed` — add `productId` opt → `AND s.product_id = ?`                                                         | Modify |
| `workers/api/test/org-releases-product-filter.test.ts`      | Unit test for the product filter (makeD1Shim)                                                                               | Create |
| `workers/api/src/routes/orgs.ts`                            | `/orgs/:slug/releases` — resolve `?product=`, 404 unknown, pass `productId`; org-detail per-product `releaseCount` subquery | Modify |
| `packages/api-types/src/schemas/orgs.ts`                    | `OrgDetailProductSchema` — add `releaseCount`                                                                               | Modify |
| `workers/api/test/org-detail-product-release-count.test.ts` | Route test for per-product `releaseCount`                                                                                   | Create |
| `web/src/lib/api.ts`                                        | `orgReleases` gains `product` opt; new `productOverview` method                                                             | Modify |
| `web/src/app/api/org-releases/[slug]/route.ts`              | Forward `product` query param to the API                                                                                    | Modify |
| `web/src/components/org-release-list.tsx`                   | Optional `product` prop pins the feed                                                                                       | Modify |
| `web/src/app/[orgSlug]/product/[productSlug]/page.tsx`      | Rewrite: ≤1-product 301, overview, product feed, ItemList JSON-LD                                                           | Modify |
| `web/src/components/product-grid.tsx`                       | Hub product card grid (renders only at 2+ products)                                                                         | Create |
| `web/src/app/[orgSlug]/(org)/page.tsx`                      | Render `ProductGrid` above the timeline                                                                                     | Modify |

---

## Task 1: `productId` filter in `getOrgReleasesFeed`

**Files:**

- Modify: `workers/api/src/queries/orgs.ts` (the `getOrgReleasesFeed` function, ~lines 367–469)
- Test: `workers/api/test/org-releases-product-filter.test.ts` (create)

- [ ] **Step 1: Write the failing test**

Create `workers/api/test/org-releases-product-filter.test.ts`:

```ts
/**
 * Product-scoped org feed (#product-pages-default-unit). When opts.productId
 * is set, getOrgReleasesFeed returns only releases from sources under that
 * product — sources in sibling products and orphan (product-less) sources are
 * excluded. Absent the opt, the feed is unchanged.
 */
import { describe, it, expect, beforeEach } from "bun:test";
import { Database } from "bun:sqlite";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { applyMigrations, makeD1Shim } from "../../../tests/db-helper";
import { organizations, products, sources, releases } from "@buildinternet/releases-core/schema";
import { getOrgReleasesFeed } from "../src/queries/orgs.js";

const noCursor = { cursorWhere: "", cursorBindings: [] };

describe("getOrgReleasesFeed product filter", () => {
  let sqlite: Database;
  let db: ReturnType<typeof drizzle>;
  let d1: D1Database;

  beforeEach(async () => {
    sqlite = new Database(":memory:");
    db = drizzle(sqlite);
    applyMigrations(sqlite);
    d1 = makeD1Shim(sqlite);

    await db
      .insert(organizations)
      .values({ id: "org_a", slug: "acme", name: "Acme", category: "cloud" });
    await db.insert(products).values([
      { id: "prod_x", slug: "x", name: "Product X", orgId: "org_a" },
      { id: "prod_y", slug: "y", name: "Product Y", orgId: "org_a" },
    ]);
    await db.insert(sources).values([
      {
        id: "src_x",
        slug: "x-feed",
        name: "X Feed",
        type: "feed",
        url: "https://acme.test/x",
        orgId: "org_a",
        productId: "prod_x",
      },
      {
        id: "src_y",
        slug: "y-feed",
        name: "Y Feed",
        type: "feed",
        url: "https://acme.test/y",
        orgId: "org_a",
        productId: "prod_y",
      },
      {
        id: "src_orphan",
        slug: "blog",
        name: "Blog",
        type: "feed",
        url: "https://acme.test/blog",
        orgId: "org_a",
      },
    ]);
    await db.insert(releases).values([
      {
        id: "rel_x",
        sourceId: "src_x",
        title: "X 1.0",
        content: "x",
        url: "https://acme.test/x/1",
        publishedAt: "2026-04-20T00:00:00Z",
      },
      {
        id: "rel_y",
        sourceId: "src_y",
        title: "Y 1.0",
        content: "y",
        url: "https://acme.test/y/1",
        publishedAt: "2026-04-21T00:00:00Z",
      },
      {
        id: "rel_orphan",
        sourceId: "src_orphan",
        title: "Blog post",
        content: "b",
        url: "https://acme.test/blog/1",
        publishedAt: "2026-04-22T00:00:00Z",
      },
    ]);
  });

  it("returns only the product's releases when productId is set", async () => {
    const rows = await getOrgReleasesFeed(d1, "org_a", noCursor, 50, { productId: "prod_x" });
    const ids = rows.map((r) => r.id);
    expect(ids).toEqual(["rel_x"]);
  });

  it("excludes sibling products and orphan sources", async () => {
    const rows = await getOrgReleasesFeed(d1, "org_a", noCursor, 50, { productId: "prod_x" });
    const ids = rows.map((r) => r.id);
    expect(ids).not.toContain("rel_y");
    expect(ids).not.toContain("rel_orphan");
  });

  it("is unchanged (full org feed) when productId is absent", async () => {
    const rows = await getOrgReleasesFeed(d1, "org_a", noCursor, 50);
    expect(rows.map((r) => r.id).sort()).toEqual(["rel_orphan", "rel_x", "rel_y"]);
  });
});
```

- [ ] **Step 2: Run the test, verify it fails**

Run: `bun test workers/api/test/org-releases-product-filter.test.ts`
Expected: FAIL — the first two cases return all three releases (the `productId` opt is ignored), so `ids` is not `["rel_x"]`.

- [ ] **Step 3: Add the `productId` opt to the query**

In `workers/api/src/queries/orgs.ts`, add `productId` to the `opts` type. Find the `kind?: string;` field in the opts object (~line 382) and add directly after it:

```ts
    /** Restrict to sources under one product (resolved id). */
    productId?: string;
```

Then, immediately after the `kindWhere` block (the `if (opts.kind) { ... }` block, ~lines 412–416), add:

```ts
let productWhere = "";
if (opts.productId) {
  productWhere = "AND s.product_id = ?";
  filterBindings.push(opts.productId);
}
```

Finally, in the SQL template, add `${productWhere}` on its own line directly after `${kindWhere}`:

```ts
      ${kindWhere}
      ${productWhere}
      ${windowWhere}
```

Binding order is preserved: `filterBindings` pushes `productId` right after `kind`, matching the `${productWhere}`-after-`${kindWhere}` placement in the SQL.

- [ ] **Step 4: Run the test, verify it passes**

Run: `bun test workers/api/test/org-releases-product-filter.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add workers/api/src/queries/orgs.ts workers/api/test/org-releases-product-filter.test.ts
git commit -m "feat(api): productId filter in getOrgReleasesFeed"
```

---

## Task 2: `?product=` param on `GET /v1/orgs/:slug/releases`

**Files:**

- Modify: `workers/api/src/routes/orgs.ts` (the `/orgs/:slug/releases` handler, ~lines 1667–1849)

**Harness note:** This route mixes a Drizzle read (org resolve) with a raw-D1 read (`getOrgReleasesFeed`'s `.prepare()`). The shared `createTestApp` injects a Drizzle handle as `env.DB`, which does not serve raw `.prepare()`; `makeD1Shim` (raw) does not serve Drizzle query-builder reads. A full route integration test of this handler is therefore not supported by the current harness — the behavioral guarantee is covered by Task 1's query test. This task is thin wiring verified by `tsc`.

- [ ] **Step 1: Confirm the resolver import**

`findProductForOrgSlug` is exported from `workers/api/src/utils.ts` (~line 164). Check the existing import block at the top of `workers/api/src/routes/orgs.ts` for `from "../utils.js"` and add `findProductForOrgSlug` to it if absent. Verify what's already imported:

Run: `grep -n "from \"../utils.js\"" workers/api/src/routes/orgs.ts`
Expected: shows the existing utils import line to extend.

- [ ] **Step 2: Add the `product` OpenAPI parameter**

In the `describeRoute({...})` for `/orgs/:slug/releases`, inside the `parameters` array, add a new entry after the `kind` parameter object (the one whose `name: "kind"`):

```ts
      {
        name: "product",
        in: "query",
        required: false,
        schema: { type: "string" },
        description:
          "Restrict the feed to one product (slug or `prod_…` id, scoped to this org). Unknown product → 404.",
      },
```

- [ ] **Step 3: Resolve the param and pass `productId` to the query**

In the handler body, after the org-not-found guard (the line `if (!org) return c.json({ error: "not_found", message: "Organization not found" }, 404);`, ~line 1790) and before the `const results = await getOrgReleasesFeed(...)` call, insert:

```ts
const productParam = c.req.query("product");
let productId: string | undefined;
if (productParam) {
  const product = await findProductForOrgSlug(db, slug, productParam);
  if (!product) return c.json({ error: "not_found", message: "Product not found" }, 404);
  productId = product.id;
}
```

Then add `productId,` to the options object passed to `getOrgReleasesFeed` (the object containing `includeCoverage, sourceTypes, ...`):

```ts
      {
        includeCoverage,
        sourceTypes,
        includePrereleases,
        ftsMatch,
        kind,
        productId,
        since: window.since,
        until: window.until,
      },
```

- [ ] **Step 4: Type-check**

Run: `cd workers/api && npx tsc --noEmit && cd -`
Expected: no errors.

- [ ] **Step 5: Commit**

```bash
git add workers/api/src/routes/orgs.ts
git commit -m "feat(api): ?product= filter on org releases feed"
```

---

## Task 3: Per-product `releaseCount` (schema + org-detail handler)

**Files:**

- Modify: `packages/api-types/src/schemas/orgs.ts` (`OrgDetailProductSchema`, ~lines 115–123)
- Modify: `workers/api/src/routes/orgs.ts` (org-detail products select, ~lines 273–285)
- Test: `workers/api/test/org-detail-product-release-count.test.ts` (create)

- [ ] **Step 1: Write the failing test**

Create `workers/api/test/org-detail-product-release-count.test.ts`:

```ts
/**
 * Org detail exposes a per-product releaseCount for the web hub cards
 * (#product-pages-default-unit). Counts visible releases across the product's
 * sources; orphan-source releases don't inflate any product's count.
 */
import { describe, it, expect } from "bun:test";
import { organizations, products, sources, releases } from "@buildinternet/releases-core/schema";
import { createTestDb, createTestApp } from "./setup";
import { orgRoutes } from "../src/routes/orgs.js";

describe("GET /v1/orgs/:slug — per-product releaseCount", () => {
  it("counts visible releases per product and excludes orphan-source releases", async () => {
    const db = createTestDb();
    await db
      .insert(organizations)
      .values({ id: "org_a", slug: "acme", name: "Acme", category: "cloud" });
    await db.insert(products).values([
      { id: "prod_x", slug: "x", name: "Product X", orgId: "org_a" },
      { id: "prod_y", slug: "y", name: "Product Y", orgId: "org_a" },
    ]);
    await db.insert(sources).values([
      {
        id: "src_x",
        slug: "x-feed",
        name: "X Feed",
        type: "feed",
        url: "https://acme.test/x",
        orgId: "org_a",
        productId: "prod_x",
      },
      {
        id: "src_y",
        slug: "y-feed",
        name: "Y Feed",
        type: "feed",
        url: "https://acme.test/y",
        orgId: "org_a",
        productId: "prod_y",
      },
      {
        id: "src_orphan",
        slug: "blog",
        name: "Blog",
        type: "feed",
        url: "https://acme.test/blog",
        orgId: "org_a",
      },
    ]);
    await db.insert(releases).values([
      {
        id: "rel_x1",
        sourceId: "src_x",
        title: "X 1",
        content: "x",
        url: "https://acme.test/x/1",
        publishedAt: "2026-04-20T00:00:00Z",
      },
      {
        id: "rel_x2",
        sourceId: "src_x",
        title: "X 2",
        content: "x",
        url: "https://acme.test/x/2",
        publishedAt: "2026-04-21T00:00:00Z",
      },
      {
        id: "rel_orphan",
        sourceId: "src_orphan",
        title: "Post",
        content: "b",
        url: "https://acme.test/blog/1",
        publishedAt: "2026-04-22T00:00:00Z",
      },
    ]);

    const fetch = createTestApp(db, [orgRoutes], { env: {} });
    const res = await fetch(new Request("https://x.test/v1/orgs/acme"));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { products: { slug: string; releaseCount: number }[] };

    const x = body.products.find((p) => p.slug === "x");
    const y = body.products.find((p) => p.slug === "y");
    expect(x?.releaseCount).toBe(2);
    expect(y?.releaseCount).toBe(0);
  });
});
```

- [ ] **Step 2: Run the test, verify it fails**

Run: `bun test workers/api/test/org-detail-product-release-count.test.ts`
Expected: FAIL — `x?.releaseCount` is `undefined` (handler doesn't select it yet), not `2`.

- [ ] **Step 3: Add `releaseCount` to the schema**

In `packages/api-types/src/schemas/orgs.ts`, replace the `OrgDetailProductSchema` definition (~lines 115–123):

```ts
const OrgDetailProductSchema = ProductListItemSchema.pick({
  id: true,
  slug: true,
  name: true,
  url: true,
  description: true,
  sourceCount: true,
  kind: true,
}).extend({
  releaseCount: z.number().int().min(0),
});
```

(`z` is already imported at the top of this file.)

- [ ] **Step 4: Add the `releaseCount` subquery to the org-detail handler**

In `workers/api/src/routes/orgs.ts`, in the products `db.select({...})` (~lines 274–285), add a `releaseCount` field directly after the `sourceCount` line:

```ts
          sourceCount: sql<number>`(SELECT COUNT(*) FROM sources_active s WHERE s.product_id = products_active.id)`,
          releaseCount: sql<number>`(SELECT COUNT(*) FROM releases_visible rv JOIN sources_active sa ON sa.id = rv.source_id WHERE sa.product_id = products_active.id)`,
```

`releaseCount` flows through automatically because the response builds `products: productRows` (~line 426) from this select. `releases_visible` is the existing view the feed query uses; it excludes suppressed and coverage-side rows.

- [ ] **Step 5: Run the test, verify it passes**

Run: `bun test workers/api/test/org-detail-product-release-count.test.ts`
Expected: PASS.

- [ ] **Step 6: Type-check (api-types is consumed from source by the worker)**

Run: `cd workers/api && npx tsc --noEmit && cd -`
Expected: no errors.

- [ ] **Step 7: Commit**

```bash
git add packages/api-types/src/schemas/orgs.ts workers/api/src/routes/orgs.ts workers/api/test/org-detail-product-release-count.test.ts
git commit -m "feat(api): per-product releaseCount on org detail"
```

---

## Task 4: Web data layer — `product` feed opt, `productOverview`, proxy passthrough

**Files:**

- Modify: `web/src/lib/api.ts` (`orgReleases` opts ~lines 383–400; add `productOverview` near `productDetail` ~line 427)
- Modify: `web/src/app/api/org-releases/[slug]/route.ts`

- [ ] **Step 1: Add `product` to `orgReleases` opts**

In `web/src/lib/api.ts`, update the `orgReleases` method (~lines 383–400):

```ts
  orgReleases: (
    slug: string,
    opts: {
      cursor?: string;
      limit?: number;
      sourceType?: string;
      includePrereleases?: boolean;
      product?: string;
    } = {},
  ) => {
    const { cursor, limit = 20, sourceType, includePrereleases, product } = opts;
    const params = new URLSearchParams();
    if (cursor) params.set("cursor", cursor);
    if (limit !== 20) params.set("limit", String(limit));
    if (sourceType && sourceType !== "all") params.set("source_type", sourceType);
    if (includePrereleases) params.set("include_prereleases", "true");
    if (product) params.set("product", product);
    const qs = params.toString();
    return fetchApi<OrgReleasesResponse>(`/v1/orgs/${slug}/releases${qs ? `?${qs}` : ""}`);
  },
```

- [ ] **Step 2: Add the `productOverview` method**

`OverviewPageItem` is already imported in this file (~line 49). Add this method directly after the `productDetail` method (~line 428):

```ts
  productOverview: (identifier: string) =>
    fetchApi<OverviewPageItem | null>(`/v1/products/${identifier}/overview`),
```

- [ ] **Step 3: Forward `product` in the proxy route**

Replace the body of `web/src/app/api/org-releases/[slug]/route.ts`:

```ts
import { NextRequest, NextResponse } from "next/server";
import { webApiHeaders } from "@/lib/api";
import { apiBaseUrl } from "@/lib/env";

const API_URL = apiBaseUrl() ?? "http://localhost:3456";

export async function GET(req: NextRequest, { params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const cursor = req.nextUrl.searchParams.get("cursor") ?? "";
  const sourceType = req.nextUrl.searchParams.get("source_type") ?? "";
  const includePrereleases = req.nextUrl.searchParams.get("include_prereleases") ?? "";
  const q = req.nextUrl.searchParams.get("q") ?? "";
  const product = req.nextUrl.searchParams.get("product") ?? "";

  const qs = new URLSearchParams();
  if (cursor) qs.set("cursor", cursor);
  if (sourceType) qs.set("source_type", sourceType);
  if (includePrereleases) qs.set("include_prereleases", includePrereleases);
  if (q) qs.set("q", q);
  if (product) qs.set("product", product);

  const res = await fetch(`${API_URL}/v1/orgs/${slug}/releases?${qs}`, {
    headers: webApiHeaders(),
  });
  const data = await res.json();
  return NextResponse.json(data, { status: res.status });
}
```

- [ ] **Step 4: Type-check**

Run: `cd web && npx tsc --noEmit && cd -`
Expected: no errors.

- [ ] **Step 5: Commit**

```bash
git add web/src/lib/api.ts web/src/app/api/org-releases/[slug]/route.ts
git commit -m "feat(web): product feed opt + productOverview + proxy passthrough"
```

---

## Task 5: `OrgReleaseList` optional `product` prop

**Files:**

- Modify: `web/src/components/org-release-list.tsx`

- [ ] **Step 1: Add the prop to the interface**

In `web/src/components/org-release-list.tsx`, add to `OrgReleaseListProps` (after `availableSourceTypes`):

```ts
  /** When set, pins the feed to one product (slug or prod_ id). Not a user-flippable filter. */
  product?: string;
```

- [ ] **Step 2: Destructure the prop**

In the `export function OrgReleaseList({ ... })` destructure, add `product`:

```ts
export function OrgReleaseList({
  orgSlug,
  initialReleases,
  initialCursor,
  multipleSourcesExist,
  availableSourceTypes,
  product,
}: OrgReleaseListProps) {
```

- [ ] **Step 3: Thread `product` into `buildQuery`**

In the `buildQuery` `useCallback`, add the `product` line after the `q` line, and add `product` to the dependency array:

```ts
const buildQuery = useCallback(
  (extra: Record<string, string> = {}) => {
    const params = new URLSearchParams();
    const types = FILTER_GROUPS[filterGroup].types;
    if (types.length > 0) params.set("source_type", types.join(","));
    if (includePrereleases) params.set("include_prereleases", "true");
    if (trimmedSearch) params.set("q", trimmedSearch);
    if (product) params.set("product", product);
    for (const [k, v] of Object.entries(extra)) params.set(k, v);
    return params.toString();
  },
  [filterGroup, includePrereleases, trimmedSearch, product],
);
```

- [ ] **Step 4: Type-check**

Run: `cd web && npx tsc --noEmit && cd -`
Expected: no errors. (No callers pass `product` yet — Task 6 adds the call site.)

- [ ] **Step 5: Commit**

```bash
git add web/src/components/org-release-list.tsx
git commit -m "feat(web): OrgReleaseList product prop pins the feed"
```

---

## Task 6: Rewrite the product page (collapse + overview + feed + JSON-LD)

**Files:**

- Modify: `web/src/app/[orgSlug]/product/[productSlug]/page.tsx` (full rewrite)

- [ ] **Step 1: Replace the page**

Replace the entire contents of `web/src/app/[orgSlug]/product/[productSlug]/page.tsx`:

```tsx
import type { Metadata } from "next";
import { cache } from "react";
import { notFound, permanentRedirect } from "next/navigation";
import Link from "next/link";
import {
  api,
  ApiSetupError,
  ApiNotFoundError,
  type ProductDetail,
  type OrgReleasesResponse,
  type OverviewPageItem,
} from "@/lib/api";
import type { SourceType } from "@buildinternet/releases-core/source-enums";
import { Header } from "@/components/header";
import { SetupMessage } from "@/components/setup-message";
import { Sidebar } from "@/components/sidebar";
import { CliCommand } from "@/components/cli-command";
import { JsonLd } from "@/components/json-ld";
import { OrgReleaseList } from "@/components/org-release-list";
import { OverviewView } from "@/components/overview-view";
import { taxonomySidebarSections } from "@/components/taxonomy-chips";
import { buildReleaseItemListJsonLd } from "@/lib/schema-org";
import { AppIcon } from "@/components/app-icon";
import { getAppInfo, type AppInfo } from "@/lib/app-source";
import { getOrg } from "../../_lib/org-data";

const getProduct = cache((orgSlug: string, productSlug: string) =>
  api.productDetail({ orgSlug, productSlug }),
);

export async function generateMetadata({
  params,
}: {
  params: Promise<{ orgSlug: string; productSlug: string }>;
}): Promise<Metadata> {
  const { orgSlug, productSlug } = await params;
  try {
    const product = await getProduct(orgSlug, productSlug);
    return {
      title: `${product.name} Release Notes & Changelog`,
      description:
        product.description ?? `Release notes, changelog, and updates for ${product.name}.`,
      openGraph: { type: "website", url: `/${orgSlug}/product/${productSlug}` },
      alternates: { canonical: `/${orgSlug}/product/${productSlug}` },
    };
  } catch {
    return { title: productSlug };
  }
}

export default async function ProductPage({
  params,
}: {
  params: Promise<{ orgSlug: string; productSlug: string }>;
}) {
  const { orgSlug, productSlug } = await params;

  let product: ProductDetail;
  let org;
  try {
    [product, org] = await Promise.all([getProduct(orgSlug, productSlug), getOrg(orgSlug)]);
  } catch (err) {
    if (err instanceof ApiSetupError) {
      return (
        <div className="min-h-screen">
          <Header />
          <SetupMessage message={err.message} steps={err.setup} />
        </div>
      );
    }
    if (err instanceof ApiNotFoundError) notFound();
    throw err;
  }

  // Single-product collapse: with ≤1 product the org page is already this
  // product's feed, so the product page would be duplicate content. 301 home.
  if (org.products.length <= 1) {
    permanentRedirect(`/${orgSlug}`);
  }

  const orgName = org.name;

  // Initial feed rows (product-scoped) + overview, both best-effort.
  let initialReleases: OrgReleasesResponse;
  try {
    initialReleases = await api.orgReleases(orgSlug, { product: productSlug });
  } catch {
    initialReleases = { releases: [], pagination: { nextCursor: null, limit: 20 } };
  }
  let overview: OverviewPageItem | null = null;
  try {
    overview = await api.productOverview(product.id);
  } catch {
    overview = null;
  }

  const appEntries = product.sources
    .map((s) => {
      const app = getAppInfo(s);
      return app ? { slug: s.slug, name: s.name, app } : null;
    })
    .filter((e): e is { slug: string; name: string; app: AppInfo } => e !== null);

  const availableSourceTypes = Array.from(
    new Set(product.sources.map((s) => s.type)),
  ) as SourceType[];

  const sidebarSections = [
    { items: [{ label: "Sources", value: product.sources.length, large: true }] },
    ...taxonomySidebarSections({ category: product.category, tags: product.tags }),
  ];

  const productUrl = `https://releases.sh/${orgSlug}/product/${productSlug}`;
  const releaseListId = `${productUrl}#releases`;
  const jsonLd = {
    "@context": "https://schema.org",
    "@graph": [
      {
        "@type": "CollectionPage",
        name: product.name,
        url: productUrl,
        mainEntity: { "@id": releaseListId },
        ...(product.description ? { description: product.description } : {}),
      },
      {
        "@type": "BreadcrumbList",
        itemListElement: [
          { "@type": "ListItem", position: 1, name: "Home", item: "https://releases.sh" },
          {
            "@type": "ListItem",
            position: 2,
            name: orgName,
            item: `https://releases.sh/${orgSlug}`,
          },
          { "@type": "ListItem", position: 3, name: product.name, item: productUrl },
        ],
      },
      buildReleaseItemListJsonLd(initialReleases.releases, {
        listId: releaseListId,
        name: `${product.name} Releases`,
      }),
    ],
  };

  return (
    <div className="min-h-screen">
      <JsonLd data={jsonLd} />
      <Header />
      <div className="max-w-4xl mx-auto px-6">
        <div className="pt-5 text-[13px] text-stone-400 dark:text-stone-500">
          <Link href="/" className="hover:text-stone-600 dark:hover:text-stone-300">
            Home
          </Link>
          <span className="mx-1.5">/</span>
          <Link href={`/${orgSlug}`} className="hover:text-stone-600 dark:hover:text-stone-300">
            {orgName}
          </Link>
          <span className="mx-1.5">/</span>
          <span className="text-stone-600 dark:text-stone-300 font-medium">{product.name}</span>
        </div>

        <h1 className="text-[28px] font-bold tracking-tight text-stone-900 dark:text-stone-100 mt-4">
          {product.name}
        </h1>
        {product.description && (
          <p className="text-sm text-stone-500 dark:text-stone-400 mt-1">{product.description}</p>
        )}
        {appEntries.length > 0 && (
          <div className="flex items-center gap-2 mt-3">
            <span className="text-xs text-stone-400 dark:text-stone-500">Available on</span>
            {appEntries.map((e) => (
              <Link
                key={e.slug}
                href={`/${orgSlug}/${e.slug}`}
                className="flex items-center gap-1.5 bg-stone-100 dark:bg-stone-800 hover:bg-stone-200 dark:hover:bg-stone-700 rounded-md px-2 py-1 transition-colors"
              >
                <AppIcon iconUrl={e.app.iconUrl} name={e.name} size={16} />
                <span className="text-xs font-medium text-stone-600 dark:text-stone-300">
                  {e.app.label}
                </span>
              </Link>
            ))}
          </div>
        )}
        <CliCommand identifier={product.slug} />

        <div className="flex flex-col md:flex-row gap-10 mt-6 pb-6">
          <div className="flex-1 min-w-0">
            {overview && <OverviewView page={overview} />}
            <OrgReleaseList
              orgSlug={orgSlug}
              product={productSlug}
              initialReleases={initialReleases.releases}
              initialCursor={initialReleases.pagination.nextCursor}
              multipleSourcesExist={product.sources.length > 1}
              availableSourceTypes={availableSourceTypes}
            />
          </div>
          <Sidebar sections={sidebarSections} formatPath={`/${orgSlug}/product/${productSlug}`} />
        </div>
      </div>
    </div>
  );
}
```

- [ ] **Step 2: Type-check**

Run: `cd web && npx tsc --noEmit && cd -`
Expected: no errors. (If `SourceType` import path differs, confirm with `grep -n "source-enums" web/src/components/org-release-list.tsx` — it imports `SourceType` from `@buildinternet/releases-core/source-enums`.)

- [ ] **Step 3: Commit**

```bash
git add web/src/app/[orgSlug]/product/[productSlug]/page.tsx
git commit -m "feat(web): product page is now a product-scoped feed with ≤1-product collapse"
```

---

## Task 7: Product card grid on the org Overview hub

**Files:**

- Create: `web/src/components/product-grid.tsx`
- Modify: `web/src/app/[orgSlug]/(org)/page.tsx`

- [ ] **Step 1: Create the `ProductGrid` component**

Create `web/src/components/product-grid.tsx`:

```tsx
import Link from "next/link";
import type { OrgDetail } from "@/lib/api";

/**
 * Hub product cards on the org Overview page. Renders only when the org has
 * 2+ products — at ≤1 product the org page is already the single product's
 * feed (and the product page 301s home), so a grid would be redundant.
 */
export function ProductGrid({
  orgSlug,
  products,
}: {
  orgSlug: string;
  products: OrgDetail["products"];
}) {
  if (products.length < 2) return null;

  return (
    <div className="mt-5">
      <h2 className="text-xs font-semibold uppercase tracking-wider text-stone-400 dark:text-stone-500 mb-3">
        Products
      </h2>
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
        {products.map((p) => (
          <Link
            key={p.slug}
            href={`/${orgSlug}/product/${p.slug}`}
            className="flex items-center justify-between rounded-lg border border-stone-200 dark:border-stone-800 hover:border-stone-300 dark:hover:border-stone-700 bg-white dark:bg-stone-900 px-3 py-2.5 transition-colors"
          >
            <span className="text-sm font-medium text-stone-800 dark:text-stone-200 truncate">
              {p.name}
            </span>
            <span className="text-xs text-stone-400 dark:text-stone-500 shrink-0 ml-3">
              {p.releaseCount} release{p.releaseCount === 1 ? "" : "s"}
            </span>
          </Link>
        ))}
      </div>
    </div>
  );
}
```

(No emoji / arrow glyph — the card border + hover is the affordance, per project UI convention.)

- [ ] **Step 2: Render it on the org Overview page**

In `web/src/app/[orgSlug]/(org)/page.tsx`, add the import alongside the other component imports:

```ts
import { ProductGrid } from "@/components/product-grid";
```

Then, in the returned JSX, add `<ProductGrid>` as the first child of the fragment, before the `{activity && (` block:

```tsx
  return (
    <>
      <JsonLd data={jsonLd} />
      <ProductGrid orgSlug={orgSlug} products={org.products} />
      {activity && (
        <ReleaseTimeline
```

`org` is already in scope (from the `Promise.all` that resolves `getOrg(orgSlug)`), and `org.products` now carries `releaseCount` (Task 3). `ProductGrid` self-hides at <2 products, so 0–1-product orgs render exactly as before.

- [ ] **Step 3: Type-check**

Run: `cd web && npx tsc --noEmit && cd -`
Expected: no errors.

- [ ] **Step 4: Commit**

```bash
git add web/src/components/product-grid.tsx web/src/app/[orgSlug]/(org)/page.tsx
git commit -m "feat(web): product card grid on the org overview hub"
```

---

## Task 8: Full verification

**Files:** none (verification only)

- [ ] **Step 1: Type-check root + worker + web**

Run: `npx tsc --noEmit && (cd workers/api && npx tsc --noEmit) && (cd web && npx tsc --noEmit)`
Expected: all pass, no errors.

- [ ] **Step 2: Run the new API tests + the existing feed guardrail**

Run: `bun test workers/api/test/org-releases-product-filter.test.ts workers/api/test/org-detail-product-release-count.test.ts workers/api/test/release-feed-future-dated.test.ts`
Expected: all PASS.

- [ ] **Step 3: Lint + format**

Run: `bun run lint && bun run format:check`
Expected: clean. (If `format:check` flags the new/edited files, run `bun run format` and amend the relevant commit.)

- [ ] **Step 4: Full test suite**

Run: `bun test`
Expected: PASS. (Note: per repo guidance the root suite splits worker vs package processes; if a pre-existing unrelated failure appears, confirm it reproduces on `main` before attributing it to this work.)

- [ ] **Step 5: Manual smoke (dev server)**

Run: `bun run dev:web` (and `bun run dev:api` if not already up), then verify in the browser:

- A 2+-product org (e.g. `/vercel`): the **Products** grid renders above the timeline with per-product counts; clicking a card lands on `/vercel/product/<slug>` showing that product's feed only.
- A 0–1-product org: org page is unchanged (no grid).
- Visiting `/<org>/product/<slug>` for an org with ≤1 product 301s to `/<org>`.

Expected: all three behave as described.

---

## Self-review notes (author)

- **Spec coverage:** Page model + threshold → Tasks 6/7 (collapse + grid gate at 2). Org hub hybrid → Task 7 (grid above existing timeline; aggregate feed/tabs untouched). Product feed-only page → Task 6. `?product=` filter → Tasks 1–2. `releaseCount` hub metric → Task 3. ≤1-product 301 → Task 6. JSON-LD ItemList → Task 6. Out-of-scope items (product heatmap, feed-format buttons, search/catalog rewiring, dedicated REST endpoint) are intentionally absent.
- **Type consistency:** `productId` (query opt) / `product` (route query param, web opt, component prop) used consistently per layer; `releaseCount` matches between `OrgDetailProductSchema` and the handler select; `OverviewPageItem` reused (already imported in `api.ts`).
- **Placeholder scan:** none — every code step carries full content.
- **Harness honesty:** Task 2 documents why the mixed raw-D1/Drizzle route can't be integration-tested with the shared harness; the behavior is covered at the query layer (Task 1).
