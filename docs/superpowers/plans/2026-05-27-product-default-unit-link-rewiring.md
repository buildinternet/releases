# Product-Default-Unit Link Rewiring (Phase 2) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** When an entity belongs to a product, default navigation (org page rows, the `/sources` table, search catalog hits, search release-hit bylines) points at the product page `/[org]/product/[slug]` instead of the individual source page.

**Architecture:** A new pure helper module (`web/src/lib/links.ts`) centralizes product/source path construction and becomes the single seam for the future namespace flip. Web render sites that already receive `productSlug` on the wire switch to the helper (no API change). Search release-hit bylines need `productSlug` threaded through one SQL SELECT, the raw-row interface, the wire schema, and the hydrator. Search _catalog_ hits already collapse product-member sources via `foldSourcesIntoCatalog` — that path gets a regression test only.

**Tech stack:** TypeScript (strict), Next.js (web), Hono + Cloudflare D1/Drizzle (API worker), Zod (wire schemas), `bun test`. `@buildinternet/releases-api-types` resolves to source (`web/tsconfig.json` maps it to `../packages/api-types/src/api-types.ts`), so wire-schema edits need no build step.

**Spec:** `docs/superpowers/specs/2026-05-27-product-default-unit-link-rewiring-design.md`

---

## File structure

- **Create** `web/src/lib/links.ts` — pure path builders (`productPath`, `sourcePath`, `sourceOrProductPath`).
- **Create** `web/src/lib/links.test.ts` — unit tests for the helpers.
- **Create** `packages/api-types/test/fold-sources-catalog.test.ts` — regression guard for the existing catalog collapse.
- **Create** `workers/api/test/search-release-product-slug.test.ts` — TDD test for `productSlug` on release rows + hydrator forwarding.
- **Modify** `web/src/components/product-grid.tsx` — use `productPath`.
- **Modify** `web/src/components/search-results.tsx` — catalog href + `chunkDeepLink` via helpers; release byline via `sourceOrProductPath`; thread `productSlug` into `ResultCard`.
- **Modify** `web/src/components/source-card.tsx` — href via `sourceOrProductPath`.
- **Modify** `web/src/components/source-table.tsx` — source-name link + product column via helpers.
- **Modify** `web/src/components/release-timeline.tsx` — product-group `<h3>` becomes a link.
- **Modify** `packages/api-types/src/schemas/search.ts` — add optional `productSlug` to `SearchReleaseHitSchema`.
- **Modify** `workers/api/src/queries/search.ts` — add `productSlug` to `RawSearchReleaseRow` + `p.slug as productSlug` in both release SELECTs.
- **Modify** `workers/api/src/routes/search.ts` — forward `productSlug` in `hydrateReleaseHit`; export it for the test.

---

## Task 1: Shared link helpers

**Files:**

- Create: `web/src/lib/links.ts`
- Test: `web/src/lib/links.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// web/src/lib/links.test.ts
import { describe, it, expect } from "bun:test";
import { productPath, sourcePath, sourceOrProductPath } from "./links";

describe("link helpers", () => {
  it("productPath builds an org-scoped product URL", () => {
    expect(productPath("vercel", "nextjs")).toBe("/vercel/product/nextjs");
  });

  it("productPath falls back to the bare product path without an org", () => {
    expect(productPath(null, "nextjs")).toBe("/product/nextjs");
  });

  it("sourcePath builds an org-scoped source URL", () => {
    expect(sourcePath("vercel", "next-js")).toBe("/vercel/next-js");
  });

  it("sourcePath falls back to the global source path without an org", () => {
    expect(sourcePath(null, "next-js")).toBe("/source/next-js");
  });

  it("sourceOrProductPath prefers the product when productSlug is present", () => {
    expect(
      sourceOrProductPath({ orgSlug: "vercel", sourceSlug: "next-js", productSlug: "nextjs" }),
    ).toBe("/vercel/product/nextjs");
  });

  it("sourceOrProductPath falls back to the source when there is no product", () => {
    expect(
      sourceOrProductPath({ orgSlug: "vercel", sourceSlug: "next-js", productSlug: null }),
    ).toBe("/vercel/next-js");
    expect(sourceOrProductPath({ orgSlug: "vercel", sourceSlug: "next-js" })).toBe(
      "/vercel/next-js",
    );
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test web/src/lib/links.test.ts`
Expected: FAIL — `Cannot find module './links'`.

- [ ] **Step 3: Write the implementation**

```ts
// web/src/lib/links.ts
/**
 * Public URL builders for org / product / source pages.
 *
 * This module is the single seam for the planned namespace flip (product-first
 * resolution on the bare `/[org]/[slug]` path — see the Phase 2 design doc's
 * "Long-term" section). When that lands, `productPath` changes to emit
 * `/${orgSlug}/${productSlug}` and a 308 is added from the prefixed form;
 * nothing else in the web tree needs to move.
 */

/** Canonical product page URL. `orgSlug` is nullable to serve search catalog
 *  hits, which may lack an org (rare); those fall back to the bare form. */
export function productPath(orgSlug: string | null, productSlug: string): string {
  return orgSlug ? `/${orgSlug}/product/${productSlug}` : `/product/${productSlug}`;
}

/** Source detail page URL. Falls back to the global `/source/:slug` redirect
 *  shim when the org isn't known. */
export function sourcePath(orgSlug: string | null, sourceSlug: string): string {
  return orgSlug ? `/${orgSlug}/${sourceSlug}` : `/source/${sourceSlug}`;
}

/** Where a source row should link: the product page when the source belongs to
 *  a product, otherwise the source page. */
export function sourceOrProductPath(args: {
  orgSlug: string | null;
  sourceSlug: string;
  productSlug?: string | null;
}): string {
  return args.productSlug
    ? productPath(args.orgSlug, args.productSlug)
    : sourcePath(args.orgSlug, args.sourceSlug);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test web/src/lib/links.test.ts`
Expected: PASS (6 tests).

- [ ] **Step 5: Commit**

```bash
git add web/src/lib/links.ts web/src/lib/links.test.ts
git commit -m "feat(web): shared product/source link helpers"
```

---

## Task 2: Regression guard for catalog collapse

`foldSourcesIntoCatalog` already collapses product-member sources into product
entries (product wins; orphans stay sources). This is a characterization test
that locks that behavior — it passes immediately (no red phase); its job is to
fail if a future edit regresses the collapse.

**Files:**

- Test: `packages/api-types/test/fold-sources-catalog.test.ts`

- [ ] **Step 1: Write the test**

```ts
// packages/api-types/test/fold-sources-catalog.test.ts
import { describe, it, expect } from "bun:test";
import { foldSourcesIntoCatalog, type RawSourceHit } from "../src/api-types";

const src = (over: Partial<RawSourceHit>): RawSourceHit => ({
  slug: "s",
  name: "S",
  type: "github",
  orgSlug: "acme",
  orgName: "Acme",
  productSlug: null,
  ...over,
});

describe("foldSourcesIntoCatalog", () => {
  it("drops a product-member source when its product is already present", () => {
    const result = foldSourcesIntoCatalog(
      [
        {
          slug: "x",
          name: "Product X",
          orgSlug: "acme",
          orgName: "Acme",
          category: null,
          entryType: "product",
        },
      ],
      [src({ slug: "x-feed", name: "X Feed", productSlug: "x", productName: "Product X" })],
    );
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({ slug: "x", entryType: "product" });
    expect(result.some((r) => r.entryType === "source" && r.sourceSlug === "x-feed")).toBe(false);
  });

  it("promotes a product-member source to a product entry when the product is absent", () => {
    const result = foldSourcesIntoCatalog(
      [],
      [src({ slug: "y-feed", name: "Y Feed", productSlug: "y", productName: "Product Y" })],
    );
    expect(result).toEqual([
      {
        slug: "y",
        name: "Product Y",
        orgSlug: "acme",
        orgName: "Acme",
        category: null,
        entryType: "product",
        kind: undefined,
      },
    ]);
  });

  it("keeps an orphan source (no productSlug) as a source entry", () => {
    const result = foldSourcesIntoCatalog(
      [],
      [src({ slug: "blog", name: "Blog", productSlug: null })],
    );
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({ slug: "blog", entryType: "source", sourceSlug: "blog" });
  });
});
```

- [ ] **Step 2: Run the test**

Run: `bun test packages/api-types/test/fold-sources-catalog.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 3: Commit**

```bash
git add packages/api-types/test/fold-sources-catalog.test.ts
git commit -m "test(api-types): lock foldSourcesIntoCatalog product collapse"
```

---

## Task 3: Rewire web render sites (data already on the wire)

These components already receive `productSlug` (`SourceListItem`/`SourceWithOrg`)
or build product/source URLs inline. They switch to the Task 1 helpers. Logic is
covered by the helper unit tests; correctness here is verified by `tsc` plus a
grep confirming the inline literals are gone (no React render-test harness exists
in this repo — web tests are pure-lib only).

**Files:**

- Modify: `web/src/components/product-grid.tsx`
- Modify: `web/src/components/source-card.tsx`
- Modify: `web/src/components/source-table.tsx`
- Modify: `web/src/components/release-timeline.tsx`
- Modify: `web/src/components/search-results.tsx` (catalog block + `chunkDeepLink` only; byline is Task 4)

- [ ] **Step 1: product-grid.tsx — use `productPath`**

Add the import after the existing imports (line 1-2 area):

```ts
import { productPath } from "@/lib/links";
```

Replace line 27:

```tsx
            href={`/${orgSlug}/product/${p.slug}`}
```

with:

```tsx
            href={productPath(orgSlug, p.slug)}
```

- [ ] **Step 2: source-card.tsx — href via `sourceOrProductPath`**

Add to imports (top of file, after the `next/link` import on line 1):

```ts
import { sourceOrProductPath } from "@/lib/links";
```

Replace line 148:

```tsx
const href = orgSlug ? `/${orgSlug}/${source.slug}` : `/source/${source.slug}`;
```

with:

```tsx
const href = sourceOrProductPath({
  orgSlug: orgSlug ?? null,
  sourceSlug: source.slug,
  productSlug: source.productSlug,
});
```

- [ ] **Step 3: source-table.tsx — name link + product column via helpers**

Add to imports (after line 1 `import Link from "next/link";`):

```ts
import { productPath, sourceOrProductPath } from "@/lib/links";
```

Replace the source-name link (lines 135-137):

```tsx
<Link
  href={`/${orgSlug}/${source.slug}`}
  className="text-stone-800 dark:text-stone-200 font-medium hover:text-stone-900 dark:hover:text-stone-100 truncate min-w-0"
>
  {source.name}
</Link>
```

with:

```tsx
<Link
  href={sourceOrProductPath({
    orgSlug,
    sourceSlug: source.slug,
    productSlug: source.productSlug,
  })}
  className="text-stone-800 dark:text-stone-200 font-medium hover:text-stone-900 dark:hover:text-stone-100 truncate min-w-0"
>
  {source.name}
</Link>
```

Replace the product column cell body (line 157):

```tsx
{
  source.productSlug ? (productMap.get(source.productSlug) ?? "—") : "—";
}
```

with:

```tsx
{
  source.productSlug ? (
    <Link
      href={productPath(orgSlug, source.productSlug)}
      className="hover:text-stone-700 dark:hover:text-stone-300"
    >
      {productMap.get(source.productSlug) ?? source.productSlug}
    </Link>
  ) : (
    "—"
  );
}
```

- [ ] **Step 4: release-timeline.tsx — product-group header becomes a link**

`Link` and `orgSlug` are already in scope in `ProductGroupedSources`. Add the
helper import alongside the existing imports (top of file):

```ts
import { productPath } from "@/lib/links";
```

Replace the product header (lines 131-133):

```tsx
<h3 className="text-sm font-semibold text-stone-700 dark:text-stone-300 mb-2">{product.name}</h3>
```

with:

```tsx
<h3 className="text-sm font-semibold text-stone-700 dark:text-stone-300 mb-2">
  <Link href={productPath(orgSlug, product.slug)} className="hover:underline">
    {product.name}
  </Link>
</h3>
```

(The source cards under this header already route via `SourceCard` → Step 2, so
they inherit the product link automatically.)

- [ ] **Step 5: search-results.tsx — catalog href + chunkDeepLink via helpers**

Add the helper import next to the other `@/lib` imports (e.g. after line 54
`import { formatDate } from "@/lib/formatters";`):

```ts
import { productPath, sourcePath } from "@/lib/links";
```

Replace the local `sourceHref` (lines 93-95):

```ts
function sourceHref(orgSlug: string | null, sourceSlug: string): string {
  return orgSlug ? `/${orgSlug}/${sourceSlug}` : `/source/${sourceSlug}`;
}
```

with (delete it — `chunkDeepLink` will call `sourcePath` directly):

```ts
// (removed: replaced by sourcePath from "@/lib/links")
```

Update `chunkDeepLink` (line 105) from:

```ts
const base = sourceHref(hit.orgSlug, hit.sourceSlug);
```

to:

```ts
const base = sourcePath(hit.orgSlug, hit.sourceSlug);
```

Replace the catalog href ternary (lines 482-489):

```tsx
const href =
  p.entryType === "source" && p.sourceSlug
    ? p.orgSlug
      ? `/${p.orgSlug}/${p.sourceSlug}`
      : `/source/${p.sourceSlug}`
    : p.orgSlug
      ? `/${p.orgSlug}/product/${p.slug}`
      : `/product/${p.slug}`;
```

with:

```tsx
const href =
  p.entryType === "source" && p.sourceSlug
    ? sourcePath(p.orgSlug, p.sourceSlug)
    : productPath(p.orgSlug, p.slug);
```

- [ ] **Step 6: Type-check + lint + verify literals are gone**

Run: `cd web && npx tsc --noEmit`
Expected: no errors.

Run (from repo root): `bun run lint`
Expected: no new errors.

Run: `grep -nE "\\\`/\\\$\{orgSlug\}/\\\$\{source" web/src/components/source-card.tsx web/src/components/source-table.tsx web/src/components/release-timeline.tsx`
Expected: no matches (inline source literals replaced).

- [ ] **Step 7: Commit**

```bash
git add web/src/components/product-grid.tsx web/src/components/source-card.tsx web/src/components/source-table.tsx web/src/components/release-timeline.tsx web/src/components/search-results.tsx
git commit -m "feat(web): point product-member source rows + catalog hits at product pages"
```

---

## Task 4: Release-hit `productSlug` (SQL + wire + hydrate + byline)

**Files:**

- Test: `workers/api/test/search-release-product-slug.test.ts`
- Modify: `workers/api/src/queries/search.ts`
- Modify: `packages/api-types/src/schemas/search.ts`
- Modify: `workers/api/src/routes/search.ts`
- Modify: `web/src/components/search-results.tsx`

- [ ] **Step 1: Write the failing test**

```ts
// workers/api/test/search-release-product-slug.test.ts
import { describe, it, expect, beforeEach } from "bun:test";
import { Database } from "bun:sqlite";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { applyMigrations, makeD1Shim } from "../../../tests/db-helper";
import { organizations, products, sources, releases } from "@buildinternet/releases-core/schema";
import { searchReleasesFromMatchedEntities } from "../src/queries/search.js";
import { hydrateReleaseHit } from "../src/routes/search.js";

describe("release-hit productSlug", () => {
  let d1: D1Database;

  beforeEach(async () => {
    const sqlite = new Database(":memory:");
    const db = drizzle(sqlite);
    applyMigrations(sqlite);
    d1 = makeD1Shim(sqlite);

    await db
      .insert(organizations)
      .values({ id: "org_a", slug: "acme", name: "Acme", category: "cloud" });
    await db
      .insert(products)
      .values({ id: "prod_x", slug: "x", name: "Product X", orgId: "org_a" });
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
        id: "rel_orphan",
        sourceId: "src_orphan",
        title: "Blog post",
        content: "b",
        url: "https://acme.test/blog/1",
        publishedAt: "2026-04-21T00:00:00Z",
      },
    ]);
  });

  it("selects productSlug for a release whose source belongs to a product", async () => {
    const rows = await searchReleasesFromMatchedEntities(d1, ["acme"], [], 50);
    expect(rows.find((r) => r.id === "rel_x")?.productSlug).toBe("x");
  });

  it("leaves productSlug null for an orphan source's release", async () => {
    const rows = await searchReleasesFromMatchedEntities(d1, ["acme"], [], 50);
    expect(rows.find((r) => r.id === "rel_orphan")?.productSlug ?? null).toBeNull();
  });

  it("hydrateReleaseHit forwards productSlug to the wire shape", async () => {
    const rows = await searchReleasesFromMatchedEntities(d1, ["acme"], [], 50);
    const raw = rows.find((r) => r.id === "rel_x")!;
    const hit = hydrateReleaseHit(raw, "https://media.releases.sh");
    expect(hit.productSlug).toBe("x");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test workers/api/test/search-release-product-slug.test.ts`
Expected: FAIL — `productSlug` is `undefined` (not selected; `hydrateReleaseHit` is also not yet exported, which may surface as an import error — both are fixed below).

- [ ] **Step 3: Add `productSlug` to `RawSearchReleaseRow`**

In `workers/api/src/queries/search.ts`, inside the `RawSearchReleaseRow` interface, add after `orgName` (line 32):

```ts
orgName: string | null;
/** Owning product's slug (COALESCE target for product-aware byline links); null for orphan sources. */
productSlug: string | null;
```

- [ ] **Step 4: Select `p.slug as productSlug` in both release queries**

In `searchReleasesFts` (the SELECT starting line 156), add `p.slug as productSlug,`
on the `o.slug ... orgName` line so it reads:

```sql
           o.slug as orgSlug, o.name as orgName, p.slug as productSlug,
```

Make the identical edit in `searchReleasesFromMatchedEntities` (the SELECT
starting line 209) — same line:

```sql
           o.slug as orgSlug, o.name as orgName, p.slug as productSlug,
```

(Both queries already have `LEFT JOIN products_active p ON p.id = s.product_id`, so no JOIN change is needed.)

- [ ] **Step 5: Add the wire field**

In `packages/api-types/src/schemas/search.ts`, inside `SearchReleaseHitSchema`,
add after the `orgName` line (line 70):

```ts
  orgName: z.string().nullable().optional(),
  /** Owning product slug — present when the source belongs to a product. Lets
   *  the web byline link to the product page instead of the source. */
  productSlug: z.string().nullable().optional(),
```

- [ ] **Step 6: Forward `productSlug` in `hydrateReleaseHit` and export it**

In `workers/api/src/routes/search.ts`, change the function signature (line 78)
from `function hydrateReleaseHit(` to `export function hydrateReleaseHit(`.

In its return object, add after `orgName: row.orgName,` (line 103):

```ts
    orgName: row.orgName,
    productSlug: row.productSlug ?? null,
```

- [ ] **Step 7: Run the API test to verify it passes**

Run: `bun test workers/api/test/search-release-product-slug.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 8: Rewire the release byline in search-results.tsx**

`sourceOrProductPath` is imported in Task 3 Step 5 (verify the import line
includes it; if not, add it):

```ts
import { productPath, sourcePath, sourceOrProductPath } from "@/lib/links";
```

Add a `productSlug` field to the `ResultCard` props type (the inline param
object around lines 195-204) after `orgSlug`:

```ts
  orgSlug: string | null;
  productSlug?: string | null;
```

Replace the byline source link (lines 234-240):

```tsx
        {orgSlug ? (
          <Link
            href={`/${orgSlug}/${sourceSlug}`}
            className="text-stone-500 dark:text-stone-400 font-medium hover:text-stone-700 dark:hover:text-stone-300"
          >
            <Highlight text={sourceName} tokens={tokens} />
          </Link>
        ) : (
```

with:

```tsx
        {orgSlug ? (
          <Link
            href={sourceOrProductPath({ orgSlug, sourceSlug, productSlug })}
            className="text-stone-500 dark:text-stone-400 font-medium hover:text-stone-700 dark:hover:text-stone-300"
          >
            <Highlight text={sourceName} tokens={tokens} />
          </Link>
        ) : (
```

In `ReleaseResultCard`, pass the new prop (in the `<ResultCard ...>` props,
after `orgSlug={hit.orgSlug}` on line 309):

```tsx
      orgSlug={hit.orgSlug}
      productSlug={hit.productSlug ?? null}
```

(Leave `ChunkResultCard` unchanged — chunk hits carry no product and stay
source-scoped; `productSlug` defaults to `undefined` → byline uses `sourcePath`.)

- [ ] **Step 9: Type-check web + api**

Run: `cd web && npx tsc --noEmit`
Expected: no errors (`hit.productSlug` resolves via the source-mapped api-types).

Run: `cd workers/api && npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 10: Commit**

```bash
git add workers/api/src/queries/search.ts packages/api-types/src/schemas/search.ts workers/api/src/routes/search.ts workers/api/test/search-release-product-slug.test.ts web/src/components/search-results.tsx
git commit -m "feat(search): product-aware release-hit bylines (add productSlug to release hits)"
```

---

## Task 5: Full verification gate

**Files:** none (verification only).

- [ ] **Step 1: Root type-check**

Run (repo root): `npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 2: Lint + format**

Run: `bun run lint`
Expected: no errors.

Run: `bun run format:check`
Expected: pass (run `bun run format` if it flags the new/edited files, then re-commit).

- [ ] **Step 3: Full test suite**

Run: `bun test`
Expected: all pass, including the three new files
(`web/src/lib/links.test.ts`, `packages/api-types/test/fold-sources-catalog.test.ts`,
`workers/api/test/search-release-product-slug.test.ts`).

- [ ] **Step 4: Final review of the diff**

Run: `git log --oneline main..HEAD` and `git diff main --stat`
Expected: 4 feature/test commits (Tasks 1–4) atop the spec commit; touched files match the File-structure list.

---

## Self-review notes

- **Spec coverage:** Unit 1 (helpers) → Task 1; Unit 2 (web rows) → Task 3; Unit 3 (release bylines, API+wire) → Task 4; "already works" catalog collapse → Task 2 regression guard. Out-of-scope items (release detail, chunk deep-links, org hits, MCP) are untouched — chunk deep-links explicitly preserved via `sourcePath` in Task 3 Step 5.
- **Type consistency:** helper names (`productPath`, `sourcePath`, `sourceOrProductPath`) match across Tasks 1/3/4; `productSlug` is the single field name used in `RawSearchReleaseRow`, `SearchReleaseHitSchema`, `hydrateReleaseHit`, and the byline prop. `productPath`/`sourcePath` take `orgSlug: string | null` (the spec's `string` signature was illustrative; nullable is required for the search-catalog no-org fallback).
- **No schema/migration impact:** only a SELECT column and a Zod field change — no `schema.ts` edit, so the migration-pairing CI gate doesn't apply.
