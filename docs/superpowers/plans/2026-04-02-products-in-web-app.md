# Products Layer in Web App — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Surface the products layer in the web app so multi-product orgs (e.g., Cloudflare, Vercel) group their sources under named products, and single-product orgs continue to display as they do today.

**Architecture:** The API already returns `products` in the org detail response (`GET /api/orgs/:slug`). We need to: (1) update the shared `OrgDetail` type to include products, (2) update the web API client to expose product data, (3) group sources by product on the org page when products exist, (4) add a product detail page at `/:orgSlug/product/:productSlug`.

**Tech Stack:** Next.js 15 (App Router, RSC), TypeScript, Tailwind CSS, existing shared types from `src/api/types.ts`, existing API client at `web/src/lib/api.ts`.

---

## File Map

| File | Action | Responsibility |
|------|--------|---------------|
| `src/api/types.ts` | Modify | Add `products` to `OrgDetail`, add `productSlug`/`productName` to `OrgActivitySource` |
| `web/src/lib/api.ts` | Modify | Import `ProductListItem`, add `productDetail()` method |
| `web/src/app/[orgSlug]/page.tsx` | Modify | Group sources by product when products exist |
| `web/src/components/source-card.tsx` | Modify | Show product badge when `productName` is present |
| `web/src/components/release-timeline.tsx` | Modify | Group source cards by product in the activity view |
| `web/src/app/[orgSlug]/product/[productSlug]/page.tsx` | Create | Product detail page showing product info + its sources |

---

### Task 1: Update `OrgDetail` type to include products

The API already returns a `products` array on `GET /api/orgs/:slug` (see `workers/api/src/routes/orgs.ts:161-178`), but the shared type doesn't declare it. The `OrgActivitySource` type also lacks product affiliation.

**Files:**
- Modify: `src/api/types.ts:40-53` (OrgDetail interface)
- Modify: `src/api/types.ts:165-174` (OrgActivitySource interface)

- [ ] **Step 1: Add `products` field to `OrgDetail`**

In `src/api/types.ts`, add `products` to the `OrgDetail` interface. The shape matches what the API returns at `orgs.ts:100-110`:

```typescript
export interface OrgDetail {
  slug: string;
  name: string;
  domain: string | null;
  avatarUrl: string | null;
  sourceCount: number;
  releaseCount: number;
  releasesLast30Days: number;
  avgReleasesPerWeek: number;
  lastFetchedAt: string | null;
  trackingSince: string;
  accounts: { platform: string; handle: string }[];
  products: Array<{
    id: string;
    slug: string;
    name: string;
    url: string | null;
    description: string | null;
    sourceCount: number;
  }>;
  sources: SourceListItem[];
}
```

- [ ] **Step 2: Verify type-check passes**

Run: `cd /Users/zachdunn/Code/released && npx tsc --noEmit`
Expected: No new errors (existing code doesn't destructure `OrgDetail` in a way that would break).

- [ ] **Step 3: Commit**

```bash
git add src/api/types.ts
git commit -m "feat(types): add products array to OrgDetail interface"
```

---

### Task 2: Add `productDetail` to web API client

The web needs to fetch product details for the product detail page. The endpoint `GET /api/products/:identifier` already exists.

**Files:**
- Modify: `web/src/lib/api.ts`

- [ ] **Step 1: Import ProductDetail and add productDetail method**

Add `ProductDetail` to the imports from `@shared/api/types` and add the API method:

```typescript
// Add to the import block:
import type {
  Stats,
  OrgListItem,
  OrgDetail,
  SourceListItem,
  SourceDetail,
  SearchResponse,
  SourceActivity,
  OrgActivity,
  OrgReleasesResponse,
  ReleaseDetail,
  ProductDetail,
} from "@shared/api/types";

// Add to the re-export block:
export type {
  Stats,
  OrgListItem,
  OrgDetail,
  SourceListItem,
  SourceDetail,
  SearchResponse,
  SourceActivity,
  OrgActivity,
  OrgReleasesResponse,
  ReleaseDetail,
  ProductDetail,
};

// Add to the api object:
  productDetail: (slug: string) => fetchApi<ProductDetail>(`/api/products/${slug}`),
```

- [ ] **Step 2: Verify type-check passes**

Run: `cd /Users/zachdunn/Code/released && npx tsc --noEmit`
Expected: PASS

- [ ] **Step 3: Commit**

```bash
git add web/src/lib/api.ts
git commit -m "feat(web): add productDetail to API client"
```

---

### Task 3: Group sources by product on the org page

When an org has products, sources should be grouped under product headings. Orgs without products continue to show a flat source list.

**Files:**
- Modify: `web/src/app/[orgSlug]/page.tsx`

- [ ] **Step 1: Update the SourceList component to group by product**

Replace the `SourceList` function in `web/src/app/[orgSlug]/page.tsx` with a version that groups sources by product when the org has products. The org's `sources` array already has `productSlug` and `productName` fields on `SourceListItem` — but the API may not populate them yet. Instead, use the `products` array from `OrgDetail` to build groups by matching source slugs.

Since the org detail API (`orgs.ts:76-97`) doesn't currently return `productId` on each source, we need to cross-reference differently. The products array includes `sourceCount` but not source slugs. We should use the product detail endpoint for this. **However**, a simpler approach: update the org detail API to include `productSlug` on each source.

**Actually — the simplest approach is to fetch the product list from the org response and match by querying products.** But the org API doesn't return which sources belong to which product.

Let's update the org detail API to include `productSlug` and `productName` on each source in the response. This is a small backend change.

- [ ] **Step 1a: Update org detail API to include product info on sources**

In `workers/api/src/routes/orgs.ts`, update the source query (lines 76-97) to join products and include product slug/name:

```sql
SELECT
  s.id, s.slug, s.name, s.type, s.url, s.is_primary,
  p.slug AS product_slug, p.name AS product_name,
  (SELECT COUNT(*) FROM releases r WHERE r.source_id = s.id AND (r.suppressed IS NULL OR r.suppressed = 0)) AS release_count,
  (SELECT r2.version FROM releases r2 WHERE r2.source_id = s.id AND r2.published_at IS NOT NULL AND (r2.suppressed IS NULL OR r2.suppressed = 0) ORDER BY r2.published_at DESC LIMIT 1) AS latest_version_by_date,
  (SELECT r3.published_at FROM releases r3 WHERE r3.source_id = s.id AND r3.published_at IS NOT NULL AND (r3.suppressed IS NULL OR r3.suppressed = 0) ORDER BY r3.published_at DESC LIMIT 1) AS latest_date,
  (SELECT r4.version FROM releases r4 WHERE r4.source_id = s.id AND (r4.suppressed IS NULL OR r4.suppressed = 0) ORDER BY r4.fetched_at DESC LIMIT 1) AS latest_version_by_fetch
FROM sources s
LEFT JOIN products p ON p.id = s.product_id
WHERE s.org_id = ${org.id}
ORDER BY s.name
```

Update the row type to include `product_slug: string | null` and `product_name: string | null`.

Update `sourcesWithStats` mapping (line 114-124) to include:
```typescript
productSlug: row.product_slug ?? null,
productName: row.product_name ?? null,
```

- [ ] **Step 1b: Verify API returns product info on sources**

Run locally or via curl to confirm the org detail response now includes `productSlug` and `productName` on each source entry.

- [ ] **Step 1c: Commit the API change**

```bash
git add workers/api/src/routes/orgs.ts
git commit -m "feat(api): include productSlug/productName on org detail sources"
```

- [ ] **Step 2: Update SourceList to group by product**

In `web/src/app/[orgSlug]/page.tsx`, replace the `SourceList` component:

```tsx
function SourceList({ org, orgSlug }: { org: OrgDetail; orgSlug: string }) {
  const sortedSources = [...org.sources].sort((a, b) => {
    if (a.isPrimary && !b.isPrimary) return -1;
    if (!a.isPrimary && b.isPrimary) return 1;
    if (a.type === "github" && b.type !== "github") return 1;
    if (a.type !== "github" && b.type === "github") return -1;
    return 0;
  });

  // If no products, render flat list
  if (org.products.length === 0) {
    return (
      <div className="space-y-2">
        {sortedSources.map((source) => (
          <SourceCard key={source.slug} source={source} orgSlug={orgSlug} />
        ))}
      </div>
    );
  }

  // Group sources by product
  const productSources = new Map<string | null, typeof sortedSources>();
  for (const source of sortedSources) {
    const key = source.productSlug ?? null;
    if (!productSources.has(key)) productSources.set(key, []);
    productSources.get(key)!.push(source);
  }

  // Order: products first (alphabetical by name), then ungrouped sources
  const productOrder = org.products
    .map((p) => p.slug)
    .filter((slug) => productSources.has(slug));
  const ungrouped = productSources.get(null) ?? [];

  return (
    <div className="space-y-6">
      {productOrder.map((productSlug) => {
        const product = org.products.find((p) => p.slug === productSlug)!;
        const sources = productSources.get(productSlug) ?? [];
        return (
          <div key={productSlug}>
            <Link
              href={`/${orgSlug}/product/${productSlug}`}
              className="flex items-center gap-2 mb-2 group"
            >
              <h3 className="text-sm font-semibold text-stone-700 dark:text-stone-300 group-hover:text-stone-900 dark:group-hover:text-stone-100">
                {product.name}
              </h3>
              {product.description && (
                <span className="text-xs text-stone-400 dark:text-stone-500 hidden sm:inline">
                  {product.description}
                </span>
              )}
            </Link>
            <div className="space-y-2">
              {sources.map((source) => (
                <SourceCard key={source.slug} source={source} orgSlug={orgSlug} />
              ))}
            </div>
          </div>
        );
      })}
      {ungrouped.length > 0 && productOrder.length > 0 && (
        <div>
          <h3 className="text-sm font-semibold text-stone-700 dark:text-stone-300 mb-2">Other Sources</h3>
          <div className="space-y-2">
            {ungrouped.map((source) => (
              <SourceCard key={source.slug} source={source} orgSlug={orgSlug} />
            ))}
          </div>
        </div>
      )}
      {ungrouped.length > 0 && productOrder.length === 0 && (
        <div className="space-y-2">
          {ungrouped.map((source) => (
            <SourceCard key={source.slug} source={source} orgSlug={orgSlug} />
          ))}
        </div>
      )}
    </div>
  );
}
```

Add the `Link` import if not already present (it is — line 11).

- [ ] **Step 3: Add "Products" count to the sidebar**

In the `sidebarSections` array, add a products count when products exist:

```typescript
const sidebarSections = [
  {
    items: [
      ...(org.domain ? [{ label: "Domain", value: org.domain }] : []),
      ...(org.products.length > 0 ? [{ label: "Products", value: org.products.length, large: true }] : []),
      { label: "Sources", value: org.sourceCount, large: true },
      { label: "Total Releases", value: org.releaseCount, large: true },
    ],
  },
  // ... rest unchanged
];
```

- [ ] **Step 4: Verify type-check passes**

Run: `cd /Users/zachdunn/Code/released && npx tsc --noEmit`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add web/src/app/[orgSlug]/page.tsx
git commit -m "feat(web): group sources by product on org detail page"
```

---

### Task 4: Group sources by product in the release timeline

The `ReleaseTimeline` component renders source cards in the activity view. When products exist, it should group them the same way.

**Files:**
- Modify: `web/src/components/release-timeline.tsx`

- [ ] **Step 1: Accept products prop and group cards**

Update the `ReleaseTimelineProps` interface to accept the org's products:

```typescript
interface ReleaseTimelineProps {
  activity: OrgActivity;
  orgSlug: string;
  sources: SourceListItem[];
  products: OrgDetail["products"];
}
```

Then update the render section (line 179-183) to group by product when products exist. The grouping logic is the same as Task 3 — build a map of `productSlug -> sources`, render product headings:

```tsx
{products.length > 0 ? (
  <ProductGroupedSources
    sources={sortedSources}
    products={products}
    orgSlug={orgSlug}
    cadenceMap={cadenceMap}
  />
) : (
  <div className="space-y-2">
    {sortedSources.map((source) => (
      <SourceCard key={source.slug} source={source} orgSlug={orgSlug} cadence={cadenceMap.get(source.slug)} />
    ))}
  </div>
)}
```

Add a `ProductGroupedSources` helper component within the same file:

```tsx
function ProductGroupedSources({
  sources,
  products,
  orgSlug,
  cadenceMap,
}: {
  sources: SourceListItem[];
  products: OrgDetail["products"];
  orgSlug: string;
  cadenceMap: Map<string, SourceCadenceData>;
}) {
  const productSources = new Map<string | null, SourceListItem[]>();
  for (const source of sources) {
    const key = source.productSlug ?? null;
    if (!productSources.has(key)) productSources.set(key, []);
    productSources.get(key)!.push(source);
  }

  const productOrder = products
    .map((p) => p.slug)
    .filter((slug) => productSources.has(slug));
  const ungrouped = productSources.get(null) ?? [];

  return (
    <div className="space-y-6">
      {productOrder.map((productSlug) => {
        const product = products.find((p) => p.slug === productSlug)!;
        const srcs = productSources.get(productSlug) ?? [];
        return (
          <div key={productSlug}>
            <h3 className="text-sm font-semibold text-stone-700 dark:text-stone-300 mb-2">{product.name}</h3>
            <div className="space-y-2">
              {srcs.map((source) => (
                <SourceCard key={source.slug} source={source} orgSlug={orgSlug} cadence={cadenceMap.get(source.slug)} />
              ))}
            </div>
          </div>
        );
      })}
      {ungrouped.length > 0 && (
        <div>
          {productOrder.length > 0 && (
            <h3 className="text-sm font-semibold text-stone-700 dark:text-stone-300 mb-2">Other Sources</h3>
          )}
          <div className="space-y-2">
            {ungrouped.map((source) => (
              <SourceCard key={source.slug} source={source} orgSlug={orgSlug} cadence={cadenceMap.get(source.slug)} />
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
```

- [ ] **Step 2: Update the caller in org page to pass products**

In `web/src/app/[orgSlug]/page.tsx`, update the `ReleaseTimeline` usage to pass `products`:

```tsx
<ReleaseTimeline activity={activity} orgSlug={org.slug} sources={org.sources} products={org.products} />
```

- [ ] **Step 3: Verify type-check passes**

Run: `cd /Users/zachdunn/Code/released && npx tsc --noEmit`
Expected: PASS

- [ ] **Step 4: Commit**

```bash
git add web/src/components/release-timeline.tsx web/src/app/[orgSlug]/page.tsx
git commit -m "feat(web): group timeline sources by product"
```

---

### Task 5: Product detail page

Create a page at `/:orgSlug/product/:productSlug` that shows the product's sources and basic info. This follows the same pattern as the existing source detail page at `/:orgSlug/:sourceSlug`.

**Files:**
- Create: `web/src/app/[orgSlug]/product/[productSlug]/page.tsx`

- [ ] **Step 1: Create the product detail page**

Create `web/src/app/[orgSlug]/product/[productSlug]/page.tsx`:

```tsx
import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { api, ApiSetupError, type ProductDetail } from "@/lib/api";
import { Header } from "@/components/header";
import { SetupMessage } from "@/components/setup-message";
import { Sidebar } from "@/components/sidebar";
import { SourceTypeIcon } from "@/components/source-type-icon";
import Link from "next/link";

export async function generateMetadata({
  params,
}: {
  params: Promise<{ orgSlug: string; productSlug: string }>;
}): Promise<Metadata> {
  const { orgSlug, productSlug } = await params;
  try {
    const product = await api.productDetail(productSlug);
    return {
      title: `${product.name} — ${orgSlug}`,
      description: product.description ?? `${product.name} changelog sources`,
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
  try {
    product = await api.productDetail(productSlug);
  } catch (err) {
    if (err instanceof ApiSetupError) {
      return (
        <div className="min-h-screen">
          <Header />
          <SetupMessage message={err.message} steps={err.setup} />
        </div>
      );
    }
    notFound();
  }

  const sidebarSections = [
    {
      items: [
        { label: "Sources", value: product.sources.length, large: true },
        ...(product.category
          ? [{ label: "Category", value: product.category }]
          : []),
      ],
    },
    ...(product.tags.length > 0
      ? [{ items: [{ label: "Tags", value: product.tags.join(", ") }] }]
      : []),
  ];

  return (
    <div className="min-h-screen">
      <Header />
      <div className="max-w-4xl mx-auto px-6">
        <div className="pt-5 text-[13px] text-stone-400 dark:text-stone-500">
          <Link
            href="/"
            className="hover:text-stone-600 dark:hover:text-stone-300"
          >
            Home
          </Link>
          <span className="mx-1.5">/</span>
          <Link
            href={`/${orgSlug}`}
            className="hover:text-stone-600 dark:hover:text-stone-300"
          >
            {orgSlug}
          </Link>
          <span className="mx-1.5">/</span>
          <span className="text-stone-600 dark:text-stone-300 font-medium">
            {product.name}
          </span>
        </div>

        <h1 className="text-[28px] font-bold tracking-tight text-stone-900 dark:text-stone-100 mt-4">
          {product.name}
        </h1>
        {product.description && (
          <p className="text-sm text-stone-500 dark:text-stone-400 mt-1">
            {product.description}
          </p>
        )}

        <div className="flex flex-col md:flex-row gap-10 mt-6 pb-6">
          <div className="flex-1 min-w-0">
            <h2 className="text-xs font-semibold uppercase tracking-wider text-stone-400 dark:text-stone-500 mb-3">
              Sources
            </h2>
            <div className="space-y-2">
              {product.sources.map((source) => (
                <Link
                  key={source.slug}
                  href={`/${orgSlug}/${source.slug}`}
                  className="block bg-white dark:bg-stone-900 border border-stone-200 dark:border-stone-800 rounded-lg p-4 hover:border-stone-300 dark:hover:border-stone-600 transition-colors"
                >
                  <div className="flex items-center justify-between">
                    <span className="font-semibold text-[15px] text-stone-900 dark:text-stone-100">
                      {source.name}
                    </span>
                    <SourceTypeIcon type={source.type} />
                  </div>
                  {source.url && (
                    <div className="text-xs text-stone-400 dark:text-stone-500 mt-1">
                      {source.url}
                    </div>
                  )}
                </Link>
              ))}
            </div>
          </div>
          <Sidebar
            sections={sidebarSections}
            formatPath={`/${orgSlug}/product/${productSlug}`}
          />
        </div>
      </div>
    </div>
  );
}
```

- [ ] **Step 2: Verify type-check passes**

Run: `cd /Users/zachdunn/Code/released && npx tsc --noEmit`
Expected: PASS

- [ ] **Step 3: Verify the page renders**

Start the dev server and navigate to an org that has products. Confirm the product detail page loads at `/:orgSlug/product/:productSlug`.

- [ ] **Step 4: Commit**

```bash
git add web/src/app/[orgSlug]/product/[productSlug]/page.tsx
git commit -m "feat(web): add product detail page"
```

---

### Task 6: Show product badge on source cards (optional visual refinement)

When a source belongs to a product and is displayed outside the product context (e.g., in search results or the independent sources list), show the product name as a subtle badge.

**Files:**
- Modify: `web/src/components/source-card.tsx`

- [ ] **Step 1: Add product badge to SourceCard**

In `web/src/components/source-card.tsx`, add a product name badge next to the source name, after the "Primary" badge (line 90-92):

```tsx
{source.productName && (
  <span className="text-[10px] font-medium text-stone-400 dark:text-stone-500 bg-stone-50 dark:bg-stone-800 px-1.5 py-0.5 rounded">
    {source.productName}
  </span>
)}
```

This badge only renders when `productName` is present on the source — which happens when the API populates it (after Task 3, step 1a).

- [ ] **Step 2: Verify type-check passes**

Run: `cd /Users/zachdunn/Code/released && npx tsc --noEmit`
Expected: PASS

- [ ] **Step 3: Commit**

```bash
git add web/src/components/source-card.tsx
git commit -m "feat(web): show product name badge on source cards"
```
