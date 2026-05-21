# SDK Grouping on the Org Sources Page — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fold an org's SDK-kind sources into one collapsible, default-collapsed group at the bottom of the `/sources` active list so per-language SDK churn stops burying the primary changelog.

**Architecture:** A small additive API change emits each source's own `kind` and each product's `kind` on the `GET /v1/orgs/:slug` payload (the columns exist and are backfilled; the handler just discards them today). The web `SourceTable` then partitions sources via a pure helper (`resolveSourceKind` + a `productSlug→kind` map, ≥2 threshold) and renders the SDK family inside a `"use client"` collapsible block that mirrors the existing `inactive-sources-toggle.tsx` disclosure idiom.

**Tech Stack:** TypeScript, Bun, Drizzle/D1 (Hono worker `workers/api`), Next.js 16 + React 19 (`web/`), `bun test`.

**Spec:** `docs/superpowers/specs/2026-05-21-sdk-grouping-org-sources-design.md`

---

### Task 1: Worktree setup + baseline

**Files:** none (environment only)

- [ ] **Step 1: Install deps in the worktree**

A fresh worktree has no `node_modules`; package imports silently resolve against the main checkout until you install here.

Run: `bun install`
Expected: completes; `node_modules/` now present in the worktree root.

- [ ] **Step 2: Baseline the existing API test file**

Run: `bun test tests/api/source-kind-read.test.ts`
Expected: PASS (this is the file Task 2 extends).

---

### Task 2: Emit `kind` on the org-detail payload (API)

**Files:**

- Modify: `workers/api/src/queries/shared.ts` (the `SourceWithStats` type)
- Modify: `workers/api/src/queries/orgs.ts:94` (`getOrgSourcesWithStats` SELECT)
- Modify: `workers/api/src/routes/orgs.ts:49` (import), `:273` (products query), `:352` (sources map)
- Modify: `packages/api-types/src/schemas/orgs.ts:113` (`OrgDetailProductSchema`)
- Test: `tests/api/source-kind-read.test.ts`

- [ ] **Step 1: Write the failing test**

Append this block to the end of `tests/api/source-kind-read.test.ts` (the file already imports `organizations, products, sources` from `@buildinternet/releases-core/schema`, and defines `callOrg`, `seedOrg`, `testDb`):

```ts
describe("kind on org detail", () => {
  it("GET /v1/orgs/:slug emits kind on sources and products", async () => {
    await seedOrg();
    await testDb.db.insert(products).values({
      id: "prod_sdk",
      name: "Acme SDK",
      slug: "acme-sdk",
      orgId: "org_acme",
      kind: "sdk",
    });
    await testDb.db.insert(sources).values([
      {
        id: "src_own",
        name: "acme-js",
        slug: "acme-js",
        orgId: "org_acme",
        type: "github",
        url: "https://github.com/acme/js",
        kind: "sdk",
      },
      {
        id: "src_inherit",
        name: "acme-py",
        slug: "acme-py",
        orgId: "org_acme",
        type: "github",
        url: "https://github.com/acme/py",
        productId: "prod_sdk",
      },
    ]);

    const res = await callOrg("/orgs/acme");
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      sources: Array<{ slug: string; kind: string | null }>;
      products: Array<{ slug: string; kind: string | null }>;
    };

    // Source's own kind is emitted verbatim…
    expect(body.sources.find((s) => s.slug === "acme-js")?.kind).toBe("sdk");
    // …and a source with no own kind stays null on the wire (the web applies
    // source→product inheritance using the product's kind below).
    expect(body.sources.find((s) => s.slug === "acme-py")?.kind ?? null).toBeNull();
    // Product kind is emitted so the web can do that inheritance.
    expect(body.products.find((p) => p.slug === "acme-sdk")?.kind).toBe("sdk");
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `bun test tests/api/source-kind-read.test.ts -t "emits kind on sources and products"`
Expected: FAIL — `body.sources[].kind` and `body.products[].kind` are `undefined` (handler drops them).

- [ ] **Step 3: Add `kind` to the `SourceWithStats` type**

In `workers/api/src/queries/shared.ts`, in the `SourceWithStats` type, add a `kind` field after `product_name`:

```ts
  product_slug: string | null;
  product_name: string | null;
  kind: string | null;
};
```

- [ ] **Step 4: Select `s.kind` in the org-sources query**

In `workers/api/src/queries/orgs.ts`, in `getOrgSourcesWithStats`, add `s.kind` to the SELECT list. Change:

```ts
      s.id, s.slug, s.name, s.type, s.url, s.is_primary, s.is_hidden, s.discovery, s.fetch_priority,
      s.last_fetched_at, s.last_polled_at,
      p.slug AS product_slug, p.name AS product_name,
```

to:

```ts
      s.id, s.slug, s.name, s.type, s.url, s.is_primary, s.is_hidden, s.discovery, s.fetch_priority,
      s.last_fetched_at, s.last_polled_at, s.kind,
      p.slug AS product_slug, p.name AS product_name,
```

- [ ] **Step 5: Copy `kind` into the sources map + import the `Kind` type**

In `workers/api/src/routes/orgs.ts`, extend the kinds import (line 49):

```ts
import { parseKindParam, KIND_VALUES, type Kind } from "@buildinternet/releases-core/kinds";
```

Then in the `sourcesWithStats` map, add `kind` after `productName`:

```ts
      productSlug: row.product_slug ?? null,
      productName: row.product_name ?? null,
      kind: (row.kind ?? null) as Kind | null,
    }));
```

- [ ] **Step 6: Select `kind` in the org-detail products query**

In `workers/api/src/routes/orgs.ts`, in the org-detail products `.select({...})` (around line 273), add `kind`:

```ts
        .select({
          id: productsActive.id,
          slug: productsActive.slug,
          name: productsActive.name,
          url: productsActive.url,
          description: productsActive.description,
          kind: productsActive.kind,
          sourceCount: sql<number>`(SELECT COUNT(*) FROM sources_active s WHERE s.product_id = products_active.id)`,
        })
```

- [ ] **Step 7: Add `kind` to `OrgDetailProductSchema`**

In `packages/api-types/src/schemas/orgs.ts`, add `kind: true` to the `.pick(...)` (around line 113):

```ts
const OrgDetailProductSchema = ProductListItemSchema.pick({
  id: true,
  slug: true,
  name: true,
  url: true,
  description: true,
  sourceCount: true,
  kind: true,
});
```

- [ ] **Step 8: Run the test to verify it passes**

Run: `bun test tests/api/source-kind-read.test.ts`
Expected: PASS (the new test + all pre-existing ones).

- [ ] **Step 9: Typecheck the worker + api-types**

Run: `cd workers/api && bunx tsc --noEmit && cd ../..`
Expected: no errors. (`productsActive.kind` resolves; the `as Kind` cast typechecks.)

- [ ] **Step 10: Commit**

```bash
git add workers/api/src/queries/shared.ts workers/api/src/queries/orgs.ts workers/api/src/routes/orgs.ts packages/api-types/src/schemas/orgs.ts tests/api/source-kind-read.test.ts
git commit -m "feat(api): emit kind on org-detail sources + products (#1080)"
```

---

### Task 3: Pure partition helper (web)

**Files:**

- Create: `web/src/lib/sdk-grouping.ts`
- Test: `tests/unit/sdk-grouping.test.ts`

- [ ] **Step 1: Write the failing test**

Create `tests/unit/sdk-grouping.test.ts`:

```ts
import { describe, expect, test } from "bun:test";
import { partitionSdkSources, sdkPreview, SDK_GROUP_MIN } from "../../web/src/lib/sdk-grouping";

type S = {
  slug: string;
  name: string;
  releaseCount: number;
  kind?: "platform" | "sdk" | "tool" | null;
  productSlug?: string | null;
};
const s = (o: Partial<S> & { slug: string }): S => ({
  name: o.slug,
  releaseCount: 0,
  kind: null,
  productSlug: null,
  ...o,
});

describe("partitionSdkSources", () => {
  test("groups sources whose own kind is sdk (>= threshold)", () => {
    const { flat, sdk } = partitionSdkSources(
      [
        s({ slug: "a", kind: "sdk" }),
        s({ slug: "b", kind: "sdk" }),
        s({ slug: "p", kind: "platform" }),
      ],
      [],
    );
    expect(sdk.map((x) => x.slug)).toEqual(["a", "b"]);
    expect(flat.map((x) => x.slug)).toEqual(["p"]);
  });

  test("inherits sdk from parent product when source kind is null", () => {
    const { sdk } = partitionSdkSources(
      [s({ slug: "a", productSlug: "lib" }), s({ slug: "b", productSlug: "lib" })],
      [{ slug: "lib", kind: "sdk" }],
    );
    expect(sdk.map((x) => x.slug)).toEqual(["a", "b"]);
  });

  test("below threshold leaves everything flat", () => {
    const { flat, sdk } = partitionSdkSources(
      [s({ slug: "a", kind: "sdk" }), s({ slug: "p", kind: "platform" })],
      [],
    );
    expect(sdk).toEqual([]);
    expect(flat.map((x) => x.slug)).toEqual(["a", "p"]);
  });

  test("source's own kind wins over its product's kind", () => {
    const { sdk, flat } = partitionSdkSources(
      [
        s({ slug: "a", kind: "sdk", productSlug: "plat" }),
        s({ slug: "b", kind: "sdk", productSlug: "plat" }),
      ],
      [{ slug: "plat", kind: "platform" }],
    );
    expect(sdk.map((x) => x.slug)).toEqual(["a", "b"]);
    expect(flat).toEqual([]);
  });

  test("SDK_GROUP_MIN is 2", () => {
    expect(SDK_GROUP_MIN).toBe(2);
  });
});

describe("sdkPreview", () => {
  test("orders members by release count desc, joined with ' · '", () => {
    expect(
      sdkPreview([
        { name: "py", releaseCount: 5 },
        { name: "js", releaseCount: 10 },
        { name: "go", releaseCount: 1 },
      ]),
    ).toBe("js · py · go");
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `bun test tests/unit/sdk-grouping.test.ts`
Expected: FAIL — cannot resolve `../../web/src/lib/sdk-grouping` (module not created yet).

- [ ] **Step 3: Write the helper**

Create `web/src/lib/sdk-grouping.ts`:

```ts
import { resolveSourceKind, type Kind } from "@buildinternet/releases-core/kinds";

/** Minimum resolved-SDK sources before they fold into a collapsible group. */
export const SDK_GROUP_MIN = 2;

type KindBearer = { kind?: Kind | null };

/**
 * Split an org's sources into the SDK family vs. everything else.
 *
 * A source is "SDK" when its resolved kind — its own `kind`, else the parent
 * product's `kind` (via `resolveSourceKind`) — is `"sdk"`. Below
 * `SDK_GROUP_MIN` resolved SDKs, returns everything in `flat` with an empty
 * `sdk` so the caller renders no group.
 */
export function partitionSdkSources<S extends KindBearer & { productSlug?: string | null }>(
  sources: readonly S[],
  products: readonly ({ slug: string } & KindBearer)[],
): { flat: S[]; sdk: S[] } {
  const productBySlug = new Map(products.map((p) => [p.slug, p]));
  const sdk: S[] = [];
  const flat: S[] = [];
  for (const source of sources) {
    const product = source.productSlug ? (productBySlug.get(source.productSlug) ?? null) : null;
    if (resolveSourceKind(source, product) === "sdk") sdk.push(source);
    else flat.push(source);
  }
  if (sdk.length < SDK_GROUP_MIN) return { flat: [...sources], sdk: [] };
  return { flat, sdk };
}

/** Comma-separated member preview for the collapsed SDK header, busiest first. */
export function sdkPreview(sdk: readonly { name: string; releaseCount: number }[]): string {
  return [...sdk]
    .sort((a, b) => b.releaseCount - a.releaseCount)
    .map((member) => member.name)
    .join(" · ");
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `bun test tests/unit/sdk-grouping.test.ts`
Expected: PASS (6 tests).

- [ ] **Step 5: Commit**

```bash
git add web/src/lib/sdk-grouping.ts tests/unit/sdk-grouping.test.ts
git commit -m "feat(web): add SDK source partition helper (#1080)"
```

---

### Task 4: `SdkSourceGroup` collapsible component (web)

**Files:**

- Create: `web/src/components/sdk-source-group.tsx`

No unit test: the repo has no React test runner (RTL/jsdom). Rendering is verified by typecheck here and the manual browser check in Task 6. The component is deliberately a thin disclosure shell with no logic beyond open/closed state.

- [ ] **Step 1: Write the component**

Create `web/src/components/sdk-source-group.tsx`. The chevron SVG + `rotate-90` transition mirror `web/src/components/inactive-sources-toggle.tsx` (no Unicode caret / emoji — see the project's no-emoji-in-UI rule):

```tsx
"use client";

import { useState } from "react";

/**
 * Collapsible "SDKs" block for the org sources table. Renders a full-width
 * subheading row (its own `<tr>`) with a disclosure toggle; when open, renders
 * the SDK member rows passed as `children`. Mirrors the disclosure idiom in
 * `inactive-sources-toggle.tsx`.
 */
export function SdkSourceGroup({
  colSpan,
  count,
  preview,
  children,
}: {
  colSpan: number;
  count: number;
  preview: string;
  children: React.ReactNode;
}) {
  const [open, setOpen] = useState(false);

  return (
    <>
      <tr className="bg-stone-50/60 dark:bg-stone-900/40">
        <td colSpan={colSpan} className="px-3 py-2">
          <button
            type="button"
            onClick={() => setOpen((o) => !o)}
            aria-expanded={open}
            aria-label={`${open ? "Collapse" : "Expand"} ${count} SDK ${count === 1 ? "source" : "sources"}`}
            className="flex items-center gap-2 w-full text-left text-stone-600 dark:text-stone-300 hover:text-stone-900 dark:hover:text-stone-100 transition-colors"
          >
            <svg
              className={`w-3 h-3 shrink-0 transition-transform ${open ? "rotate-90" : ""}`}
              fill="none"
              viewBox="0 0 24 24"
              stroke="currentColor"
              strokeWidth={2}
              aria-hidden="true"
            >
              <path strokeLinecap="round" strokeLinejoin="round" d="M9 5l7 7-7 7" />
            </svg>
            <span className="text-[13px] font-semibold">SDKs</span>
            {!open && preview && (
              <span className="flex-1 min-w-0 truncate text-[12px] text-stone-400 dark:text-stone-500">
                {preview}
              </span>
            )}
          </button>
        </td>
      </tr>
      {open && children}
    </>
  );
}
```

- [ ] **Step 2: Typecheck**

Run: `cd web && bunx tsc --noEmit && cd ..`
Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add web/src/components/sdk-source-group.tsx
git commit -m "feat(web): add SdkSourceGroup collapsible block (#1080)"
```

---

### Task 5: Wire grouping into `SourceTable` (web)

**Files:**

- Modify: `web/src/components/source-table.tsx`

- [ ] **Step 1: Add imports**

At the top of `web/src/components/source-table.tsx`, after the existing imports (lines 1-4), add:

```tsx
import { partitionSdkSources, sdkPreview } from "@/lib/sdk-grouping";
import { SdkSourceGroup } from "@/components/sdk-source-group";
```

- [ ] **Step 2: Partition + split into flat/SDK active/inactive**

Replace the current split block (lines 100-111):

```tsx
const active: SourceListItem[] = [];
const inactive: SourceListItem[] = [];
for (const s of sources) {
  (isInactive(s) ? inactive : active).push(s);
}

active.sort(sortByImportance);
inactive.sort(sortByImportance);

const productMap = new Map(products.map((p) => [p.slug, p.name]));
const hasProducts = products.length > 0;
const hasOnDemand = sources.some((s) => s.discovery === "on_demand");
```

with:

```tsx
const { flat, sdk } = partitionSdkSources(sources, products);

const active: SourceListItem[] = [];
const inactive: SourceListItem[] = [];
for (const s of flat) {
  (isInactive(s) ? inactive : active).push(s);
}
active.sort(sortByImportance);
inactive.sort(sortByImportance);

const sdkActive: SourceListItem[] = [];
const sdkInactive: SourceListItem[] = [];
for (const s of sdk) {
  (isInactive(s) ? sdkInactive : sdkActive).push(s);
}
sdkActive.sort(sortByImportance);
sdkInactive.sort(sortByImportance);

const productMap = new Map(products.map((p) => [p.slug, p.name]));
const hasProducts = products.length > 0;
const hasOnDemand = sources.some((s) => s.discovery === "on_demand");
const columnCount = 4 + (hasProducts ? 1 : 0) + (sourceSparklines ? 1 : 0);
```

- [ ] **Step 3: Add an `indent` param to `renderRow`**

Change the `renderRow` signature (line 113):

```tsx
  const renderRow = (source: SourceListItem, muted: boolean) => {
```

to:

```tsx
  const renderRow = (source: SourceListItem, muted: boolean, indent = false) => {
```

Then change its first `<td>` (line 120) from:

```tsx
        <td className="px-3 py-3 max-w-0">
```

to:

```tsx
        <td className={`${indent ? "pl-7 pr-3" : "px-3"} py-3 max-w-0`}>
```

- [ ] **Step 4: Render the SDK group between active and inactive rows**

Replace the current `<tbody>` body (lines 196-199):

```tsx
<tbody className="divide-y divide-stone-100 dark:divide-stone-800/50">
  {active.map((s) => renderRow(s, false))}
  {inactive.map((s) => renderRow(s, true))}
</tbody>
```

with:

```tsx
<tbody className="divide-y divide-stone-100 dark:divide-stone-800/50">
  {active.map((s) => renderRow(s, false))}
  {sdk.length > 0 && (
    <SdkSourceGroup colSpan={columnCount} count={sdk.length} preview={sdkPreview(sdk)}>
      {sdkActive.map((s) => renderRow(s, false, true))}
      {sdkInactive.map((s) => renderRow(s, true, true))}
    </SdkSourceGroup>
  )}
  {inactive.map((s) => renderRow(s, true))}
</tbody>
```

- [ ] **Step 5: Typecheck the web app**

Run: `cd web && bunx tsc --noEmit && cd ..`
Expected: no errors. (`partitionSdkSources(sources, products)` infers `S = SourceListItem`; `sources`/`products` now carry `kind` from the Task 2 API change via the api-types schema.)

- [ ] **Step 6: Commit**

```bash
git add web/src/components/source-table.tsx
git commit -m "feat(web): group SDK sources on the org sources page (#1080)"
```

---

### Task 6: Full verification + manual check

**Files:** none (verification only)

- [ ] **Step 1: Run the full unit + API gate for touched areas**

Run: `bun test tests/unit/sdk-grouping.test.ts tests/api/source-kind-read.test.ts`
Expected: PASS.

- [ ] **Step 2: Typecheck web + api worker**

Run: `cd web && bunx tsc --noEmit && cd .. && cd workers/api && bunx tsc --noEmit && cd ../..`
Expected: no errors in either.

- [ ] **Step 3: Lint + format**

Run: `bun run lint && bun run format:check`
Expected: clean. (If `format:check` flags the new files, run `bun run format` and amend the relevant commit.)

- [ ] **Step 4: Manual browser confirmation**

Identify an org with ≥2 SDK-kind sources, then view its sources page:

1. Find a candidate org/slug — e.g. run `releases sources list --kind sdk` (CLI) or `curl "$RELEASED_API_URL/v1/sources?kind=sdk&limit=50"` and pick an org slug with multiple SDK rows (Stripe, AWS, OpenAI, Vercel, and Cloudflare were classified in the backfill).
2. Start the web dev server: `bun run dev:web` (serves at `https://<branch>.releases.localhost`, reading from `RELEASED_API_URL`).
3. Open `https://<branch>.releases.localhost/<org-slug>/sources`.
4. Confirm: a collapsed **SDKs** subheading row sits at the bottom of the active rows (above any muted/inactive rows), showing a `·`-separated member preview and a chevron; clicking it expands the indented SDK rows; the chevron rotates. An org with 0–1 SDK sources shows no group (unchanged from today).
5. Capture a screenshot of the collapsed and expanded states with the Chrome browser tool for the PR.

The automated checks in Steps 1-3 are the pass/fail gate; Step 4 is visual confirmation.

- [ ] **Step 5: Finish the branch**

Use the `superpowers:finishing-a-development-branch` skill to open the PR (do not push to `main`; the user merges via PR — web + workers + api-types auto-deploy on merge).

---

## Self-Review

**Spec coverage:**

- Emit `kind` on org detail (spec "Blast radius", Files API tier) → Task 2. ✓
- Membership via resolved kind + inheritance (spec "Membership") → Task 3 `partitionSdkSources` + Task 2 product `kind`. ✓
- ≥2 threshold (spec "Threshold") → Task 3 `SDK_GROUP_MIN`, tested. ✓
- Bottom-of-active placement (spec "Structure and placement") → Task 5 Step 4 (SDK group between active and inactive). ✓
- Text subheading + member preview, no chips (spec "Group header") → Task 4 component + `sdkPreview`. ✓
- Indented rows (spec) → Task 5 Step 3 `indent`. ✓
- Inactive SDKs pulled into the group (spec "Within-group ordering") → Task 5 Step 2/4 (`sdkInactive` rendered inside the group). ✓
- Client component for collapse, rest server-rendered (spec "Interactivity") → Task 4 `"use client"`; `SourceTable` stays a server component. ✓
- Pure testable helper (spec "Pure helper + testing") → Task 3. ✓

**Placeholder scan:** No TBD/TODO; every code step shows full code. ✓

**Type consistency:** `partitionSdkSources` / `sdkPreview` / `SDK_GROUP_MIN` names match across Tasks 3 and 5. `SdkSourceGroup` props (`colSpan`, `count`, `preview`, `children`) match between Task 4 definition and Task 5 usage. `renderRow(source, muted, indent)` third-arg added in Task 5 Step 3 and used in Step 4. `kind` field name consistent across `SourceWithStats`, the SQL alias, the map, and the schema. ✓
