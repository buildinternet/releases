# App-source icon + platform badge + "Available on" Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** When a source is an App Store app, show its app icon + platform badge wherever the source appears, and add an "Available on" affordance to the product page.

**Architecture:** A single pure helper `getAppInfo(source)` reads `type === "appstore"` + `metadata.appStore` and returns `{platform, label, iconUrl} | null`. Two small presentational components (`AppIcon`, `PlatformBadge`) consume it. The signal already rides the wire everywhere except product-detail sources, which gain two optional fields (`metadata`, `kind`). No DB migration.

**Tech Stack:** Next.js (web), Hono + Drizzle (workers/api), Zod (api-types), `bun test`.

**Spec:** `docs/superpowers/specs/2026-05-25-source-app-icon-design.md`

---

## File structure

- **Create** `web/src/lib/app-source.ts` — `getAppInfo` helper + `AppInfo` type (pure, no React).
- **Create** `web/src/lib/app-source.test.ts` — unit tests for the helper.
- **Create** `web/src/components/app-icon.tsx` — rounded-square app-icon image.
- **Create** `web/src/components/platform-badge.tsx` — labelled platform chip.
- **Modify** `packages/api-types/src/schemas/products.ts` — add `metadata` + `kind` to `ProductDetailSourceSchema`.
- **Create** `packages/api-types/test/products-detail-source.test.ts` — schema back-compat test.
- **Modify** `workers/api/src/routes/products.ts` — select `metadata` + `kind` in the product-detail sources query.
- **Create** `workers/api/test/product-detail-app-source.test.ts` — asserts the new fields are returned.
- **Modify** `web/src/app/[orgSlug]/[sourceSlug]/layout.tsx` — render icon + badge in the source header.
- **Modify** `web/src/components/source-card.tsx` — render icon + badge in source rows.
- **Modify** `web/src/app/[orgSlug]/product/[productSlug]/page.tsx` — "Available on" chip row.

**Verification note:** the web app has **no component/JSX test runner** (zero `*.test.ts` under `web/src` today). Behavioral logic is tested at the `getAppInfo` layer (`bun test`) and the wire layer (worker test). The three rendering changes (Tasks 5–7) and the two components (Tasks 3–4) are verified by `cd web && bunx tsc --noEmit` plus the manual preview checklist in Task 8 — consistent with the existing web package.

---

### Task 1: `getAppInfo` helper

**Files:**

- Create: `web/src/lib/app-source.ts`
- Test: `web/src/lib/app-source.test.ts`

- [ ] **Step 1: Write the failing test**

Create `web/src/lib/app-source.test.ts`:

```ts
import { describe, it, expect } from "bun:test";
import { getAppInfo } from "./app-source";

const meta = (o: unknown) => JSON.stringify(o);

describe("getAppInfo", () => {
  it("returns null for non-app sources", () => {
    expect(getAppInfo({ type: "scrape", metadata: null })).toBeNull();
    expect(
      getAppInfo({ type: "github", metadata: meta({ appStore: { platform: "ios" } }) }),
    ).toBeNull();
  });

  it("maps an iOS app store source", () => {
    expect(
      getAppInfo({
        type: "appstore",
        metadata: meta({ appStore: { platform: "ios", artworkUrl: "https://cdn/x.png" } }),
      }),
    ).toEqual({ platform: "ios", label: "iOS", iconUrl: "https://cdn/x.png" });
  });

  it("maps a macOS app store source", () => {
    expect(
      getAppInfo({
        type: "appstore",
        metadata: meta({ appStore: { platform: "macos", artworkUrl: "https://cdn/y.png" } }),
      }),
    ).toEqual({ platform: "macos", label: "macOS", iconUrl: "https://cdn/y.png" });
  });

  it("defaults to iOS + null icon when metadata is missing or malformed", () => {
    expect(getAppInfo({ type: "appstore", metadata: null })).toEqual({
      platform: "ios",
      label: "iOS",
      iconUrl: null,
    });
    expect(getAppInfo({ type: "appstore", metadata: "{not json" })).toEqual({
      platform: "ios",
      label: "iOS",
      iconUrl: null,
    });
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `bun test web/src/lib/app-source.test.ts`
Expected: FAIL — `Cannot find module './app-source'` (or `getAppInfo is not a function`).

- [ ] **Step 3: Write the helper**

Create `web/src/lib/app-source.ts`:

```ts
/**
 * Display info for a mobile/desktop App Store source. App Store sources
 * (`type === "appstore"`) carry the app icon + platform in
 * `metadata.appStore`; this reads it back for the UI. Returns `null` for any
 * non-app source, so callers gate app-only treatment with
 * `if (getAppInfo(source))`. Tolerant of null/missing/malformed metadata — an
 * app source with unparseable metadata still yields a badge (just no icon).
 */
export interface AppInfo {
  platform: "ios" | "macos";
  label: "iOS" | "macOS";
  iconUrl: string | null;
}

interface AppSourceLike {
  type: string;
  metadata?: string | null;
}

export function getAppInfo(source: AppSourceLike): AppInfo | null {
  if (source.type !== "appstore") return null;

  let appStore: { platform?: string; artworkUrl?: string } | undefined;
  try {
    const parsed = JSON.parse(source.metadata ?? "{}") as {
      appStore?: { platform?: string; artworkUrl?: string };
    };
    appStore = parsed?.appStore;
  } catch {
    appStore = undefined;
  }

  const platform = appStore?.platform === "macos" ? "macos" : "ios";
  return {
    platform,
    label: platform === "macos" ? "macOS" : "iOS",
    iconUrl: appStore?.artworkUrl ?? null,
  };
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `bun test web/src/lib/app-source.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add web/src/lib/app-source.ts web/src/lib/app-source.test.ts
git commit -m "feat(web): getAppInfo helper for app-store source display"
```

---

### Task 2: Wire `metadata` + `kind` onto product-detail sources

**Files:**

- Modify: `packages/api-types/src/schemas/products.ts:55-62` (`ProductDetailSourceSchema`)
- Modify: `workers/api/src/routes/products.ts:366-372` (product-detail sources select)
- Test: `workers/api/test/product-detail-app-source.test.ts`
- Test: `packages/api-types/test/products-detail-source.test.ts`

- [ ] **Step 1: Write the failing worker test**

Create `workers/api/test/product-detail-app-source.test.ts`:

```ts
import { describe, it, expect } from "bun:test";
import { organizations, products, sources } from "@buildinternet/releases-core/schema";
import { createTestDb, createTestApp } from "./setup";
import { productRoutes } from "../src/routes/products.js";

describe("GET product detail — app source fields", () => {
  it("returns metadata + kind on its sources", async () => {
    const db = createTestDb();
    await db.insert(organizations).values({ id: "org_a", name: "Acme", slug: "acme" });
    await db.insert(products).values({ id: "prod_a", name: "App", slug: "app", orgId: "org_a" });
    await db.insert(sources).values({
      id: "src_a",
      name: "App by Acme",
      slug: "app-ios",
      type: "appstore",
      url: "https://apps.apple.com/us/app/id1",
      orgId: "org_a",
      productId: "prod_a",
      kind: "mobile",
      metadata: JSON.stringify({ appStore: { platform: "ios", artworkUrl: "https://cdn/x.png" } }),
    });
    const fetch = createTestApp(db, [productRoutes], { env: {} });

    const res = await fetch(new Request("https://x.test/v1/products/prod_a"));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { sources: { kind?: string; metadata?: string }[] };
    expect(body.sources).toHaveLength(1);
    expect(body.sources[0]!.kind).toBe("mobile");
    expect(JSON.parse(body.sources[0]!.metadata!).appStore.platform).toBe("ios");
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `bun test workers/api/test/product-detail-app-source.test.ts`
Expected: FAIL — `expect(body.sources[0].kind).toBe("mobile")` receives `undefined` (handler doesn't select `kind`/`metadata` yet).

- [ ] **Step 3: Add the fields to the worker select**

In `workers/api/src/routes/products.ts`, in `getProductDetailHandler`, extend the sources select:

```ts
      .select({
        id: sourcesActive.id,
        slug: sourcesActive.slug,
        name: sourcesActive.name,
        type: sourcesActive.type,
        url: sourcesActive.url,
        metadata: sourcesActive.metadata,
        kind: sourcesActive.kind,
      })
      .from(sourcesActive)
      .where(eq(sourcesActive.productId, product.id))
      .orderBy(sourcesActive.name),
```

- [ ] **Step 4: Add the fields to the wire schema**

In `packages/api-types/src/schemas/products.ts`, extend `ProductDetailSourceSchema` (`KIND_VALUES` is already imported at the top of the file):

```ts
export const ProductDetailSourceSchema = z.object({
  id: z.string(),
  slug: z.string(),
  name: z.string(),
  type: SourceTypeSchema,
  url: z.string(),
  metadata: z.string().nullable().optional(),
  kind: z.enum(KIND_VALUES).nullable().optional(),
});
```

- [ ] **Step 5: Run the worker test to verify it passes**

Run: `bun test workers/api/test/product-detail-app-source.test.ts`
Expected: PASS.

- [ ] **Step 6: Add the api-types back-compat test**

Create `packages/api-types/test/products-detail-source.test.ts`:

```ts
import { describe, it, expect } from "bun:test";
import { ProductDetailSourceSchema } from "../src/schemas/products.js";

describe("ProductDetailSourceSchema", () => {
  it("parses without the optional app fields (older responses)", () => {
    const r = ProductDetailSourceSchema.safeParse({
      id: "s",
      slug: "s",
      name: "S",
      type: "scrape",
      url: "https://x",
    });
    expect(r.success).toBe(true);
  });

  it("parses with metadata + kind", () => {
    const r = ProductDetailSourceSchema.safeParse({
      id: "s",
      slug: "s",
      name: "S",
      type: "appstore",
      url: "https://x",
      metadata: JSON.stringify({ appStore: { platform: "ios" } }),
      kind: "mobile",
    });
    expect(r.success).toBe(true);
  });
});
```

- [ ] **Step 7: Run the api-types test to verify it passes**

Run: `bun test packages/api-types/test/products-detail-source.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 8: Commit**

```bash
git add packages/api-types/src/schemas/products.ts packages/api-types/test/products-detail-source.test.ts workers/api/src/routes/products.ts workers/api/test/product-detail-app-source.test.ts
git commit -m "feat(api,api-types): expose metadata + kind on product-detail sources"
```

---

### Task 3: `AppIcon` component

**Files:**

- Create: `web/src/components/app-icon.tsx`

- [ ] **Step 1: Write the component**

Create `web/src/components/app-icon.tsx`:

```tsx
import Image from "next/image";
import { isOptimizableImage } from "@/lib/sanitize";

interface AppIconProps {
  iconUrl: string | null;
  name: string;
  size?: number;
}

/**
 * App-store icon: a rounded-square thumbnail (app-icon convention),
 * deliberately distinct from the circular OrgAvatar. Falls back to the first
 * letter on a muted tile when no icon URL is present.
 */
export function AppIcon({ iconUrl, name, size = 24 }: AppIconProps) {
  if (!iconUrl) {
    return (
      <div
        className="rounded-md bg-stone-200 dark:bg-stone-700 flex items-center justify-center text-stone-500 dark:text-stone-400 font-medium shrink-0"
        style={{ width: size, height: size, fontSize: size * 0.4 }}
      >
        {name.charAt(0).toUpperCase()}
      </div>
    );
  }

  return (
    <Image
      src={iconUrl}
      alt={`${name} app icon`}
      width={size}
      height={size}
      className="rounded-md shrink-0"
      unoptimized={!isOptimizableImage(iconUrl)}
    />
  );
}
```

- [ ] **Step 2: Typecheck**

Run: `cd web && bunx tsc --noEmit`
Expected: no errors. (Verified visually in Task 8.)

- [ ] **Step 3: Commit**

```bash
git add web/src/components/app-icon.tsx
git commit -m "feat(web): AppIcon rounded-square component"
```

---

### Task 4: `PlatformBadge` component

**Files:**

- Create: `web/src/components/platform-badge.tsx`

- [ ] **Step 1: Write the component**

Create `web/src/components/platform-badge.tsx`:

```tsx
interface PlatformBadgeProps {
  label: string;
}

/**
 * Small labelled chip marking an app source's platform ("iOS" / "macOS").
 * Labelled text only — no emoji or arrow glyphs (house style). Styling mirrors
 * the existing source-card badges.
 */
export function PlatformBadge({ label }: PlatformBadgeProps) {
  return (
    <span className="text-[10px] font-medium uppercase tracking-wide text-stone-500 dark:text-stone-400 bg-stone-100 dark:bg-stone-800 px-1.5 py-0.5 rounded shrink-0">
      {label}
    </span>
  );
}
```

- [ ] **Step 2: Typecheck**

Run: `cd web && bunx tsc --noEmit`
Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add web/src/components/platform-badge.tsx
git commit -m "feat(web): PlatformBadge label chip"
```

---

### Task 5: Render icon + badge on the source detail header

**Files:**

- Modify: `web/src/app/[orgSlug]/[sourceSlug]/layout.tsx`

- [ ] **Step 1: Add imports**

At the top of `web/src/app/[orgSlug]/[sourceSlug]/layout.tsx`, alongside the existing component imports, add:

```tsx
import { AppIcon } from "@/components/app-icon";
import { PlatformBadge } from "@/components/platform-badge";
import { getAppInfo } from "@/lib/app-source";
```

- [ ] **Step 2: Derive `appInfo`**

Just after the existing `const sourceMeta = (() => { ... })();` block, add:

```tsx
const appInfo = getAppInfo(source);
```

- [ ] **Step 3: Render the icon + badge in the title row**

Find this block:

```tsx
        <div className="flex items-center gap-2.5 mt-4">
          <ViewTransition name={`src-${source.org.slug}-${source.slug}`} default="none">
            <h1 className="text-[28px] font-bold tracking-tight text-stone-900 dark:text-stone-100">
              {source.name}
            </h1>
          </ViewTransition>
          <SourceTypeIcon type={source.type} size={18} />
```

Replace it with (adds `AppIcon` before the title and `PlatformBadge` after the type icon):

```tsx
        <div className="flex items-center gap-2.5 mt-4">
          {appInfo && <AppIcon iconUrl={appInfo.iconUrl} name={source.name} size={32} />}
          <ViewTransition name={`src-${source.org.slug}-${source.slug}`} default="none">
            <h1 className="text-[28px] font-bold tracking-tight text-stone-900 dark:text-stone-100">
              {source.name}
            </h1>
          </ViewTransition>
          <SourceTypeIcon type={source.type} size={18} />
          {appInfo && <PlatformBadge label={appInfo.label} />}
```

- [ ] **Step 4: Typecheck**

Run: `cd web && bunx tsc --noEmit`
Expected: no errors.

- [ ] **Step 5: Commit**

```bash
git add "web/src/app/[orgSlug]/[sourceSlug]/layout.tsx"
git commit -m "feat(web): app icon + platform badge on source detail header"
```

---

### Task 6: Render icon + badge in source rows (`SourceCard`)

**Files:**

- Modify: `web/src/components/source-card.tsx`

- [ ] **Step 1: Add imports**

At the top of `web/src/components/source-card.tsx`, add:

```tsx
import { AppIcon } from "@/components/app-icon";
import { PlatformBadge } from "@/components/platform-badge";
import { getAppInfo } from "@/lib/app-source";
```

- [ ] **Step 2: Derive `appInfo` in the component body**

Inside `export function SourceCard({ ... })`, just after the existing `const capped = ...` line, add:

```tsx
const appInfo = getAppInfo(source);
```

- [ ] **Step 3: Render in the name row**

Find this block:

```tsx
        <div className="flex items-center gap-2">
          <ViewTransition name={transitionName} default="none">
            <span className="font-semibold text-[15px] text-stone-900 dark:text-stone-100">
              {source.name}
            </span>
          </ViewTransition>
          {source.isPrimary && (
```

Replace with (adds `AppIcon` before the name, `PlatformBadge` after it):

```tsx
        <div className="flex items-center gap-2">
          {appInfo && <AppIcon iconUrl={appInfo.iconUrl} name={source.name} size={20} />}
          <ViewTransition name={transitionName} default="none">
            <span className="font-semibold text-[15px] text-stone-900 dark:text-stone-100">
              {source.name}
            </span>
          </ViewTransition>
          {appInfo && <PlatformBadge label={appInfo.label} />}
          {source.isPrimary && (
```

- [ ] **Step 4: Typecheck**

Run: `cd web && bunx tsc --noEmit`
Expected: no errors.

- [ ] **Step 5: Commit**

```bash
git add web/src/components/source-card.tsx
git commit -m "feat(web): app icon + platform badge on source rows"
```

---

### Task 7: "Available on" affordance on the product page

**Files:**

- Modify: `web/src/app/[orgSlug]/product/[productSlug]/page.tsx`

- [ ] **Step 1: Add imports**

At the top of `web/src/app/[orgSlug]/product/[productSlug]/page.tsx`, add:

```tsx
import { AppIcon } from "@/components/app-icon";
import { getAppInfo, type AppInfo } from "@/lib/app-source";
```

- [ ] **Step 2: Build the app-source list**

Inside `ProductPage`, after the `product`/`org` are resolved and before the `return (`, add:

```tsx
const appEntries = product.sources
  .map((s) => {
    const app = getAppInfo(s);
    return app ? { slug: s.slug, name: s.name, app } : null;
  })
  .filter((e): e is { slug: string; name: string; app: AppInfo } => e !== null);
```

- [ ] **Step 3: Render the "Available on" row**

Find this block in the header:

```tsx
{
  product.description && (
    <p className="text-sm text-stone-500 dark:text-stone-400 mt-1">{product.description}</p>
  );
}
<CliCommand identifier={product.slug} />;
```

Replace with (inserts the chip row between the description and the CLI command):

```tsx
{
  product.description && (
    <p className="text-sm text-stone-500 dark:text-stone-400 mt-1">{product.description}</p>
  );
}
{
  appEntries.length > 0 && (
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
  );
}
<CliCommand identifier={product.slug} />;
```

- [ ] **Step 4: Typecheck**

Run: `cd web && bunx tsc --noEmit`
Expected: no errors.

- [ ] **Step 5: Commit**

```bash
git add "web/src/app/[orgSlug]/product/[productSlug]/page.tsx"
git commit -m "feat(web): 'Available on' app chips on product page"
```

---

### Task 8: Full verification + manual preview

**Files:** none (verification only)

- [ ] **Step 1: Typecheck all three roots**

Run:

```bash
npx tsc --noEmit
cd web && bunx tsc --noEmit && cd ..
cd workers/api && bunx tsc --noEmit && cd ../..
```

Expected: no errors in any.

- [ ] **Step 2: Run the full test suite**

Run: `bun test`
Expected: PASS, including the three new files (`app-source.test.ts`, `products-detail-source.test.ts`, `product-detail-app-source.test.ts`). No regressions.

- [ ] **Step 3: Lint + format**

Run:

```bash
bun run lint
bun run format:check
```

Expected: clean. If `format:check` flags the new files, run `bunx prettier --write` on them and amend.

- [ ] **Step 4: Manual preview**

Run the web app pointed at prod data (the `claude-ios` source is live in prod):

```bash
bun run dev:web
```

Then confirm in the browser (worktree URL is branch-prefixed, e.g. `https://appstore-app-icon.releases.localhost`):

- **Source page** `/anthropic/claude-ios` — app icon left of the title, "iOS" badge by it.
- **Product page** `/anthropic/product/claude` — "Available on" row with an iOS chip (icon + "iOS") linking to `/anthropic/claude-ios`; the `claude-ios` source row shows the icon + "iOS" badge.
- **Control** — the `claude` scrape source row is visually unchanged (no icon, no badge).

- [ ] **Step 5: Final commit (only if Step 3 required formatting fixes)**

```bash
git add -A
git commit -m "chore(web): format app-source files"
```

---

## Self-review

**Spec coverage:**

- App icon at source level → Tasks 1, 3, 5, 6. ✓
- Platform badge → Tasks 4, 5, 6. ✓
- "Available on" on product page → Task 7. ✓
- macOS/desktop support → `getAppInfo` maps `macos`→"macOS" (Task 1), components are platform-agnostic. ✓
- The one wire change (`metadata` + `kind` on `ProductDetailSourceSchema` + worker select) → Task 2. ✓
- Source page + org rows need no wire change → confirmed by using `SourceDetail`/`SourceListItem` (already carry `metadata`), no schema task for them. ✓
- No emoji / arrow glyphs → `PlatformBadge` is text-only; "Available on" chip uses `AppIcon` + label (Tasks 4, 7). ✓
- Hot-linked CDN icons via `unoptimized` → `AppIcon` reuses `isOptimizableImage` (Task 3). ✓
- Low-signal handling → out of scope; not in any task (correct). ✓

**Placeholder scan:** No TBD/TODO; every code step has complete code; every command has an expected result. ✓

**Type consistency:** `getAppInfo` returns `AppInfo {platform, label, iconUrl}` (Task 1), consumed unchanged in Tasks 5–7; `AppIcon` props `{iconUrl, name, size}` consistent across call sites; `PlatformBadge` prop `{label}` consistent; the `appEntries` predicate narrows to `{slug, name, app: AppInfo}` matching the render. The product-page chip relies on `product.sources[].metadata`, added in Task 2 (ordering: Task 2 precedes Task 7). ✓
