# Dev-mode Admin AI-Feature Toggles — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Surface the org `auto_generate_content` flag (overviews + summaries) and the per-source `marketingFilter` / `feedContentDepth` flags as toggles in the web app's dev-mode admin menus, plus read-only visibility of `discovery` / `fetchPaused` / `isHidden`.

**Architecture:** The org flag gets a small API addition (one write field on `PATCH /v1/orgs/:slug`, three read fields on the org-detail GET). The source flags already have a read path (`metadata` JSON on source detail) and a write path (`PATCH …/sources/:s/metadata` shallow-merge), so the source work is web-only. The web layer adds two server actions and one new dropdown component (`SourceAdminMenu`), extends `OrgAdminMenu`, and retires the now-redundant standalone Promote button.

**Tech Stack:** Bun, TypeScript (strict), Cloudflare Worker + Hono + Drizzle (`workers/api/`), Zod wire schemas (`packages/api-types/`), Next.js App Router server actions + client components (`web/`). Tests: `bun test`.

**Spec:** `docs/superpowers/specs/2026-05-21-admin-menu-ai-feature-toggles-design.md`

---

## Prelude: worktree dependencies

This plan runs in an isolated worktree. Per project memory, a new worktree has no `node_modules` and package edits silently resolve to the main checkout until you install. Run this once before anything else:

- [ ] **Step 0: Install deps in the worktree**

Run: `bun install`
Expected: completes; `node_modules/` populated in the worktree root.

---

## Task 1: API — org `autoGenerateContent` write + read

Adds the write field to the org PATCH body and the three read fields to the org-detail GET. One round-trip route test (PATCH then GET) covers both ends.

**Files:**

- Modify: `packages/api-types/src/schemas/orgs.ts` (`UpdateOrgBodySchema` ~95-108, `OrgDetailSchema` ~391-415)
- Modify: `workers/api/src/routes/orgs.ts` (PATCH body type ~571-582 + updates ~633-634; GET `result` ~400-429)
- Test: `workers/api/test/org-auto-generate-content.test.ts` (new)

- [ ] **Step 1: Write the failing test**

Create `workers/api/test/org-auto-generate-content.test.ts`:

```ts
import { describe, it, expect } from "bun:test";
import { organizations } from "@buildinternet/releases-core/schema";
import { orgRoutes } from "../src/routes/orgs.js";
import { createTestDb as mkDb, createTestApp } from "./setup";

const mkApp = (db: ReturnType<typeof mkDb>) => createTestApp(db, orgRoutes);

async function seed(db: ReturnType<typeof mkDb>) {
  await db
    .insert(organizations)
    .values([{ id: "org_acme", slug: "acme", name: "Acme", discovery: "curated" }]);
}

describe("PATCH /v1/orgs/:slug — autoGenerateContent", () => {
  it("persists autoGenerateContent and the GET detail reflects it", async () => {
    const db = mkDb();
    await seed(db);
    const app = mkApp(db);

    // Defaults false before the toggle.
    const before = await app(new Request("https://x.test/v1/orgs/acme"));
    expect(before.status).toBe(200);
    const beforeBody = (await before.json()) as {
      autoGenerateContent?: boolean;
      discovery?: string;
      fetchPaused?: boolean;
    };
    expect(beforeBody.autoGenerateContent).toBe(false);
    expect(beforeBody.discovery).toBe("curated");
    expect(beforeBody.fetchPaused).toBe(false);

    // Flip it on.
    const patch = await app(
      new Request("https://x.test/v1/orgs/acme", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ autoGenerateContent: true }),
      }),
    );
    expect(patch.status).toBe(200);

    // GET detail reflects the new value.
    const after = await app(new Request("https://x.test/v1/orgs/acme"));
    const afterBody = (await after.json()) as { autoGenerateContent?: boolean };
    expect(afterBody.autoGenerateContent).toBe(true);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test workers/api/test/org-auto-generate-content.test.ts`
Expected: FAIL — `beforeBody.autoGenerateContent` is `undefined` (GET detail doesn't return it yet), or the PATCH ignores the field.

- [ ] **Step 3: Add the write field to `UpdateOrgBodySchema`**

In `packages/api-types/src/schemas/orgs.ts`, inside `UpdateOrgBodySchema` (after the `isHidden` line ~107):

```ts
  /** Admin-only: opt the org into automatic AI content — org overviews AND per-release summaries (single backend flag `auto_generate_content`). */
  autoGenerateContent: z.boolean().optional(),
```

- [ ] **Step 4: Add the read fields to `OrgDetailSchema`**

In the same file, inside `OrgDetailSchema` (after the `isHidden` line ~400):

```ts
  /** Admin display flag: org is opted into automatic overviews + per-release summaries. Optional on the wire for older workers mid-deploy. */
  autoGenerateContent: z.boolean().optional(),
  /** Admin display flag: all ingest paused for this org. */
  fetchPaused: z.boolean().optional(),
  /** How the org row was created. `on_demand` orgs are excluded from overview generation regardless of `autoGenerateContent`. */
  discovery: z.enum(["curated", "agent", "on_demand"]).optional(),
```

- [ ] **Step 5: Wire the write field in the PATCH handler**

In `workers/api/src/routes/orgs.ts`, add `autoGenerateContent?: boolean;` to the body type object (the block starting ~571 that lists `fetchPaused?: boolean; isHidden?: boolean;`):

```ts
      fetchPaused?: boolean;
      isHidden?: boolean;
      autoGenerateContent?: boolean;
    } = { ...c.req.valid("json") };
```

Then in the `updates` assembly (after the `isHidden` line ~634):

```ts
if (body.autoGenerateContent !== undefined) updates.autoGenerateContent = body.autoGenerateContent;
```

- [ ] **Step 6: Wire the read fields in the GET detail handler**

In the same file, in the hand-built `result` object (~400-429), after `isHidden: org.isHidden,`:

```ts
      autoGenerateContent: org.autoGenerateContent,
      fetchPaused: org.fetchPaused,
      discovery: org.discovery,
```

- [ ] **Step 7: Run test to verify it passes**

Run: `bun test workers/api/test/org-auto-generate-content.test.ts`
Expected: PASS.

- [ ] **Step 8: Type-check the worker + api-types**

Run: `npx tsc --noEmit && (cd workers/api && npx tsc --noEmit)`
Expected: no errors.

- [ ] **Step 9: Commit**

```bash
git add packages/api-types/src/schemas/orgs.ts workers/api/src/routes/orgs.ts workers/api/test/org-auto-generate-content.test.ts
git commit -m "feat(api): expose org autoGenerateContent on PATCH + detail GET"
```

---

## Task 2: Web — org auto-content server action

Adds `setOrgAutoGenerateContentAction`, a thin mirror of the existing `setOrgHiddenAction`.

**Files:**

- Modify: `web/src/app/actions/org-admin.ts`

- [ ] **Step 1: Add the action**

In `web/src/app/actions/org-admin.ts`, after `setOrgHiddenAction`:

```ts
export async function setOrgAutoGenerateContentAction(input: {
  slug: string;
  enabled: boolean;
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
      body: JSON.stringify({ autoGenerateContent: input.enabled }),
      cache: "no-store",
    });
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : "Network error" };
  }

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    return { ok: false, error: `API ${res.status}: ${text || res.statusText}` };
  }

  // Auto-content state shows on the org detail page only.
  revalidatePath(`/${input.slug}`);
  return { ok: true };
}
```

- [ ] **Step 2: Type-check web**

Run: `cd web && npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add web/src/app/actions/org-admin.ts
git commit -m "feat(web): add setOrgAutoGenerateContentAction"
```

---

## Task 3: Web — OrgAdminMenu auto-content toggle + read-only state

Extends the org admin dropdown with the second toggle and a read-only state section, and wires the new props from the org layout.

**Files:**

- Modify: `web/src/components/org-admin-menu.tsx` (full rewrite of the component body)
- Modify: `web/src/app/[orgSlug]/(org)/layout.tsx` (mount ~100-104)

- [ ] **Step 1: Rewrite `org-admin-menu.tsx`**

Replace the entire file with:

```tsx
"use client";

import { useEffect, useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { setOrgHiddenAction, setOrgAutoGenerateContentAction } from "@/app/actions/org-admin";

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
  const [open, setOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
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

  function run(action: () => Promise<{ ok: true } | { ok: false; error: string }>) {
    startTransition(async () => {
      setError(null);
      const res = await action();
      if (!res.ok) {
        setError(res.error);
        return;
      }
      router.refresh();
    });
  }

  const onDemand = discovery === "on_demand";
  const buttonLabel = isHidden ? "Admin · Hidden" : autoGenerateContent ? "Admin · AI" : "Admin";

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
        {buttonLabel}
      </button>
      {open && (
        <div
          role="menu"
          className="absolute left-0 top-full mt-1 z-20 w-80 rounded-md border border-stone-200 dark:border-stone-800 bg-white dark:bg-stone-950 shadow-lg text-[13px] overflow-hidden"
        >
          <div className="p-3 space-y-3">
            <div className="space-y-2">
              <div className="font-medium text-stone-700 dark:text-stone-200">Listings</div>
              <p className="text-[12px] text-stone-500 dark:text-stone-400">
                {isHidden
                  ? "Hidden from the homepage ticker and the org directory. Still reachable by direct link, search, and sitemap."
                  : "Visible in the homepage ticker and the org directory. Hiding keeps direct link, search, and sitemap."}
              </p>
              <button
                type="button"
                onClick={() => run(() => setOrgHiddenAction({ slug: orgSlug, hidden: !isHidden }))}
                disabled={pending}
                className="w-full px-2 py-1 rounded border border-stone-300 dark:border-stone-700 bg-stone-50 hover:bg-stone-100 dark:bg-stone-900 dark:hover:bg-stone-800 text-stone-700 dark:text-stone-200 disabled:opacity-50"
              >
                {pending ? "Saving…" : isHidden ? "Unhide from listings" : "Hide from listings"}
              </button>
            </div>

            <div className="space-y-2 border-t border-stone-200 dark:border-stone-800 pt-3">
              <div className="font-medium text-stone-700 dark:text-stone-200">
                Auto-generate AI content
              </div>
              <p className="text-[12px] text-stone-500 dark:text-stone-400">
                Generates org overviews and per-release AI summaries on ingest.
                {onDemand
                  ? " Note: on-demand orgs are skipped for overviews regardless of this flag (summaries still run)."
                  : ""}
              </p>
              <button
                type="button"
                onClick={() =>
                  run(() =>
                    setOrgAutoGenerateContentAction({
                      slug: orgSlug,
                      enabled: !autoGenerateContent,
                    }),
                  )
                }
                disabled={pending}
                className="w-full px-2 py-1 rounded border border-stone-300 dark:border-stone-700 bg-stone-50 hover:bg-stone-100 dark:bg-stone-900 dark:hover:bg-stone-800 text-stone-700 dark:text-stone-200 disabled:opacity-50"
              >
                {pending
                  ? "Saving…"
                  : autoGenerateContent
                    ? "Disable AI content"
                    : "Enable AI content"}
              </button>
            </div>

            <div className="space-y-1 border-t border-stone-200 dark:border-stone-800 pt-3">
              <div className="font-medium text-stone-700 dark:text-stone-200">State</div>
              <dl className="text-[12px] text-stone-500 dark:text-stone-400 space-y-0.5">
                <div className="flex justify-between gap-2">
                  <dt>Discovery</dt>
                  <dd className="font-mono">{discovery ?? "—"}</dd>
                </div>
                <div className="flex justify-between gap-2">
                  <dt>Fetch paused</dt>
                  <dd className="font-mono">{fetchPaused ? "true" : "false"}</dd>
                </div>
              </dl>
            </div>

            {error && <div className="text-[12px] text-red-600 dark:text-red-400">{error}</div>}
          </div>
        </div>
      )}
    </div>
  );
}
```

- [ ] **Step 2: Wire props in the org layout**

In `web/src/app/[orgSlug]/(org)/layout.tsx`, replace the `OrgAdminMenu` mount (~102):

```tsx
<OrgAdminMenu
  orgSlug={org.slug}
  isHidden={org.isHidden ?? false}
  autoGenerateContent={org.autoGenerateContent ?? false}
  discovery={org.discovery}
  fetchPaused={org.fetchPaused}
/>
```

- [ ] **Step 3: Type-check web**

Run: `cd web && npx tsc --noEmit`
Expected: no errors. (`org.autoGenerateContent` / `org.discovery` / `org.fetchPaused` resolve via the `OrgDetailSchema` additions from Task 1.)

- [ ] **Step 4: Commit**

```bash
git add web/src/components/org-admin-menu.tsx "web/src/app/[orgSlug]/(org)/layout.tsx"
git commit -m "feat(web): org admin menu auto-content toggle + read-only state"
```

---

## Task 4: Web — source admin server actions module

Creates `source-admin.ts` with the metadata-merge action and the relocated `promoteSourceAction`.

**Files:**

- Create: `web/src/app/actions/source-admin.ts`

- [ ] **Step 1: Create the module**

Create `web/src/app/actions/source-admin.ts`:

```ts
"use server";

import { revalidatePath } from "next/cache";
import { webApiHeaders } from "@/lib/api";
import { adminActionEnv } from "@/lib/admin-action";

type ActionResult = { ok: true } | { ok: false; error: string };

/**
 * Shallow-merge a patch into the source's `metadata` blob via
 * `PATCH /v1/orgs/:orgSlug/sources/:sourceSlug/metadata`. A `null` value for a
 * key deletes that key server-side; all other keys are merged.
 */
export async function setSourceMetadataAction(input: {
  orgSlug: string;
  sourceSlug: string;
  patch: Record<string, unknown>;
}): Promise<ActionResult> {
  const env = adminActionEnv();
  if ("error" in env) return { ok: false, error: env.error };

  const path = `/v1/orgs/${encodeURIComponent(input.orgSlug)}/sources/${encodeURIComponent(input.sourceSlug)}/metadata`;
  let res: Response;
  try {
    res = await fetch(`${env.apiUrl}${path}`, {
      method: "PATCH",
      headers: webApiHeaders({
        "Content-Type": "application/json",
        Authorization: `Bearer ${env.apiSecret}`,
      }),
      body: JSON.stringify(input.patch),
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
  return { ok: true };
}

/**
 * Un-hide an on-demand source so it appears in listings, sitemap, and AI
 * features. Sets `isHidden: false` via the org-scoped source PATCH.
 */
export async function promoteSourceAction(input: {
  orgSlug: string;
  sourceSlug: string;
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
      body: JSON.stringify({ isHidden: false }),
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

- [ ] **Step 2: Type-check web**

Run: `cd web && npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add web/src/app/actions/source-admin.ts
git commit -m "feat(web): source admin server actions (metadata merge + promote)"
```

---

## Task 5: Web — SourceAdminMenu component

New dropdown with marketing-classifier toggle (+ hint), feed-content-depth control, conditional Promote, and read-only state.

**Files:**

- Create: `web/src/components/source-admin-menu.tsx`

- [ ] **Step 1: Create the component**

Create `web/src/components/source-admin-menu.tsx`:

```tsx
"use client";

import { useEffect, useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { setSourceMetadataAction, promoteSourceAction } from "@/app/actions/source-admin";

type Depth = "full" | "summary-only" | null;

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
  const [open, setOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [hint, setHint] = useState(marketingFilterHint ?? "");
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

  // Keep the hint field in sync when the source data refreshes.
  useEffect(() => {
    setHint(marketingFilterHint ?? "");
  }, [marketingFilterHint]);

  function run(action: () => Promise<{ ok: true } | { ok: false; error: string }>) {
    startTransition(async () => {
      setError(null);
      const res = await action();
      if (!res.ok) {
        setError(res.error);
        return;
      }
      router.refresh();
    });
  }

  const canPromote = discovery === "on_demand" && isHidden;
  const depthBtn = (label: string, value: Depth) => (
    <button
      type="button"
      key={label}
      onClick={() =>
        run(() =>
          setSourceMetadataAction({ orgSlug, sourceSlug, patch: { feedContentDepth: value } }),
        )
      }
      disabled={pending}
      aria-pressed={feedContentDepth === value}
      className={`flex-1 px-2 py-1 rounded border text-[12px] disabled:opacity-50 ${
        feedContentDepth === value
          ? "border-stone-500 dark:border-stone-400 bg-stone-200 dark:bg-stone-700 text-stone-900 dark:text-stone-100"
          : "border-stone-300 dark:border-stone-700 bg-stone-50 hover:bg-stone-100 dark:bg-stone-900 dark:hover:bg-stone-800 text-stone-700 dark:text-stone-200"
      }`}
    >
      {label}
    </button>
  );

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
              <div className="font-medium text-stone-700 dark:text-stone-200">
                Marketing classifier
              </div>
              <p className="text-[12px] text-stone-500 dark:text-stone-400">
                Runs each new feed item through the Haiku marketing classifier on ingest; items
                judged marketing are suppressed.
              </p>
              <button
                type="button"
                onClick={() =>
                  run(() =>
                    setSourceMetadataAction({
                      orgSlug,
                      sourceSlug,
                      patch: { marketingFilter: !marketingFilter },
                    }),
                  )
                }
                disabled={pending}
                className="w-full px-2 py-1 rounded border border-stone-300 dark:border-stone-700 bg-stone-50 hover:bg-stone-100 dark:bg-stone-900 dark:hover:bg-stone-800 text-stone-700 dark:text-stone-200 disabled:opacity-50"
              >
                {pending ? "Saving…" : marketingFilter ? "Disable classifier" : "Enable classifier"}
              </button>
              {marketingFilter && (
                <div className="space-y-1">
                  <textarea
                    value={hint}
                    onChange={(e) => setHint(e.target.value)}
                    rows={2}
                    placeholder="Optional hint for the classifier prompt…"
                    className="w-full px-2 py-1 rounded border border-stone-300 dark:border-stone-700 bg-white dark:bg-stone-900 text-stone-700 dark:text-stone-200 text-[12px]"
                  />
                  <button
                    type="button"
                    onClick={() =>
                      run(() =>
                        setSourceMetadataAction({
                          orgSlug,
                          sourceSlug,
                          patch: { marketingFilterHint: hint.trim() || null },
                        }),
                      )
                    }
                    disabled={pending}
                    className="w-full px-2 py-1 rounded border border-stone-300 dark:border-stone-700 bg-stone-50 hover:bg-stone-100 dark:bg-stone-900 dark:hover:bg-stone-800 text-stone-700 dark:text-stone-200 disabled:opacity-50"
                  >
                    {pending ? "Saving…" : "Save hint"}
                  </button>
                </div>
              )}
            </div>

            <div className="space-y-2 border-t border-stone-200 dark:border-stone-800 pt-3">
              <div className="font-medium text-stone-700 dark:text-stone-200">
                Feed content depth
              </div>
              <p className="text-[12px] text-stone-500 dark:text-stone-400">
                Marks summary-only feeds for enrichment. Enrichment also requires the API
                worker&apos;s FEED_ENRICH_ENABLED (on in prod) and only acts on summary-only.
              </p>
              <div className="flex gap-1.5">
                {depthBtn("Auto", null)}
                {depthBtn("Full", "full")}
                {depthBtn("Summary-only", "summary-only")}
              </div>
            </div>

            {canPromote && (
              <div className="space-y-2 border-t border-stone-200 dark:border-stone-800 pt-3">
                <div className="font-medium text-stone-700 dark:text-stone-200">Promote source</div>
                <p className="text-[12px] text-stone-500 dark:text-stone-400">
                  Un-hide this on-demand source so it appears in listings, sitemap, and AI features.
                </p>
                <button
                  type="button"
                  onClick={() => run(() => promoteSourceAction({ orgSlug, sourceSlug }))}
                  disabled={pending}
                  className="w-full px-2 py-1 rounded border border-stone-300 dark:border-stone-700 bg-stone-50 hover:bg-stone-100 dark:bg-stone-900 dark:hover:bg-stone-800 text-stone-700 dark:text-stone-200 disabled:opacity-50"
                >
                  {pending ? "Promoting…" : "Promote source"}
                </button>
              </div>
            )}

            <div className="space-y-1 border-t border-stone-200 dark:border-stone-800 pt-3">
              <div className="font-medium text-stone-700 dark:text-stone-200">State</div>
              <dl className="text-[12px] text-stone-500 dark:text-stone-400 space-y-0.5">
                <div className="flex justify-between gap-2">
                  <dt>Discovery</dt>
                  <dd className="font-mono">{discovery ?? "—"}</dd>
                </div>
                <div className="flex justify-between gap-2">
                  <dt>Hidden</dt>
                  <dd className="font-mono">{isHidden ? "true" : "false"}</dd>
                </div>
              </dl>
            </div>

            {error && <div className="text-[12px] text-red-600 dark:text-red-400">{error}</div>}
          </div>
        </div>
      )}
    </div>
  );
}
```

- [ ] **Step 2: Type-check web**

Run: `cd web && npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add web/src/components/source-admin-menu.tsx
git commit -m "feat(web): SourceAdminMenu (marketing filter + feed depth + promote)"
```

---

## Task 6: Web — mount SourceAdminMenu, retire standalone Promote

Swaps the source layout to render `SourceAdminMenu` (gated by `isLocalAdminEnabled`) and deletes the now-redundant button, flag, and old action file.

**Files:**

- Modify: `web/src/app/[orgSlug]/[sourceSlug]/layout.tsx`
- Delete: `web/src/components/promote-source-button.tsx`
- Delete: `web/src/lib/promote-source-flag.ts`
- Delete: `web/src/app/actions/promote-source.ts`

- [ ] **Step 1: Update the source layout imports**

In `web/src/app/[orgSlug]/[sourceSlug]/layout.tsx`, replace the two promote imports (~14-15):

```tsx
import { PromoteSourceButton } from "@/components/promote-source-button";
import { isPromoteSourceEnabled } from "@/lib/promote-source-flag";
```

with:

```tsx
import { SourceAdminMenu } from "@/components/source-admin-menu";
import { isLocalAdminEnabled } from "@/lib/local-admin-flag";
```

- [ ] **Step 2: Replace the gate + parse metadata**

In the same file, replace the `showPromoteButton` line (~85-86):

```tsx
const showPromoteButton =
  source.discovery === "on_demand" && source.isHidden && isPromoteSourceEnabled();
```

with:

```tsx
const adminEnabled = isLocalAdminEnabled();
const sourceMeta = (() => {
  try {
    return JSON.parse(source.metadata || "{}") as {
      marketingFilter?: boolean;
      marketingFilterHint?: string;
      feedContentDepth?: "full" | "summary-only";
    };
  } catch {
    return {};
  }
})();
```

- [ ] **Step 3: Replace the mount**

In the same file, replace the `PromoteSourceButton` block (~112-114):

```tsx
{
  showPromoteButton && <PromoteSourceButton orgSlug={source.org.slug} sourceSlug={source.slug} />;
}
```

with:

```tsx
{
  adminEnabled && (
    <SourceAdminMenu
      orgSlug={source.org.slug}
      sourceSlug={source.slug}
      marketingFilter={sourceMeta.marketingFilter === true}
      marketingFilterHint={sourceMeta.marketingFilterHint ?? null}
      feedContentDepth={sourceMeta.feedContentDepth ?? null}
      discovery={source.discovery}
      isHidden={source.isHidden ?? false}
    />
  );
}
```

- [ ] **Step 4: Delete the retired files**

```bash
git rm web/src/components/promote-source-button.tsx web/src/lib/promote-source-flag.ts web/src/app/actions/promote-source.ts
```

- [ ] **Step 5: Confirm no dangling references**

Run: `grep -rn "promote-source-button\|promote-source-flag\|isPromoteSourceEnabled\|app/actions/promote-source" web/src`
Expected: no matches.

- [ ] **Step 6: Type-check web**

Run: `cd web && npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 7: Commit**

```bash
git add "web/src/app/[orgSlug]/[sourceSlug]/layout.tsx"
git commit -m "feat(web): mount SourceAdminMenu, retire standalone Promote button"
```

---

## Task 7: Full verification

**Files:** none (verification only)

- [ ] **Step 1: Run the full gate set from the repo root**

Run: `npx tsc --noEmit && (cd workers/api && npx tsc --noEmit) && (cd web && npx tsc --noEmit) && bun test && bun run lint && bun run format:check`
Expected: type-check clean across root + both workers, all tests pass, lint clean, format clean.

- [ ] **Step 2: Manual browser smoke (best-effort, dev only)**

Start the web + api dev servers (`bun run dev:api` and `bun run dev:web`, reachable via the worktree-prefixed portless hosts). With `RELEASED_API_KEY` set so `isLocalAdminEnabled()` is true:

- On an org page, open **Admin** → toggle **Enable AI content** → confirm the `PATCH /v1/orgs/:slug` fires (network) and after refresh the button reads **Admin · AI** and the State block shows the org's discovery/fetchPaused.
- On a source page, open **Admin** → toggle the marketing classifier, save a hint, switch feed content depth between Auto/Full/Summary-only → confirm each `PATCH …/metadata` fires and the selected depth highlights after refresh.
- On an on-demand hidden source, confirm **Promote source** appears and un-hides.

Document any deviation. If a dev server can't be started in this environment, note that the automated gate in Step 1 is the binding verification and the browser smoke is deferred to the reviewer.

- [ ] **Step 3: Final commit (if any verification fixups were needed)**

```bash
git add -A && git commit -m "chore: verification fixups for admin AI-feature toggles"
```

---

## Self-review notes

- **Spec coverage:** org combined toggle → Task 1-3; source marketingFilter (+hint) → Task 4-5; feedContentDepth → Task 5; read-only discovery/fetchPaused/isHidden → Task 3 (org) + Task 5 (source); Promote folded in + retirements → Task 5-6; no migration (column exists) → confirmed Task 1; gating unchanged (`isLocalAdminEnabled`) → Task 3/6.
- **Non-goals honored:** no second column for overviews-vs-summaries; no write toggles for org fetchPaused / source isHidden (read-only only); no eligibility-query or env-switch changes.
- **Type consistency:** `setOrgAutoGenerateContentAction({ slug, enabled })`, `setSourceMetadataAction({ orgSlug, sourceSlug, patch })`, `promoteSourceAction({ orgSlug, sourceSlug })`, `SourceAdminMenu` `Depth = "full" | "summary-only" | null`, and the `OrgDetailSchema` field names (`autoGenerateContent`, `fetchPaused`, `discovery`) are used identically across tasks.
