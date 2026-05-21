# SDK Weighting (Overview-Page Grouping + Summary Cap) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make a company's SDK family read as one prominent voice rather than N peers — by collapsing loose SDK sources on the org overview page and capping the SDK family's collective contribution to AI overview generation.

**Architecture:** Two independent parts. Part 1 is web-only: reuse the already-shipped `partitionSdkSources`/`sdkPreview` helpers (no API change — `kind` is already on the wire from #1116) plus a new card-context disclosure component, wired into both render branches of `release-timeline.tsx`. Part 2 adds a pure per-kind family cap to `selectReleasesForOverview` and threads each source's resolved `kind` through the two callers that build its input.

**Tech Stack:** TypeScript (strict), Bun (`bun test`), Next.js (web), Hono + Drizzle (API worker), `@buildinternet/releases-core`.

**Spec:** `docs/superpowers/specs/2026-05-21-sdk-weighting-overview-and-summaries-design.md`
**Issue:** [#1080](https://github.com/buildinternet/releases/issues/1080)

---

## File Structure

**Part 1 — web:**

- Create `web/src/components/sdk-source-card-group.tsx` — `"use client"` collapsible disclosure block for the card list (sibling of the table-bound `SdkSourceGroup`). One responsibility: the SDKs header + collapse state.
- Modify `web/src/components/release-timeline.tsx` — add a small shared `FlatSourcesWithSdk` helper (DRY: used by both the no-products branch and the `ProductGroupedSources` ungrouped remainder).

**Part 2 — core + workers:**

- Modify `packages/core/src/overview.ts` — `PER_KIND_FAMILY_CAPS` constant, extend `selectReleasesForOverview` signature + add the family-cap step.
- Modify `tests/unit/overview-selection.test.ts` — new family-cap cases.
- Modify `workers/api/src/routes/overview-inputs.ts` — select `kind`/`productId`, resolve kind, pass into `perSource`.
- Modify `packages/core-internal/src/overview-eligibility.ts` — same threading inside `fetchOverviewInputsForOrg`.

---

## Part 1 — SDK grouping on the org overview page

### Task 1: Create the `SdkSourceCardGroup` component

**Files:**

- Create: `web/src/components/sdk-source-card-group.tsx`

- [ ] **Step 1: Write the component**

```tsx
"use client";

import { useState } from "react";

/**
 * Collapsible "SDKs" block for the org overview page's source-card list — the
 * card-context sibling of `SdkSourceGroup` (which is bound to the /sources
 * table's <tr>/<td> markup). Renders a <div> disclosure header; when open,
 * renders the SDK member cards passed as `children`.
 */
export function SdkSourceCardGroup({
  count,
  preview,
  children,
}: {
  count: number;
  preview: string;
  children: React.ReactNode;
}) {
  const [open, setOpen] = useState(false);

  return (
    <div>
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        // Disclosure pattern: the accessible name names the region (a stable
        // noun) and aria-expanded conveys open/closed. Don't fold an
        // Expand/Collapse verb into the label — paired with the announced
        // "collapsed"/"expanded" state it reads as redundant double-speak.
        aria-label={`${count} SDK ${count === 1 ? "source" : "sources"}`}
        className="flex items-center gap-2 w-full text-left px-1 py-2 text-stone-600 dark:text-stone-300 hover:text-stone-900 dark:hover:text-stone-100 transition-colors"
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
      {open && <div className="space-y-2 mt-2">{children}</div>}
    </div>
  );
}
```

- [ ] **Step 2: Typecheck the web package**

Run: `cd web && npx tsc --noEmit`
Expected: PASS (no errors referencing `sdk-source-card-group.tsx`).

- [ ] **Step 3: Commit**

```bash
git add web/src/components/sdk-source-card-group.tsx
git commit -m "feat(web): SdkSourceCardGroup disclosure for the overview card list"
```

---

### Task 2: Wire grouping into `release-timeline.tsx` (both branches)

**Files:**

- Modify: `web/src/components/release-timeline.tsx`

- [ ] **Step 1: Add imports**

At the end of the existing import block (after `import { groupSourcesByProduct } from "@/lib/sources";` on line 31), add:

```tsx
import { partitionSdkSources, sdkPreview } from "@/lib/sdk-grouping";
import { SdkSourceCardGroup } from "@/components/sdk-source-card-group";
```

- [ ] **Step 2: Add the shared `FlatSourcesWithSdk` helper**

Insert this component just above `function ProductGroupedSources(` (currently line 57):

```tsx
/**
 * Render a list of source cards with any loose SDK-kind sources (resolved via
 * source.kind ?? product.kind) folded into a single collapsed group at the
 * bottom. Below the SDK_GROUP_MIN threshold, `partitionSdkSources` returns
 * everything in `flat`, so the group simply doesn't render.
 */
function FlatSourcesWithSdk({
  sources,
  products,
  orgSlug,
  cadenceMap,
  showProductBadge = false,
}: {
  sources: SourceListItem[];
  products: OrgDetail["products"];
  orgSlug: string;
  cadenceMap: Map<string, SourceCadenceData>;
  showProductBadge?: boolean;
}) {
  const { flat, sdk } = partitionSdkSources(sources, products);
  const preview = sdkPreview(
    sdk.map((s) => ({
      name: s.name,
      releaseCount: cadenceMap.get(s.slug)?.totalReleaseCount ?? 0,
    })),
  );

  return (
    <div className="space-y-2">
      {flat.map((source) => (
        <SourceCard
          key={source.slug}
          source={source}
          orgSlug={orgSlug}
          cadence={cadenceMap.get(source.slug)}
          showProductBadge={showProductBadge}
        />
      ))}
      {sdk.length > 0 && (
        <SdkSourceCardGroup count={sdk.length} preview={preview}>
          {sdk.map((source) => (
            <SourceCard
              key={source.slug}
              source={source}
              orgSlug={orgSlug}
              cadence={cadenceMap.get(source.slug)}
              showProductBadge={showProductBadge}
            />
          ))}
        </SdkSourceCardGroup>
      )}
    </div>
  );
}
```

- [ ] **Step 3: Use the helper in the `ProductGroupedSources` ungrouped block**

In `ProductGroupedSources`, replace the ungrouped sources list (currently lines 97–107, the `<div className="space-y-2"> {ungrouped.map(...)} </div>`):

```tsx
<div className="space-y-2">
  {ungrouped.map((source) => (
    <SourceCard
      key={source.slug}
      source={source}
      orgSlug={orgSlug}
      cadence={cadenceMap.get(source.slug)}
      showProductBadge={false}
    />
  ))}
</div>
```

with:

```tsx
<FlatSourcesWithSdk
  sources={ungrouped}
  products={products}
  orgSlug={orgSlug}
  cadenceMap={cadenceMap}
  showProductBadge={false}
/>
```

- [ ] **Step 4: Use the helper in the no-products branch**

In `ReleaseTimeline`'s render (currently lines 430–441), replace the `else` branch:

```tsx
        ) : (
          <div className="space-y-2">
            {activeSources.map((source) => (
              <SourceCard
                key={source.slug}
                source={source}
                orgSlug={orgSlug}
                cadence={cadenceMap.get(source.slug)}
              />
            ))}
          </div>
        )}
```

with:

```tsx
        ) : (
          <FlatSourcesWithSdk
            sources={activeSources}
            products={products}
            orgSlug={orgSlug}
            cadenceMap={cadenceMap}
          />
        )}
```

- [ ] **Step 5: Typecheck the web package**

Run: `cd web && npx tsc --noEmit`
Expected: PASS.

- [ ] **Step 6: Lint**

Run: `bun run lint`
Expected: PASS (no new oxlint findings).

- [ ] **Step 7: Commit**

```bash
git add web/src/components/release-timeline.tsx
git commit -m "feat(web): fold loose SDK sources into a group on the org overview page"
```

---

### Task 3: Manual smoke (overview page)

**Files:** none (verification only).

- [ ] **Step 1: Run the web dev server**

Run: `bun run dev:web`
(Reachable at `https://releases.localhost` per AGENTS.md; data comes from the prod API the web app is configured against.)

- [ ] **Step 2: Verify the grouping on a known SDK-heavy org**

Open `https://releases.localhost/posthog`. Confirm:

- The active source list shows non-SDK cards (e.g. `PostHog Changelog`, `PostHog`) flat.
- The SDK sources (`posthog-js`, `posthog-python`, …) are folded into a single collapsed **SDKs** row at the bottom, with a `·`-separated name preview.
- Clicking the row expands the member `SourceCard`s; the chevron rotates; `aria-expanded` toggles (inspect the button).
- A control org with `< 2` SDK sources still renders all sources flat (no group).

Expected: SDK family collapsed to one row; everything else unchanged.

---

## Part 2 — kind-aware family cap in overview generation

### Task 4: Add the per-kind family cap to `selectReleasesForOverview` (TDD)

**Files:**

- Modify: `packages/core/src/overview.ts`
- Test: `tests/unit/overview-selection.test.ts`

- [ ] **Step 1: Write the failing tests**

Append these cases inside the existing `describe("selectReleasesForOverview", ...)` block in `tests/unit/overview-selection.test.ts`. Also add `PER_KIND_FAMILY_CAPS` to the import from `@buildinternet/releases-core/overview` at the top of the file.

```ts
it("caps the SDK family collectively so non-SDK sources survive", () => {
  // 10 SDK github repos (older) + 1 platform changelog (newest).
  const sdkSources = Array.from({ length: 10 }, (_, i) => ({
    type: "github" as const,
    kind: "sdk" as const,
    releases: mkBatch(`sdk${i}`, 10, "2026-01-01"),
  }));
  const changelog = {
    type: "scrape" as const,
    kind: "platform" as const,
    releases: mkBatch("changelog", 10, "2026-05-01"),
  };
  const { releases } = selectReleasesForOverview([...sdkSources, changelog], 50);

  const sdkCount = releases.filter((r) => r.id.includes("rel_sdk")).length;
  const changelogCount = releases.filter((r) => r.id.startsWith("rel_changelog_")).length;

  // SDK family pooled + capped regardless of how many repos contributed.
  expect(sdkCount).toBe(PER_KIND_FAMILY_CAPS.sdk);
  // Changelog fully represented (10 <= scrape cap 20), not crowded out.
  expect(changelogCount).toBe(10);
});

it("treats null/undefined kind as uncapped (back-compat)", () => {
  const perSource = [
    { type: "github" as const, releases: mkBatch("github", 30) },
    { type: "scrape" as const, releases: mkBatch("scrape", 30) },
  ];
  const { releases } = selectReleasesForOverview(perSource, 100);
  // Identical to the pre-family-cap behavior: 10 (github cap) + 20 (scrape cap).
  expect(releases.length).toBe(30);
});

it("does not pad an SDK family that is under its cap", () => {
  const { releases } = selectReleasesForOverview(
    [{ type: "github" as const, kind: "sdk" as const, releases: mkBatch("sdk", 3) }],
    50,
  );
  expect(releases.length).toBe(3);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun test tests/unit/overview-selection.test.ts`
Expected: FAIL — `PER_KIND_FAMILY_CAPS` is `undefined` (not yet exported), so the first/third cases error or assert wrong counts.

- [ ] **Step 3: Implement the family cap**

In `packages/core/src/overview.ts`, add the `Kind` import at the top (after the existing `import type { Release, Source } from "./schema.js";`):

```ts
import type { Kind } from "./kinds.js";
```

Add the constant just below the existing `PER_SOURCE_CAPS` block:

```ts
/**
 * Per-kind family caps applied AFTER per-source caps but BEFORE the global
 * limit. Where `PER_SOURCE_CAPS` keeps a single noisy repo from dominating,
 * this keeps a whole *family* of same-kind sources from dominating: an org
 * with 10 SDK repos would otherwise feed ~100 SDK releases into the window and
 * crowd the changelog out of the model's context. Capping the SDK family
 * collectively makes it read as one prominent voice rather than N peers.
 *
 * Keyed by *resolved* kind (source.kind ?? product.kind). Kinds absent from
 * this map are uncapped at the family level. Tunable.
 */
export const PER_KIND_FAMILY_CAPS: Partial<Record<Kind, number>> = {
  sdk: 10,
};
```

Replace the `selectReleasesForOverview` function body with:

```ts
export function selectReleasesForOverview(
  perSource: Array<{ type: Source["type"]; kind?: Kind | null; releases: Release[] }>,
  limit: number = OVERVIEW_RELEASE_LIMIT,
): { releases: Release[]; totalAvailable: number } {
  const totalAvailable = perSource.reduce((n, s) => n + s.releases.length, 0);

  // 1. Per-source cap by adapter type (unchanged): a single noisy repo can't
  //    contribute more than its type's cap.
  const perSourceCapped = perSource.map(({ type, kind, releases }) => ({
    kind: kind ?? null,
    releases: releases.slice(0, PER_SOURCE_CAPS[type] ?? 20),
  }));

  // 2. Per-kind family cap: pool releases of a capped kind across all its
  //    sources, keep the most-recent N. Other kinds (and untagged sources)
  //    pass through untouched.
  const familyPools = new Map<Kind, Release[]>();
  const passthrough: Release[] = [];
  for (const { kind, releases } of perSourceCapped) {
    if (kind && kind in PER_KIND_FAMILY_CAPS) {
      const pool = familyPools.get(kind) ?? [];
      pool.push(...releases);
      familyPools.set(kind, pool);
    } else {
      passthrough.push(...releases);
    }
  }
  const familyCapped: Release[] = [];
  for (const [kind, pool] of familyPools) {
    const cap = PER_KIND_FAMILY_CAPS[kind]!;
    const mostRecent = pool
      .toSorted((a, b) => (b.publishedAt ?? "").localeCompare(a.publishedAt ?? ""))
      .slice(0, cap);
    familyCapped.push(...mostRecent);
  }

  // 3. Merge, global recency sort, global limit (unchanged semantics).
  const sorted = [...passthrough, ...familyCapped].toSorted((a, b) =>
    (b.publishedAt ?? "").localeCompare(a.publishedAt ?? ""),
  );
  return { releases: sorted.slice(0, limit), totalAvailable };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test tests/unit/overview-selection.test.ts`
Expected: PASS — all existing cases plus the three new ones.

- [ ] **Step 5: Typecheck core via root tsc**

Run: `npx tsc --noEmit`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add packages/core/src/overview.ts tests/unit/overview-selection.test.ts
git commit -m "feat(core): per-kind family cap in selectReleasesForOverview"
```

---

### Task 5: Thread resolved kind through the `overview-inputs` HTTP endpoint

**Files:**

- Modify: `workers/api/src/routes/overview-inputs.ts`

- [ ] **Step 1: Add imports**

Add `products` to the schema import (currently lines 6–11):

```ts
import {
  knowledgePages,
  organizationsPublic,
  products,
  releases,
  sourcesActive,
} from "@buildinternet/releases-core/schema";
```

Add a new import line just below the `@buildinternet/releases-core/dates` import (line 12):

```ts
import { resolveSourceKind, type Kind } from "@buildinternet/releases-core/kinds";
```

- [ ] **Step 2: Select `kind` + `productId` on active sources**

In the `activeSources` select (currently lines 109–114), add the two columns:

```ts
      .select({
        id: sourcesActive.id,
        slug: sourcesActive.slug,
        name: sourcesActive.name,
        type: sourcesActive.type,
        kind: sourcesActive.kind,
        productId: sourcesActive.productId,
      })
```

- [ ] **Step 3: Fetch product kinds and resolve per source**

Immediately after the `activeSources` query (after its closing `;`, before `const cutoff = daysAgoIso(windowDays);` on line 127), add:

```ts
const orgProducts = await db
  .select({ id: products.id, kind: products.kind })
  .from(products)
  .where(eq(products.orgId, org.id));
const productKindById = new Map(orgProducts.map((p) => [p.id, p.kind]));
```

Then change the per-source mapping (currently line 142, `return { type: s.type, releases: rows };`) to:

```ts
return {
  type: s.type,
  kind: resolveSourceKind(
    { kind: s.kind as Kind | null },
    s.productId ? { kind: (productKindById.get(s.productId) ?? null) as Kind | null } : null,
  ),
  releases: rows,
};
```

- [ ] **Step 4: Typecheck the API worker**

Run: `cd workers/api && npx tsc --noEmit`
Expected: PASS.

- [ ] **Step 5: Run the API worker tests**

Run: `bun test workers/api`
Expected: PASS (no behavior change for untagged orgs; the response shape is unchanged).

- [ ] **Step 6: Commit**

```bash
git add workers/api/src/routes/overview-inputs.ts
git commit -m "feat(api): pass resolved source kind into overview input selection"
```

---

### Task 6: Thread resolved kind through `fetchOverviewInputsForOrg`

**Files:**

- Modify: `packages/core-internal/src/overview-eligibility.ts`

- [ ] **Step 1: Add imports**

Add `products` to the existing `@buildinternet/releases-core/schema` import block (it currently imports `knowledgePages, organizationsPublic, releases, sourcesActive`):

```ts
import {
  knowledgePages,
  organizationsPublic,
  products,
  releases,
  sourcesActive,
} from "@buildinternet/releases-core/schema";
```

Add a kinds import alongside the existing core imports (e.g. directly after the `@buildinternet/releases-core/dates` import):

```ts
import { resolveSourceKind, type Kind } from "@buildinternet/releases-core/kinds";
```

- [ ] **Step 2: Select `kind` + `productId` on active sources**

In `fetchOverviewInputsForOrg`, extend the `activeSources` select (the one selecting `id, slug, name, type`) to add:

```ts
      kind: sourcesActive.kind,
      productId: sourcesActive.productId,
```

- [ ] **Step 3: Fetch product kinds and resolve when building `releasesPerSource`**

After the `releasesBySource` map is built and before `const { releases: selected, totalAvailable } = selectReleasesForOverview(...)`, replace the existing `releasesPerSource` construction:

```ts
const releasesPerSource = activeSources.map((s) => ({
  type: s.type,
  releases: releasesBySource.get(s.id) ?? [],
}));
```

with:

```ts
const orgProducts = await db
  .select({ id: products.id, kind: products.kind })
  .from(products)
  .where(eq(products.orgId, org.id));
const productKindById = new Map(orgProducts.map((p) => [p.id, p.kind]));

const releasesPerSource = activeSources.map((s) => ({
  type: s.type,
  kind: resolveSourceKind(
    { kind: s.kind as Kind | null },
    s.productId ? { kind: (productKindById.get(s.productId) ?? null) as Kind | null } : null,
  ),
  releases: releasesBySource.get(s.id) ?? [],
}));
```

(The `OverviewInputsForOrg.sources` interface stays `{ id, slug, name, type }`; `kind`/`productId` are selected only to resolve each source's kind for selection and are projected back out of the returned `sources` array before return, so they never leak onto the contract.)

- [ ] **Step 4: Run the eligibility tests**

Run: `bun test packages/core-internal/src/overview-eligibility.test.ts`
Expected: PASS — orgs in the tests have no products and untagged sources, so resolved kind is `null` → passthrough → identical selection.

- [ ] **Step 5: Typecheck core-internal via root tsc**

Run: `npx tsc --noEmit`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add packages/core-internal/src/overview-eligibility.ts
git commit -m "feat(core-internal): resolve source kind for batch overview inputs"
```

---

### Task 7: Tune the SDK cap against a real org (optional, manual)

**Files:** possibly `packages/core/src/overview.ts` (only the `sdk` value in `PER_KIND_FAMILY_CAPS`).

- [ ] **Step 1: Inspect the selected input for an SDK-heavy org**

With the API running (or against the deployed branch), call the inputs endpoint for PostHog and check the kind mix of `selected`:

Run: `curl -s "$RELEASED_API_URL/v1/orgs/posthog/overview/inputs?check=false" -H "Authorization: Bearer $RELEASES_API_KEY_ADMIN" | jq '{selected: (.selected|length), total: .totalAvailable}'`
Expected: `selected` includes the PostHog changelog releases, not only SDK bumps.

- [ ] **Step 2: Adjust the cap if needed**

If SDK churn still dominates, lower `PER_KIND_FAMILY_CAPS.sdk` (e.g. to 6); if the summary loses useful SDK signal, raise it (e.g. to 15). Re-run Task 4 tests after any change (the first test asserts `sdkCount === PER_KIND_FAMILY_CAPS.sdk`, so it self-adjusts).

- [ ] **Step 3: Commit only if the value changed**

```bash
git add packages/core/src/overview.ts
git commit -m "chore(core): tune SDK family cap for overview generation"
```

---

## Final: open the PR

- [ ] **Step 1: Run the full local gate**

Run: `bun test && npx tsc --noEmit && (cd web && npx tsc --noEmit) && (cd workers/api && npx tsc --noEmit) && bun run lint`
Expected: all PASS.

- [ ] **Step 2: Push and open the PR**

```bash
git push -u origin sdk-weighting-overview-summaries
gh pr create --title "feat: SDK weighting — overview-page grouping + summary cap (#1080)" --body-file /tmp/sdk-weighting-pr-body.md
```

(Write the PR body to `/tmp/sdk-weighting-pr-body.md` first; summarize Part 1 + Part 2, link the spec and #1080, and note the deferred Tier-3 items.)

---

## Self-Review

**Spec coverage:**

- Part 1 display grouping (both branches) → Tasks 1–2 (component + wiring of no-products branch and `ProductGroupedSources` ungrouped remainder). ✓
- `≥2` threshold, plain-text `/sources` treatment, a11y idiom → Task 1 component + `partitionSdkSources` (already enforces `SDK_GROUP_MIN`). ✓
- Part 2 family cap + optional `kind` signature → Task 4. ✓
- Threading resolved kind through both callers → Tasks 5 (HTTP) + 6 (batch workflow). ✓
- Cap tuned during implementation → Task 7. ✓
- "No migration / future regenerations only" → no schema task; correct. ✓

**Placeholder scan:** No TBD/TODO; every code step shows complete code. Task 7 is explicitly optional/manual and self-contained. ✓

**Type consistency:** `selectReleasesForOverview` perSource entry shape `{ type; kind?: Kind | null; releases }` is identical in Task 4 (definition), Task 5, and Task 6 (callers). `PER_KIND_FAMILY_CAPS` referenced by the same name in code and tests. `resolveSourceKind({ kind }, product | null)` matches its `@buildinternet/releases-core/kinds` signature. `SdkSourceCardGroup` props `{ count, preview, children }` match between Task 1 (definition) and Task 2 (usage). `partitionSdkSources(sources, products)` / `sdkPreview([{name, releaseCount}])` match the shipped lib signatures. ✓
