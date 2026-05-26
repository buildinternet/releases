# Admin Rename Display Name — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a "Display name" rename control to the org, product, and source local-dev admin menus in the web app.

**Architecture:** Web-frontend only. Each menu gets an inline text-input + Save section backed by a thin `"use server"` action that `PATCH`es `{ name }` to the existing org/product/source endpoints. Products get a brand-new admin-menu component (none exists today); org and source menus are extended in place. Everything rides the existing `isLocalAdminEnabled()` gate, so it appears only in local/dev.

**Tech Stack:** Next.js (App Router, React Server + Client Components), TypeScript, Tailwind, server actions. No API/schema changes — `PATCH /v1/orgs/:slug`, `PATCH /v1/orgs/:orgSlug/products/:productSlug`, and `PATCH /v1/orgs/:orgSlug/sources/:sourceSlug` already accept `name`.

**Spec:** `docs/superpowers/specs/2026-05-26-admin-rename-display-name-design.md`

---

## Prerequisites

This plan runs inside the worktree at `.claude/worktrees/admin-rename-display-name`. A fresh worktree has **no `node_modules`** — install before type-checking, or `tsc`/`lint` resolve against the wrong checkout.

- [ ] **Install deps in the worktree**

Run from the worktree root:

```bash
bun install
```

Expected: completes without error; `node_modules/` now present.

## File Structure

| File                                                            | Responsibility                               |
| --------------------------------------------------------------- | -------------------------------------------- |
| `web/src/app/actions/org-admin.ts` (modify)                     | add `renameOrgAction`                        |
| `web/src/app/actions/source-admin.ts` (modify)                  | add `renameSourceAction`                     |
| `web/src/app/actions/product-admin.ts` (**create**)             | `renameProductAction`                        |
| `web/src/components/org-admin-menu.tsx` (modify)                | `name` prop + Display-name section           |
| `web/src/components/source-admin-menu.tsx` (modify)             | `name` prop + Display-name section           |
| `web/src/components/product-admin-menu.tsx` (**create**)        | new dropdown menu, Display-name section only |
| `web/src/app/[orgSlug]/(org)/layout.tsx` (modify)               | pass `name={org.name}`                       |
| `web/src/app/[orgSlug]/[sourceSlug]/layout.tsx` (modify)        | pass `name={source.name}`                    |
| `web/src/app/[orgSlug]/product/[productSlug]/page.tsx` (modify) | gate + render `ProductAdminMenu`             |

Note on duplication: the Display-name section is repeated near-verbatim in three menus. Per the spec this is intentional (three small self-contained blocks); extract a shared field component only if a 4th consumer appears.

---

## Task 1: Source rename

**Files:**

- Modify: `web/src/app/actions/source-admin.ts`
- Modify: `web/src/components/source-admin-menu.tsx`
- Modify: `web/src/app/[orgSlug]/[sourceSlug]/layout.tsx`

- [ ] **Step 1: Add `renameSourceAction` to the source actions file**

Append this to the end of `web/src/app/actions/source-admin.ts` (the file already declares the `ActionResult` type and imports `webApiHeaders`, `adminActionEnv`, `revalidatePath`):

```typescript
/**
 * Rename a source's display name via
 * `PATCH /v1/orgs/:orgSlug/sources/:sourceSlug`. Sends only `name`; the slug and
 * URL are untouched. (The API re-embeds the source when its name changes.)
 */
export async function renameSourceAction(input: {
  orgSlug: string;
  sourceSlug: string;
  name: string;
}): Promise<ActionResult> {
  const env = adminActionEnv();
  if ("error" in env) return { ok: false, error: env.error };

  const path = `/v1/orgs/${encodeURIComponent(input.orgSlug)}/sources/${encodeURIComponent(input.sourceSlug)}`;
  let res: Response;
  try {
    res = await fetch(`${env.apiUrl}${path}`, {
      method: "PATCH",
      headers: webApiHeaders({
        "Content-Type": "application/json",
        Authorization: `Bearer ${env.apiSecret}`,
      }),
      body: JSON.stringify({ name: input.name }),
      cache: "no-store",
    });
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : "Network error" };
  }

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    return { ok: false, error: `API ${res.status}: ${text || res.statusText}` };
  }

  revalidatePath(`/${input.orgSlug}/${input.sourceSlug}`);
  revalidatePath(`/${input.orgSlug}`);
  return { ok: true };
}
```

- [ ] **Step 2: Import the new action in the source menu**

In `web/src/components/source-admin-menu.tsx`, replace the action import (line 5):

```typescript
import { setSourceMetadataAction, promoteSourceAction } from "@/app/actions/source-admin";
```

with:

```typescript
import {
  setSourceMetadataAction,
  promoteSourceAction,
  renameSourceAction,
} from "@/app/actions/source-admin";
```

- [ ] **Step 3: Add the `name` prop**

In the same file, the component signature currently destructures props and types them. Add `name` to both. Replace:

```typescript
export function SourceAdminMenu({
  orgSlug,
  sourceSlug,
  marketingFilter,
  marketingFilterHint,
  feedContentDepth,
  discovery,
  isHidden,
}: {
  orgSlug: string;
  sourceSlug: string;
  marketingFilter: boolean;
  marketingFilterHint: string | null;
  feedContentDepth: Depth;
  discovery?: string;
  isHidden: boolean;
}) {
```

with:

```typescript
export function SourceAdminMenu({
  orgSlug,
  sourceSlug,
  name,
  marketingFilter,
  marketingFilterHint,
  feedContentDepth,
  discovery,
  isHidden,
}: {
  orgSlug: string;
  sourceSlug: string;
  name: string;
  marketingFilter: boolean;
  marketingFilterHint: string | null;
  feedContentDepth: Depth;
  discovery?: string;
  isHidden: boolean;
}) {
```

- [ ] **Step 4: Add name-draft state**

In the same file, after the line:

```typescript
const [hint, setHint] = useState(marketingFilterHint ?? "");
```

add:

```typescript
const [nameDraft, setNameDraft] = useState(name);
```

- [ ] **Step 5: Keep the name field in sync on refresh**

Still in the same file, after the existing hint-sync effect:

```typescript
// Keep the hint field in sync when the source data refreshes.
useEffect(() => {
  setHint(marketingFilterHint ?? "");
}, [marketingFilterHint]);
```

add:

```typescript
// Keep the name field in sync when the source data refreshes.
useEffect(() => {
  setNameDraft(name);
}, [name]);

const canRename = nameDraft.trim().length > 0 && nameDraft.trim() !== name;
```

- [ ] **Step 6: Insert the Display-name section as the first menu section**

Still in the same file, find the opening of the menu body and its first section (the Marketing classifier block):

```tsx
          <div className="p-3 space-y-3">
            <div className="space-y-2">
              <div className="font-medium text-stone-700 dark:text-stone-200">
                Marketing classifier
              </div>
```

Replace it with (inserts a Display-name section first, and gives the Marketing classifier section a top border so the separators stay consistent):

```tsx
          <div className="p-3 space-y-3">
            <div className="space-y-2">
              <div className="font-medium text-stone-700 dark:text-stone-200">Display name</div>
              <input
                type="text"
                value={nameDraft}
                onChange={(e) => setNameDraft(e.target.value)}
                className="w-full px-2 py-1 rounded border border-stone-300 dark:border-stone-700 bg-white dark:bg-stone-900 text-stone-700 dark:text-stone-200 text-[13px]"
              />
              <button
                type="button"
                onClick={() =>
                  run(() => renameSourceAction({ orgSlug, sourceSlug, name: nameDraft.trim() }))
                }
                disabled={pending || !canRename}
                className="w-full px-2 py-1 rounded border border-stone-300 dark:border-stone-700 bg-stone-50 hover:bg-stone-100 dark:bg-stone-900 dark:hover:bg-stone-800 text-stone-700 dark:text-stone-200 disabled:opacity-50"
              >
                {pending ? "Saving…" : "Save"}
              </button>
              <p className="text-[12px] text-stone-500 dark:text-stone-400">
                Renames the display name only — slug and URL stay the same.
              </p>
            </div>

            <div className="space-y-2 border-t border-stone-200 dark:border-stone-800 pt-3">
              <div className="font-medium text-stone-700 dark:text-stone-200">
                Marketing classifier
              </div>
```

- [ ] **Step 7: Pass `name` from the source layout**

In `web/src/app/[orgSlug]/[sourceSlug]/layout.tsx`, the `<SourceAdminMenu>` render currently is:

```tsx
            <SourceAdminMenu
              orgSlug={source.org.slug}
              sourceSlug={source.slug}
              marketingFilter={sourceMeta.marketingFilter === true}
```

Add the `name` prop:

```tsx
            <SourceAdminMenu
              orgSlug={source.org.slug}
              sourceSlug={source.slug}
              name={source.name}
              marketingFilter={sourceMeta.marketingFilter === true}
```

- [ ] **Step 8: Type-check**

Run:

```bash
cd web && npx tsc --noEmit; cd ..
```

Expected: no errors.

- [ ] **Step 9: Lint**

Run from the worktree root:

```bash
bun run lint
```

Expected: no new errors in the touched files.

- [ ] **Step 10: Commit**

```bash
git add web/src/app/actions/source-admin.ts web/src/components/source-admin-menu.tsx "web/src/app/[orgSlug]/[sourceSlug]/layout.tsx"
git commit -m "feat(web): rename source display name from the admin menu"
```

---

## Task 2: Org rename

**Files:**

- Modify: `web/src/app/actions/org-admin.ts`
- Modify: `web/src/components/org-admin-menu.tsx`
- Modify: `web/src/app/[orgSlug]/(org)/layout.tsx`

- [ ] **Step 1: Add `renameOrgAction` to the org actions file**

Append this to the end of `web/src/app/actions/org-admin.ts` (it already declares `ActionResult` and imports `webApiHeaders`, `adminActionEnv`, `revalidatePath`):

```typescript
/**
 * Rename an org's display name via `PATCH /v1/orgs/:slug`. Sends only `name`;
 * the slug and URL are untouched.
 */
export async function renameOrgAction(input: {
  slug: string;
  name: string;
}): Promise<ActionResult> {
  const env = adminActionEnv();
  if ("error" in env) return { ok: false, error: env.error };

  let res: Response;
  try {
    res = await fetch(`${env.apiUrl}/v1/orgs/${encodeURIComponent(input.slug)}`, {
      method: "PATCH",
      headers: webApiHeaders({
        "Content-Type": "application/json",
        Authorization: `Bearer ${env.apiSecret}`,
      }),
      body: JSON.stringify({ name: input.name }),
      cache: "no-store",
    });
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : "Network error" };
  }

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    return { ok: false, error: `API ${res.status}: ${text || res.statusText}` };
  }

  // Bust the homepage (ticker + directory) and the org detail page.
  revalidatePath("/");
  revalidatePath(`/${input.slug}`);
  return { ok: true };
}
```

- [ ] **Step 2: Import the new action in the org menu**

In `web/src/components/org-admin-menu.tsx`, replace the action import (line 5):

```typescript
import { setOrgHiddenAction, setOrgAutoGenerateContentAction } from "@/app/actions/org-admin";
```

with:

```typescript
import {
  setOrgHiddenAction,
  setOrgAutoGenerateContentAction,
  renameOrgAction,
} from "@/app/actions/org-admin";
```

- [ ] **Step 3: Add the `name` prop**

Replace the component signature:

```typescript
export function OrgAdminMenu({
  orgSlug,
  isHidden,
  autoGenerateContent,
  discovery,
  fetchPaused,
}: {
  orgSlug: string;
  isHidden: boolean;
  autoGenerateContent: boolean;
  discovery?: string;
  fetchPaused?: boolean;
}) {
```

with:

```typescript
export function OrgAdminMenu({
  orgSlug,
  name,
  isHidden,
  autoGenerateContent,
  discovery,
  fetchPaused,
}: {
  orgSlug: string;
  name: string;
  isHidden: boolean;
  autoGenerateContent: boolean;
  discovery?: string;
  fetchPaused?: boolean;
}) {
```

- [ ] **Step 4: Add name-draft state**

After the line:

```typescript
const [error, setError] = useState<string | null>(null);
```

add:

```typescript
const [nameDraft, setNameDraft] = useState(name);
```

- [ ] **Step 5: Keep the name field in sync + derive `canRename`**

The org menu has a `run()` helper ending at:

```typescript
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      }
    });
  }
```

Immediately after that closing brace (and before `const onDemand = ...`), add:

```typescript
// Keep the name field in sync when the org data refreshes.
useEffect(() => {
  setNameDraft(name);
}, [name]);

const canRename = nameDraft.trim().length > 0 && nameDraft.trim() !== name;
```

- [ ] **Step 6: Insert the Display-name section as the first menu section**

Find the menu body opening and its first section (Listings):

```tsx
          <div className="p-3 space-y-3">
            <div className="space-y-2">
              <div className="font-medium text-stone-700 dark:text-stone-200">Listings</div>
```

Replace it with:

```tsx
          <div className="p-3 space-y-3">
            <div className="space-y-2">
              <div className="font-medium text-stone-700 dark:text-stone-200">Display name</div>
              <input
                type="text"
                value={nameDraft}
                onChange={(e) => setNameDraft(e.target.value)}
                className="w-full px-2 py-1 rounded border border-stone-300 dark:border-stone-700 bg-white dark:bg-stone-900 text-stone-700 dark:text-stone-200 text-[13px]"
              />
              <button
                type="button"
                onClick={() => run(() => renameOrgAction({ slug: orgSlug, name: nameDraft.trim() }))}
                disabled={pending || !canRename}
                className="w-full px-2 py-1 rounded border border-stone-300 dark:border-stone-700 bg-stone-50 hover:bg-stone-100 dark:bg-stone-900 dark:hover:bg-stone-800 text-stone-700 dark:text-stone-200 disabled:opacity-50"
              >
                {pending ? "Saving…" : "Save"}
              </button>
              <p className="text-[12px] text-stone-500 dark:text-stone-400">
                Renames the display name only — slug and URL stay the same.
              </p>
            </div>

            <div className="space-y-2 border-t border-stone-200 dark:border-stone-800 pt-3">
              <div className="font-medium text-stone-700 dark:text-stone-200">Listings</div>
```

- [ ] **Step 7: Pass `name` from the org layout**

In `web/src/app/[orgSlug]/(org)/layout.tsx`, the `<OrgAdminMenu>` render is:

```tsx
            <OrgAdminMenu
              orgSlug={org.slug}
              isHidden={org.isHidden ?? false}
```

Add the `name` prop:

```tsx
            <OrgAdminMenu
              orgSlug={org.slug}
              name={org.name}
              isHidden={org.isHidden ?? false}
```

- [ ] **Step 8: Type-check**

Run:

```bash
cd web && npx tsc --noEmit; cd ..
```

Expected: no errors.

- [ ] **Step 9: Lint**

```bash
bun run lint
```

Expected: no new errors in the touched files.

- [ ] **Step 10: Commit**

```bash
git add web/src/app/actions/org-admin.ts web/src/components/org-admin-menu.tsx "web/src/app/[orgSlug]/(org)/layout.tsx"
git commit -m "feat(web): rename org display name from the admin menu"
```

---

## Task 3: Product rename (new menu + action + wiring)

**Files:**

- Create: `web/src/app/actions/product-admin.ts`
- Create: `web/src/components/product-admin-menu.tsx`
- Modify: `web/src/app/[orgSlug]/product/[productSlug]/page.tsx`

- [ ] **Step 1: Create the product action file**

Create `web/src/app/actions/product-admin.ts`:

```typescript
"use server";

import { revalidatePath } from "next/cache";
import { webApiHeaders } from "@/lib/api";
import { adminActionEnv } from "@/lib/admin-action";

type ActionResult = { ok: true } | { ok: false; error: string };

/**
 * Rename a product's display name via
 * `PATCH /v1/orgs/:orgSlug/products/:productSlug`. Sends only `name`; the slug
 * and URL are untouched.
 */
export async function renameProductAction(input: {
  orgSlug: string;
  productSlug: string;
  name: string;
}): Promise<ActionResult> {
  const env = adminActionEnv();
  if ("error" in env) return { ok: false, error: env.error };

  const path = `/v1/orgs/${encodeURIComponent(input.orgSlug)}/products/${encodeURIComponent(input.productSlug)}`;
  let res: Response;
  try {
    res = await fetch(`${env.apiUrl}${path}`, {
      method: "PATCH",
      headers: webApiHeaders({
        "Content-Type": "application/json",
        Authorization: `Bearer ${env.apiSecret}`,
      }),
      body: JSON.stringify({ name: input.name }),
      cache: "no-store",
    });
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : "Network error" };
  }

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    return { ok: false, error: `API ${res.status}: ${text || res.statusText}` };
  }

  revalidatePath(`/${input.orgSlug}/product/${input.productSlug}`);
  revalidatePath(`/${input.orgSlug}`);
  return { ok: true };
}
```

- [ ] **Step 2: Create the product admin menu component**

Create `web/src/components/product-admin-menu.tsx` (same dropdown shell as the other two menus, with only the Display-name section):

```tsx
"use client";

import { useEffect, useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { renameProductAction } from "@/app/actions/product-admin";

export function ProductAdminMenu({
  orgSlug,
  productSlug,
  name,
}: {
  orgSlug: string;
  productSlug: string;
  name: string;
}) {
  const [open, setOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [nameDraft, setNameDraft] = useState(name);
  const [pending, startTransition] = useTransition();
  const containerRef = useRef<HTMLDivElement>(null);
  const router = useRouter();

  function close() {
    setOpen(false);
    setError(null);
  }

  useEffect(() => {
    if (!open) return;
    function onPointerDown(e: PointerEvent) {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) close();
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") close();
    }
    document.addEventListener("pointerdown", onPointerDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  // Keep the name field in sync when the product data refreshes.
  useEffect(() => {
    setNameDraft(name);
  }, [name]);

  function run(action: () => Promise<{ ok: true } | { ok: false; error: string }>) {
    startTransition(async () => {
      setError(null);
      try {
        const res = await action();
        if (!res.ok) {
          setError(res.error);
          return;
        }
        close();
        router.refresh();
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      }
    });
  }

  const canRename = nameDraft.trim().length > 0 && nameDraft.trim() !== name;

  return (
    <div ref={containerRef} className="relative inline-flex items-center">
      <button
        type="button"
        onClick={() => (open ? close() : setOpen(true))}
        aria-haspopup="menu"
        aria-expanded={open}
        className="text-[11px] px-2 py-0.5 rounded font-medium uppercase tracking-wider border border-stone-300 dark:border-stone-700 bg-stone-50 hover:bg-stone-100 dark:bg-stone-900 dark:hover:bg-stone-800 text-stone-700 dark:text-stone-200"
        title="Local-dev admin actions"
      >
        Admin
      </button>
      {open && (
        <div
          role="menu"
          className="absolute left-0 top-full mt-1 z-20 w-80 rounded-md border border-stone-200 dark:border-stone-800 bg-white dark:bg-stone-950 shadow-lg text-[13px] overflow-hidden"
        >
          <div className="p-3 space-y-3">
            <div className="space-y-2">
              <div className="font-medium text-stone-700 dark:text-stone-200">Display name</div>
              <input
                type="text"
                value={nameDraft}
                onChange={(e) => setNameDraft(e.target.value)}
                className="w-full px-2 py-1 rounded border border-stone-300 dark:border-stone-700 bg-white dark:bg-stone-900 text-stone-700 dark:text-stone-200 text-[13px]"
              />
              <button
                type="button"
                onClick={() =>
                  run(() => renameProductAction({ orgSlug, productSlug, name: nameDraft.trim() }))
                }
                disabled={pending || !canRename}
                className="w-full px-2 py-1 rounded border border-stone-300 dark:border-stone-700 bg-stone-50 hover:bg-stone-100 dark:bg-stone-900 dark:hover:bg-stone-800 text-stone-700 dark:text-stone-200 disabled:opacity-50"
              >
                {pending ? "Saving…" : "Save"}
              </button>
              <p className="text-[12px] text-stone-500 dark:text-stone-400">
                Renames the display name only — slug and URL stay the same.
              </p>
            </div>

            {error && <div className="text-[12px] text-red-600 dark:text-red-400">{error}</div>}
          </div>
        </div>
      )}
    </div>
  );
}
```

- [ ] **Step 3: Add imports to the product page**

In `web/src/app/[orgSlug]/product/[productSlug]/page.tsx`, after the existing import block (e.g. after the `getAppInfo` import on line 15), add:

```typescript
import { ProductAdminMenu } from "@/components/product-admin-menu";
import { isLocalAdminEnabled } from "@/lib/local-admin-flag";
```

- [ ] **Step 4: Compute the admin gate inside the page component**

In the same file, inside `ProductPage`, after:

```typescript
const orgName = org.name;
```

add:

```typescript
const adminEnabled = isLocalAdminEnabled();
```

- [ ] **Step 5: Render the menu below the CLI command**

In the same file, find:

```tsx
        <CliCommand identifier={product.slug} />

        <div className="flex flex-col md:flex-row gap-10 mt-6 pb-6">
```

Replace it with:

```tsx
        <CliCommand identifier={product.slug} />
        {adminEnabled && (
          <div className="mt-2">
            <ProductAdminMenu orgSlug={orgSlug} productSlug={productSlug} name={product.name} />
          </div>
        )}

        <div className="flex flex-col md:flex-row gap-10 mt-6 pb-6">
```

- [ ] **Step 6: Type-check**

Run:

```bash
cd web && npx tsc --noEmit; cd ..
```

Expected: no errors.

- [ ] **Step 7: Lint**

```bash
bun run lint
```

Expected: no new errors in the touched files.

- [ ] **Step 8: Commit**

```bash
git add web/src/app/actions/product-admin.ts web/src/components/product-admin-menu.tsx "web/src/app/[orgSlug]/product/[productSlug]/page.tsx"
git commit -m "feat(web): add product admin menu with display-name rename"
```

---

## Task 4: Full verification + manual smoke

**Files:** none (verification only)

- [ ] **Step 1: Format check**

Run from the worktree root:

```bash
bun run format:check
```

Expected: passes (lint-staged also runs prettier on commit, so this should already be clean).

- [ ] **Step 2: Full type-check (root + web)**

```bash
npx tsc --noEmit && (cd web && npx tsc --noEmit)
```

Expected: no errors. (Root `tsc` checks `src/`; the web app has its own tsconfig.)

- [ ] **Step 3: Lint the full repo**

```bash
bun run lint
```

Expected: no errors.

- [ ] **Step 4: Manual smoke in local dev**

The admin menus only render when `isLocalAdminEnabled()` is true — i.e. `NODE_ENV !== production` and an API key (`RELEASES_API_KEY`) is configured. Start the web dev server:

```bash
bun run dev:web
```

Then in the browser (Claude for Chrome — the worktree-prefixed host, e.g. `https://admin-rename-display-name.releases.localhost`):

1. Open an **org** page → click **Admin** → the "Display name" field shows the current name. Edit it, click **Save**. The menu closes and the heading shows the new name after refresh. Confirm the URL/slug is unchanged.
2. Open a **product** page (`/<org>/product/<slug>`) → an **Admin** button now appears below the CLI command → rename → verify.
3. Open a **source** page → **Admin** → rename → verify.
4. Confirm Save is disabled when the field is empty or unchanged.

- [ ] **Step 5: Confirm clean tree**

```bash
git status
```

Expected: nothing uncommitted (all task commits landed).

---

## Self-Review

- **Spec coverage:** org rename (Task 2), product rename (Task 3), source rename (Task 1), new product menu (Task 3), `isLocalAdminEnabled` gate (Task 3 Step 4–5; org/source inherit existing gates), no API/schema changes (confirmed — actions only PATCH `name`), verification (Task 4). All spec sections map to a task.
- **Placeholder scan:** no TBD/TODO; every code step shows full code; every command shows expected output.
- **Type consistency:** action names (`renameOrgAction`, `renameSourceAction`, `renameProductAction`) and their input shapes are consistent between the action files and the menu call sites; the `name: string` prop is added in both the type and destructure of each menu; `canRename`/`nameDraft`/`setNameDraft` are defined before use in each component.
