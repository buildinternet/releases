# Compact App Store Release Presentation — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Render App Store-sourced releases (`source.type === "appstore"`) as a compact, app-aware feed row — app icon + "{AppName} v{version}" + "Available for iOS/macOS", expandable to release notes — instead of the standard version/notes/screenshot-thumbnail layout, and drop App Store screenshots from the feed rows and the release detail page.

**Architecture:** The app icon + platform already live on each appstore source row in `source.metadata.appStore` (`artworkUrl`, `platform`). They are not yet on the read wire. We thread a minimal `{ platform, iconUrl }` block onto the feed item's `source` object (org feed) and the release-detail payload, parsed server-side by a pure helper. The web `ReleaseListItem` gains a branch that renders the compact app row when given app info; the org feed derives it per row from the wire field, and the source page derives it once from its own source via the existing `getAppInfo`. The detail page suppresses screenshots and adds a platform byline.

**Tech Stack:** TypeScript (strict), Zod (`@buildinternet/releases-api-types`), Cloudflare Worker + raw D1 (`workers/api`), Next.js (`web/`), Drizzle (tests), `bun test`.

**Spec:** `docs/superpowers/specs/2026-05-27-mobile-appstore-feed-row-design.md`

---

## File Structure

**API contract (`packages/api-types/`)**
- `src/schemas/shared.ts` — new `AppStoreSourceInfoSchema` (single source of truth for the `{platform, iconUrl}` shape).
- `src/schemas/orgs.ts` — `OrgReleaseItemSchema.source` gains optional `appStore`.
- `src/schemas/releases.ts` — `ReleaseDetailResponseSchema` gains nullable/optional `appStore`.
- `src/api-types.ts` — hand-written `ReleaseDetail` interface gains `appStore`; export inferred `AppStoreSourceInfo` type.
- `test/appstore-source-info.test.ts` — schema parse tests.

**Server helper (`packages/adapters/`)**
- `src/appstore.ts` — new pure `appStoreSourceInfo(type, metadataJson)` returning `{platform, iconUrl} | null`.
- `src/appstore.test.ts` — helper unit tests.

**Org feed (`workers/api/`)**
- `src/queries/orgs.ts` — `OrgReleaseRow` type + the feed SELECT gain `source_metadata`.
- `src/routes/orgs.ts` — the feed item `.map` attaches `appStore`.
- `test/org-feed-appstore-metadata.test.ts` — query returns `source_metadata`.

**Detail handler (`workers/api/`)**
- `src/routes/sources.ts` — `GET /v1/releases/:id` selects `sources.metadata` and attaches `appStore`.
- `test/release-detail-appstore.test.ts` — handler surfaces `appStore`.

**Web (`web/`)**
- `src/lib/app-source.ts` — new `AppRowInfo` type + `appStoreIconUrl(url, px)` mzstatic resizer.
- `src/lib/app-source.test.ts` — `appStoreIconUrl` tests.
- `src/components/release-item.tsx` — `ReleaseListItem` gains an `appStore` prop + compact branch.
- `src/components/org-release-list.tsx` — derives `appStore` per row from `release.source.appStore`.
- `src/components/source-release-list.tsx` — accepts an `appStore` prop, passes it to every row.
- `src/app/sources/[id]/page.tsx` — derives `appStore` via `getAppInfo` and passes it to `SourceReleaseList`.
- `src/app/release/[id]/page.tsx` — suppresses screenshots + renders the platform byline for appstore.

**Note on test coverage:** the `.tsx` components/pages have no unit-test harness in this repo (web tests cover `lib/` + routes only), so Tasks 5–8 web edits are verified by `tsc` + manual browser check (Task 9). The wire contract, the two pure helpers, and both worker read paths are covered by `bun test`.

---

## Task 1: API contract — `AppStoreSourceInfo` schema + wire fields

**Files:**
- Modify: `packages/api-types/src/schemas/shared.ts`
- Modify: `packages/api-types/src/schemas/orgs.ts:337-339`
- Modify: `packages/api-types/src/schemas/releases.ts:140-163`
- Modify: `packages/api-types/src/api-types.ts` (ReleaseDetail interface ~668-697)
- Test: `packages/api-types/test/appstore-source-info.test.ts`

- [ ] **Step 1: Write the failing test**

Create `packages/api-types/test/appstore-source-info.test.ts`:

```ts
import { describe, it, expect } from "bun:test";
import { OrgReleaseItemSchema } from "../src/schemas/orgs";

const base = {
  version: "3.12.0",
  title: "Notion 3.12.0",
  summary: "",
  publishedAt: null,
  url: null,
  source: { slug: "notion-ios", name: "Notion", type: "appstore" },
};

describe("OrgReleaseItem source.appStore", () => {
  it("accepts an appStore block on the source", () => {
    const r = OrgReleaseItemSchema.safeParse({
      ...base,
      source: { ...base.source, appStore: { platform: "ios", iconUrl: "https://x/1024x1024bb.png" } },
    });
    expect(r.success).toBe(true);
  });

  it("accepts a source with no appStore (non-app source)", () => {
    const r = OrgReleaseItemSchema.safeParse(base);
    expect(r.success).toBe(true);
  });

  it("accepts a null iconUrl", () => {
    const r = OrgReleaseItemSchema.safeParse({
      ...base,
      source: { ...base.source, appStore: { platform: "macos", iconUrl: null } },
    });
    expect(r.success).toBe(true);
  });

  it("rejects an invalid platform", () => {
    const r = OrgReleaseItemSchema.safeParse({
      ...base,
      source: { ...base.source, appStore: { platform: "android", iconUrl: null } },
    });
    expect(r.success).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test packages/api-types/test/appstore-source-info.test.ts`
Expected: FAIL — the "rejects an invalid platform" case fails because `source` is currently an open `z.object({ slug, name, type })` that ignores the extra `appStore` key (so the bad platform isn't validated).

- [ ] **Step 3: Add `AppStoreSourceInfoSchema` to shared.ts**

In `packages/api-types/src/schemas/shared.ts`, after `MediaItemSchema` (around line 12), add:

```ts
/**
 * App Store platform + icon for a `type: "appstore"` source. Threaded onto
 * read surfaces so the UI can render the compact app-update row (app icon +
 * "Available for iOS/macOS") instead of the standard version/notes/thumbnail
 * layout. Sourced from `source.metadata.appStore` server-side. #mobile-appstore-feed-row
 */
export const AppStoreSourceInfoSchema = z.object({
  platform: z.enum(["ios", "macos"]),
  iconUrl: z.string().nullable(),
});
```

- [ ] **Step 4: Extend the org feed source shape**

In `packages/api-types/src/schemas/orgs.ts`, add `AppStoreSourceInfoSchema` to the shared-schema import (line 8 region imports `ReleaseItemSchema` from `"./shared.js"`), then change lines 337-339:

```ts
export const OrgReleaseItemSchema = ReleaseItemSchema.extend({
  source: z.object({
    slug: z.string(),
    name: z.string(),
    type: z.string(),
    appStore: AppStoreSourceInfoSchema.optional(),
  }),
});
```

- [ ] **Step 5: Extend the release-detail schema + interface**

In `packages/api-types/src/schemas/releases.ts`, add `AppStoreSourceInfoSchema` to the `"./shared.js"` import (line 3), then add to `ReleaseDetailResponseSchema` (after `composition`, line 162):

```ts
  composition: ReleaseCompositionSchema.nullable(),
  appStore: AppStoreSourceInfoSchema.nullable().optional(),
});
```

In `packages/api-types/src/api-types.ts`, add to the `ReleaseDetail` interface (after `composition?`, ~line 696):

```ts
  composition?: ReleaseComposition | null;
  /** App Store platform + icon, present only when `sourceType === "appstore"`. */
  appStore?: { platform: "ios" | "macos"; iconUrl: string | null } | null;
}
```

Also export the inferred type — in `packages/api-types/src/api-types.ts` near the other `z.infer` exports (e.g. `OrgReleaseItem` at ~line 527), add:

```ts
export type AppStoreSourceInfo = import("zod").z.infer<typeof import("./schemas/shared.js").AppStoreSourceInfoSchema>;
```

(If the file already imports the schema namespace, prefer a direct `z.infer<typeof AppStoreSourceInfoSchema>` matching the existing pattern in that file rather than the inline `import(...)` form.)

- [ ] **Step 6: Run test to verify it passes**

Run: `bun test packages/api-types/test/appstore-source-info.test.ts`
Expected: PASS (all 4 cases).

- [ ] **Step 7: Type-check the package**

Run: `cd packages/api-types && npx tsc --noEmit && cd -`
Expected: no errors.

- [ ] **Step 8: Commit**

```bash
git add packages/api-types/src/schemas/shared.ts packages/api-types/src/schemas/orgs.ts packages/api-types/src/schemas/releases.ts packages/api-types/src/api-types.ts packages/api-types/test/appstore-source-info.test.ts
git commit -m "feat(api-types): thread appStore {platform,iconUrl} onto org-feed + release-detail wire"
```

---

## Task 2: Server helper `appStoreSourceInfo` (pure)

**Files:**
- Modify: `packages/adapters/src/appstore.ts`
- Test: `packages/adapters/src/appstore.test.ts`

- [ ] **Step 1: Write the failing test**

Create `packages/adapters/src/appstore.test.ts`:

```ts
import { describe, it, expect } from "bun:test";
import { appStoreSourceInfo } from "./appstore";

describe("appStoreSourceInfo", () => {
  const meta = JSON.stringify({
    appStore: { trackId: "1", storefront: "us", platform: "macos", artworkUrl: "https://is1-ssl.mzstatic.com/a/1024x1024bb.png" },
  });

  it("returns platform + iconUrl for an appstore source", () => {
    expect(appStoreSourceInfo("appstore", meta)).toEqual({
      platform: "macos",
      iconUrl: "https://is1-ssl.mzstatic.com/a/1024x1024bb.png",
    });
  });

  it("returns null for a non-appstore source", () => {
    expect(appStoreSourceInfo("feed", meta)).toBeNull();
  });

  it("defaults to ios + null icon when metadata is missing/empty", () => {
    expect(appStoreSourceInfo("appstore", null)).toEqual({ platform: "ios", iconUrl: null });
    expect(appStoreSourceInfo("appstore", "{}")).toEqual({ platform: "ios", iconUrl: null });
  });

  it("tolerates malformed JSON (ios + null icon)", () => {
    expect(appStoreSourceInfo("appstore", "{not json")).toEqual({ platform: "ios", iconUrl: null });
  });

  it("ignores a non-string artworkUrl", () => {
    const bad = JSON.stringify({ appStore: { platform: "ios", artworkUrl: 42 } });
    expect(appStoreSourceInfo("appstore", bad)).toEqual({ platform: "ios", iconUrl: null });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test packages/adapters/src/appstore.test.ts`
Expected: FAIL with "appStoreSourceInfo is not a function" / import error.

- [ ] **Step 3: Implement the helper**

In `packages/adapters/src/appstore.ts`, append:

```ts
/**
 * Parse the read-surface app info ({@link AppStoreSourceInfoSchema} shape) from
 * a source row's `type` + raw `metadata` JSON. Returns null for non-appstore
 * sources. Defensive against null/missing/malformed metadata — an appstore
 * source with unparseable metadata still yields `{ platform: "ios", iconUrl:
 * null }` so the UI degrades to a generic app row. Mirrors the web-side
 * `getAppInfo` parse (web/src/lib/app-source.ts).
 */
export function appStoreSourceInfo(
  type: string,
  metadataJson: string | null,
): { platform: "ios" | "macos"; iconUrl: string | null } | null {
  if (type !== "appstore") return null;
  let appStore: Record<string, unknown> | undefined;
  try {
    const block = (JSON.parse(metadataJson ?? "{}") as { appStore?: unknown } | null)?.appStore;
    if (block && typeof block === "object") appStore = block as Record<string, unknown>;
  } catch {
    appStore = undefined;
  }
  const platform = appStore?.platform === "macos" ? "macos" : "ios";
  const iconUrl = typeof appStore?.artworkUrl === "string" ? appStore.artworkUrl : null;
  return { platform, iconUrl };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test packages/adapters/src/appstore.test.ts`
Expected: PASS (all 5 cases).

- [ ] **Step 5: Commit**

```bash
git add packages/adapters/src/appstore.ts packages/adapters/src/appstore.test.ts
git commit -m "feat(adapters): appStoreSourceInfo pure helper (type + metadata -> {platform,iconUrl})"
```

---

## Task 3: Org feed — select `source_metadata` + attach `appStore`

**Files:**
- Modify: `workers/api/src/queries/orgs.ts:468-489` (row type) and `:570-575` (SELECT)
- Modify: `workers/api/src/routes/orgs.ts:1837-1858` (feed item map)
- Test: `workers/api/test/org-feed-appstore-metadata.test.ts`

- [ ] **Step 1: Write the failing test**

Create `workers/api/test/org-feed-appstore-metadata.test.ts`:

```ts
import { describe, it, expect, beforeEach } from "bun:test";
import { Database } from "bun:sqlite";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { applyMigrations, makeD1Shim } from "../../../tests/db-helper";
import { organizations, sources, releases } from "@buildinternet/releases-core/schema";
import { getOrgReleasesFeed } from "../src/queries/orgs.js";

const noCursor = { cursorWhere: "", cursorBindings: [] };

describe("getOrgReleasesFeed appstore metadata", () => {
  let sqlite: Database;
  let db: ReturnType<typeof drizzle>;
  let d1: D1Database;

  beforeEach(async () => {
    sqlite = new Database(":memory:");
    db = drizzle(sqlite);
    applyMigrations(sqlite);
    d1 = makeD1Shim(sqlite);

    await db.insert(organizations).values({ id: "org_a", slug: "notion", name: "Notion", category: "cloud" });
    await db.insert(sources).values({
      id: "src_app",
      slug: "notion-ios",
      name: "Notion",
      type: "appstore",
      url: "https://apps.apple.com/us/app/id1232780281",
      orgId: "org_a",
      metadata: JSON.stringify({
        appStore: { trackId: "1232780281", storefront: "us", platform: "ios", artworkUrl: "https://is1-ssl.mzstatic.com/a/1024x1024bb.png" },
      }),
    });
    await db.insert(releases).values({
      id: "rel_app",
      sourceId: "src_app",
      title: "Notion 3.12.0",
      version: "3.12.0",
      content: "Bug fixes.",
      url: "https://apps.apple.com/us/app/id1232780281?v=3.12.0",
      publishedAt: "2026-05-27T00:00:00Z",
    });
  });

  it("returns source_metadata so the route can derive appStore", async () => {
    const rows = await getOrgReleasesFeed(d1, "org_a", noCursor, 50);
    expect(rows).toHaveLength(1);
    expect(rows[0].source_metadata).toContain('"platform":"ios"');
    expect(rows[0].source_metadata).toContain("1024x1024bb.png");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test workers/api/test/org-feed-appstore-metadata.test.ts`
Expected: FAIL — `rows[0].source_metadata` is `undefined` (column not selected), and/or a TS error that `source_metadata` is not on `OrgReleaseRow`.

- [ ] **Step 3: Add `source_metadata` to the row type**

In `workers/api/src/queries/orgs.ts`, in the `OrgReleaseRow` type (lines 468-489), add after `source_type: string;`:

```ts
  source_type: string;
  source_metadata: string | null;
```

- [ ] **Step 4: Add `s.metadata` to the SELECT**

In the same file, in the `getOrgReleasesFeed` SQL (line 574), change:

```sql
           s.slug AS source_slug, s.name AS source_name, s.type AS source_type,
           s.metadata AS source_metadata,
           ${COVERAGE_COUNT_EXPR} AS coverage_count
```

- [ ] **Step 5: Run the query test to verify it passes**

Run: `bun test workers/api/test/org-feed-appstore-metadata.test.ts`
Expected: PASS.

- [ ] **Step 6: Attach `appStore` in the route map**

In `workers/api/src/routes/orgs.ts`, add the import near the other `@releases/adapters/*` imports:

```ts
import { appStoreSourceInfo } from "@releases/adapters/appstore";
```

Then in the feed item map (lines 1837-1858), change the `source` object:

```ts
      source: {
        slug: r.source_slug,
        name: r.source_name,
        type: r.source_type,
        ...(appStoreSourceInfo(r.source_type, r.source_metadata)
          ? { appStore: appStoreSourceInfo(r.source_type, r.source_metadata)! }
          : {}),
      },
```

(The double call is fine — it's a cheap pure parse; or hoist to `const appStore = appStoreSourceInfo(r.source_type, r.source_metadata);` above the returned object and spread `...(appStore ? { appStore } : {})`. Prefer the hoisted form.)

Hoisted form (preferred) — inside the `.map((r) => { ... })`:

```ts
    const releasesFormatted = pageRows.map((r) => {
      const appStore = appStoreSourceInfo(r.source_type, r.source_metadata);
      return {
        id: r.id,
        version: r.version,
        type: r.type,
        title: r.title,
        summary: r.summary ?? (r.content.length > 150 ? r.content.slice(0, 150) + "..." : r.content),
        titleGenerated: r.title_generated,
        titleShort: r.title_short,
        content: hydrateMediaUrls(r.content, mediaOrigin),
        publishedAt: r.published_at,
        url: r.url,
        media: parseReleaseMedia(r.media, mediaOrigin),
        prerelease: r.prerelease === 1,
        source: {
          slug: r.source_slug,
          name: r.source_name,
          type: r.source_type,
          ...(appStore ? { appStore } : {}),
        },
        coverageCount: r.coverage_count,
        contentChars: r.content_chars,
        contentTokens: r.content_tokens,
      };
    });
```

- [ ] **Step 7: Type-check the worker**

Run: `cd workers/api && npx tsc --noEmit && cd -`
Expected: no errors.

- [ ] **Step 8: Commit**

```bash
git add workers/api/src/queries/orgs.ts workers/api/src/routes/orgs.ts workers/api/test/org-feed-appstore-metadata.test.ts
git commit -m "feat(api): attach source.appStore on the org releases feed"
```

---

## Task 4: Web helper `appStoreIconUrl` (mzstatic resizer)

**Files:**
- Modify: `web/src/lib/app-source.ts`
- Test: `web/src/lib/app-source.test.ts`

- [ ] **Step 1: Write the failing test**

Append to `web/src/lib/app-source.test.ts`:

```ts
import { appStoreIconUrl } from "./app-source";

describe("appStoreIconUrl", () => {
  it("rewrites the mzstatic dimension suffix to the requested size", () => {
    expect(appStoreIconUrl("https://is1-ssl.mzstatic.com/a/1024x1024bb.png", 96)).toBe(
      "https://is1-ssl.mzstatic.com/a/96x96bb.png",
    );
  });

  it("preserves the file extension (jpg)", () => {
    expect(appStoreIconUrl("https://is1-ssl.mzstatic.com/a/512x512bb.jpg", 72)).toBe(
      "https://is1-ssl.mzstatic.com/a/72x72bb.jpg",
    );
  });

  it("returns the url unchanged when it does not match the mzstatic pattern", () => {
    expect(appStoreIconUrl("https://example.com/icon.png", 96)).toBe("https://example.com/icon.png");
  });
});
```

(Ensure the file's existing top-level imports include `import { describe, it, expect } from "bun:test";` — it already does for the `getAppInfo` suite. Add `appStoreIconUrl` to the existing `./app-source` import if one is present, rather than a second import line.)

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test web/src/lib/app-source.test.ts`
Expected: FAIL with "appStoreIconUrl is not a function".

- [ ] **Step 3: Implement the helper**

Append to `web/src/lib/app-source.ts`:

```ts
/**
 * Resize an App Store (mzstatic) artwork URL by rewriting its
 * `/{w}x{h}bb.{ext}` dimension suffix to a square `px`. The stored icon is a
 * 1024px PNG; feed/detail render it small, so we request a smaller asset
 * instead of shipping 1024px into a 36px box. Returns the input unchanged when
 * it doesn't match the known pattern. Mirrors `upscaleArtwork` in
 * packages/adapters/src/appstore.ts.
 */
export function appStoreIconUrl(url: string, px: number): string {
  return url.replace(/\/\d+x\d+bb\.(jpg|png|webp)$/i, `/${px}x${px}bb.$1`);
}
```

- [ ] **Step 4: Add the shared `AppRowInfo` type**

Still in `web/src/lib/app-source.ts`, add (after the `AppInfo` interface):

```ts
/**
 * Display payload for the compact App Store feed row. `appName` is the source
 * name; `label` is the human platform; `iconUrl` is the (un-resized) mzstatic
 * artwork URL or null. Consumed by `ReleaseListItem`'s appstore branch.
 */
export interface AppRowInfo {
  label: "iOS" | "macOS";
  iconUrl: string | null;
  appName: string;
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `bun test web/src/lib/app-source.test.ts`
Expected: PASS (existing `getAppInfo` cases + 3 new).

- [ ] **Step 6: Commit**

```bash
git add web/src/lib/app-source.ts web/src/lib/app-source.test.ts
git commit -m "feat(web): appStoreIconUrl mzstatic resizer + AppRowInfo type"
```

---

## Task 5: `ReleaseListItem` compact App Store branch

**Files:**
- Modify: `web/src/components/release-item.tsx`

No unit harness for `.tsx`; verified by `tsc` (Step 4) and manual check (Task 9).

- [ ] **Step 1: Add imports + the `appStore` prop**

In `web/src/components/release-item.tsx`, add to the `@/lib/app-source` import (create the import if absent):

```ts
import { appStoreIconUrl, type AppRowInfo } from "@/lib/app-source";
```

Change the `ReleaseListItem` signature (lines 141-149) to add the optional prop:

```tsx
export function ReleaseListItem({
  release,
  hideDate,
  sourceByline,
  appStore,
}: {
  release: ReleaseItem;
  hideDate?: boolean;
  sourceByline?: { name: string; slug: string; orgSlug?: string; type?: string };
  appStore?: AppRowInfo | null;
}) {
```

- [ ] **Step 2: Branch the content block**

In the content container `<div className="flex-1 min-w-0 border-b border-stone-200 dark:border-stone-800 last:border-b-0 py-4 pl-5">` (line 236), wrap the **existing** children (from the heading row `<div className="flex items-baseline gap-1.5 mb-1">` at line 237 through the end of the collapsible `<div>` that closes at line 363) in `{!appStore && (<> ... </>)}`, and insert the App Store block immediately **before** it:

```tsx
      <div className="flex-1 min-w-0 border-b border-stone-200 dark:border-stone-800 last:border-b-0 py-4 pl-5">
        {appStore && (
          <div
            className="group relative cursor-pointer"
            role="button"
            tabIndex={0}
            aria-expanded={expanded}
            aria-label={expanded ? "Collapse release notes" : "Expand release notes"}
            onClick={() => setExpanded(!expanded)}
            onKeyDown={(e) => {
              if (e.key === "Enter" || e.key === " ") {
                e.preventDefault();
                setExpanded(!expanded);
              }
            }}
          >
            <div className="flex items-center gap-3">
              {appStore.iconUrl ? (
                <FallbackImage
                  src={appStoreIconUrl(appStore.iconUrl, 96)}
                  alt=""
                  width={36}
                  height={36}
                  className="rounded-[9px] border border-stone-200 dark:border-stone-800 shrink-0"
                />
              ) : (
                <div className="w-9 h-9 rounded-[9px] bg-stone-200 dark:bg-stone-700 flex items-center justify-center text-stone-500 dark:text-stone-300 font-semibold shrink-0">
                  {appStore.appName.charAt(0)}
                </div>
              )}
              <div className="min-w-0 flex-1">
                <div className="flex items-baseline gap-1.5">
                  <h2 id={titleId} className={headingClasses}>
                    {release.id ? (
                      <Link href={`/release/${release.id}`} className="hover:underline underline-offset-2">
                        {appStore.appName}
                        {release.version && (
                          <span className="ml-1.5 font-normal text-stone-500 dark:text-stone-400">
                            v{release.version}
                          </span>
                        )}
                      </Link>
                    ) : (
                      <>
                        {appStore.appName}
                        {release.version && (
                          <span className="ml-1.5 font-normal text-stone-500 dark:text-stone-400">
                            v{release.version}
                          </span>
                        )}
                      </>
                    )}
                  </h2>
                  {release.url && (
                    <a
                      href={release.url}
                      target="_blank"
                      rel={EXTERNAL_UGC_REL}
                      aria-label="Open original source"
                      onClick={(e) => e.stopPropagation()}
                      className="text-stone-400 dark:text-stone-500 hover:text-stone-700 dark:hover:text-stone-300 text-xs"
                    >
                      ↗
                    </a>
                  )}
                </div>
                <div className="text-[13px] text-stone-500 dark:text-stone-400">
                  Available for {appStore.label}
                </div>
              </div>
              <svg
                className={`ml-auto shrink-0 h-4 w-4 text-stone-400 dark:text-stone-500 transition-transform ${expanded ? "rotate-180" : ""}`}
                viewBox="0 0 20 20"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.5"
                aria-hidden="true"
              >
                <path d="M6 8l4 4 4-4" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
            </div>
            {expanded && (
              <div className="mt-2 pl-12">
                {markdownContent.trim() ? (
                  <div className={markdownClasses}>
                    <ReactMarkdown
                      remarkPlugins={remarkPlugins}
                      rehypePlugins={[rehypeShikiPlugin]}
                      components={markdownComponents}
                    >
                      {markdownContent}
                    </ReactMarkdown>
                  </div>
                ) : (
                  <p className="text-[13px] italic text-stone-400 dark:text-stone-500 m-0">
                    No release notes provided.
                  </p>
                )}
                {release.url && (
                  <a
                    href={release.url}
                    target="_blank"
                    rel={EXTERNAL_UGC_REL}
                    onClick={(e) => e.stopPropagation()}
                    className="inline-block mt-2 text-[12px] text-stone-500 dark:text-stone-400 hover:text-stone-700 dark:hover:text-stone-300"
                  >
                    View on the App Store ↗
                  </a>
                )}
              </div>
            )}
          </div>
        )}
        {!appStore && (
          <>
            {/* ...existing heading row (line 237) through the collapsible div (line 363)... */}
          </>
        )}
      </div>
```

Notes for the implementer:
- `headingClasses`, `markdownClasses`, `markdownContent`, `expanded`/`setExpanded`, `titleId`, `remarkPlugins`, `rehypeShikiPlugin`, `markdownComponents`, `ReactMarkdown`, `Link`, `FallbackImage`, `EXTERNAL_UGC_REL` are all already defined/imported in this file — reuse them.
- The `↗` glyph matches the existing external-link affordance already used in this component (line 260); kept for visual consistency with adjacent standard rows. (Broader ↗ cleanup is out of scope.)
- Do NOT render `release.media` / `MediaGallery` in the appstore branch — screenshots are intentionally dropped.

- [ ] **Step 2b: Run the related list test (no behavior change expected)**

Run: `bun test web/src/lib/app-source.test.ts`
Expected: PASS (sanity — confirms the helper import resolves).

- [ ] **Step 3: Type-check the web app**

Run: `cd web && npx tsc --noEmit && cd -`
Expected: no errors. (`appStore` is currently never passed, so the branch is dead until Task 6 — that's fine.)

- [ ] **Step 4: Commit**

```bash
git add web/src/components/release-item.tsx
git commit -m "feat(web): compact App Store branch in ReleaseListItem"
```

---

## Task 6: Wire `OrgReleaseList` per-row appStore

**Files:**
- Modify: `web/src/components/org-release-list.tsx:252-270`

- [ ] **Step 1: Pass `appStore` derived from the row's source**

In `web/src/components/org-release-list.tsx`, change the `ReleaseListItem` invocation (lines 252-270) to add the `appStore` prop:

```tsx
          {releases.map((release, i) => (
            <ReleaseListItem
              key={release.id ?? i}
              release={release}
              hideDate={
                i > 0 &&
                release.publishedAt?.slice(0, 10) === releases[i - 1].publishedAt?.slice(0, 10)
              }
              appStore={
                release.source.appStore
                  ? {
                      label: release.source.appStore.platform === "macos" ? "macOS" : "iOS",
                      iconUrl: release.source.appStore.iconUrl,
                      appName: release.source.name,
                    }
                  : null
              }
              sourceByline={
                multipleSourcesExist
                  ? {
                      name: release.source.name,
                      slug: release.source.slug,
                      orgSlug,
                      type: release.source.type,
                    }
                  : undefined
              }
            />
          ))}
```

(`release.source.appStore` is now typed via the api-types change in Task 1, since `OrgReleaseItem` is re-exported from `@buildinternet/releases-api-types`.)

- [ ] **Step 2: Type-check the web app**

Run: `cd web && npx tsc --noEmit && cd -`
Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add web/src/components/org-release-list.tsx
git commit -m "feat(web): render appstore rows in the org releases feed"
```

---

## Task 7: Wire `SourceReleaseList` + source page

**Files:**
- Modify: `web/src/components/source-release-list.tsx`
- Modify: `web/src/app/sources/[id]/page.tsx`

- [ ] **Step 1: Add an `appStore` prop to `SourceReleaseList`**

In `web/src/components/source-release-list.tsx`, add the import and prop:

```ts
import type { AppRowInfo } from "@/lib/app-source";
```

Extend `SourceReleaseListProps` (lines 10-15):

```ts
interface SourceReleaseListProps {
  orgSlug: string;
  sourceSlug: string;
  initialReleases: ReleaseItem[];
  initialCursor: string | null;
  appStore?: AppRowInfo | null;
}
```

Destructure it in the component signature (lines 23-28), then pass it to each row (the `ReleaseListItem` at lines 164-172):

```tsx
export function SourceReleaseList({
  orgSlug,
  sourceSlug,
  initialReleases,
  initialCursor,
  appStore,
}: SourceReleaseListProps) {
```

```tsx
          {releases.map((release, i) => (
            <ReleaseListItem
              key={release.id ?? i}
              release={release}
              appStore={appStore ?? null}
              hideDate={
                i > 0 &&
                release.publishedAt?.slice(0, 10) === releases[i - 1].publishedAt?.slice(0, 10)
              }
            />
          ))}
```

- [ ] **Step 2: Derive `appStore` on the source page and pass it down**

In `web/src/app/sources/[id]/page.tsx`, add the import:

```ts
import { getAppInfo } from "@/lib/app-source";
```

Before the `return` / the `<SourceReleaseList ... />` render (around line 166-174), compute:

```tsx
  const appInfo = getAppInfo(source);
  const appStore = appInfo
    ? { label: appInfo.label, iconUrl: appInfo.iconUrl, appName: source.name }
    : null;
```

Then pass it:

```tsx
      <SourceReleaseList
        orgSlug={orgSlug}
        sourceSlug={source.slug}
        initialReleases={source.releases}
        initialCursor={initialCursor}
        appStore={appStore}
      />
```

Verification note: `getAppInfo(source)` needs `source.type` + `source.metadata`. Confirm the `source` object fetched by this page includes `metadata` (the sibling `sources/[id]/layout.tsx:125` already calls `getAppInfo(source)`, so the fetched shape carries it). If `tsc` reports `metadata` missing on `source`, add it to the fetch/type used by `page.tsx` to match `layout.tsx`.

- [ ] **Step 3: Type-check the web app**

Run: `cd web && npx tsc --noEmit && cd -`
Expected: no errors.

- [ ] **Step 4: Commit**

```bash
git add web/src/components/source-release-list.tsx web/src/app/sources/[id]/page.tsx
git commit -m "feat(web): render appstore rows on the standalone source page"
```

---

## Task 8: Release detail page — thread appStore, suppress screenshots, platform byline

**Files:**
- Modify: `workers/api/src/routes/sources.ts` (`GET /v1/releases/:id`, ~lines 2795-2862)
- Modify: `web/src/app/release/[id]/page.tsx`
- Test: `workers/api/test/release-detail-appstore.test.ts`

- [ ] **Step 1: Write the failing handler test**

Create `workers/api/test/release-detail-appstore.test.ts`:

```ts
import { describe, it, expect } from "bun:test";
import { organizations, sources, releases } from "@buildinternet/releases-core/schema";
import { sourceRoutes } from "../src/routes/sources.js";
import { createTestDb, createTestApp } from "./setup";

describe("GET /v1/releases/:id appstore", () => {
  it("surfaces appStore {platform,iconUrl} for an appstore release", async () => {
    const db = createTestDb();
    await db.insert(organizations).values({ id: "org_a", slug: "notion", name: "Notion", category: "cloud" });
    await db.insert(sources).values({
      id: "src_app",
      slug: "notion-ios",
      name: "Notion",
      type: "appstore",
      url: "https://apps.apple.com/us/app/id1",
      orgId: "org_a",
      metadata: JSON.stringify({
        appStore: { trackId: "1", storefront: "us", platform: "ios", artworkUrl: "https://is1-ssl.mzstatic.com/a/1024x1024bb.png" },
      }),
    });
    await db.insert(releases).values({
      id: "rel_app",
      sourceId: "src_app",
      title: "Notion 3.12.0",
      version: "3.12.0",
      content: "Bug fixes.",
      url: "https://apps.apple.com/us/app/id1?v=3.12.0",
      publishedAt: "2026-05-27T00:00:00Z",
    });

    const app = createTestApp(db, sourceRoutes);
    const res = await app(new Request("http://x/v1/releases/rel_app"));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { appStore?: unknown };
    expect(body.appStore).toEqual({ platform: "ios", iconUrl: "https://is1-ssl.mzstatic.com/a/1024x1024bb.png" });
  });

  it("omits appStore (null) for a non-appstore release", async () => {
    const db = createTestDb();
    await db.insert(organizations).values({ id: "org_b", slug: "acme", name: "Acme", category: "cloud" });
    await db.insert(sources).values({
      id: "src_feed",
      slug: "acme-feed",
      name: "Acme",
      type: "feed",
      url: "https://acme.test/feed",
      orgId: "org_b",
    });
    await db.insert(releases).values({
      id: "rel_feed",
      sourceId: "src_feed",
      title: "Acme 1.0",
      content: "Notes",
      url: "https://acme.test/1",
      publishedAt: "2026-05-27T00:00:00Z",
    });

    const app = createTestApp(db, sourceRoutes);
    const res = await app(new Request("http://x/v1/releases/rel_feed"));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { appStore?: unknown };
    expect(body.appStore ?? null).toBeNull();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test workers/api/test/release-detail-appstore.test.ts`
Expected: FAIL — `body.appStore` is `undefined` in the first case.

- [ ] **Step 3: Thread appStore in the detail handler**

In `workers/api/src/routes/sources.ts`, add the import near the other `@releases/adapters/*` imports:

```ts
import { appStoreSourceInfo } from "@releases/adapters/appstore";
```

In the `GET /releases/:id` handler, add `sourceMetadata` to the select:

```ts
      .select({
        release: releases,
        sourceName: sourcesActive.name,
        sourceSlug: sourcesActive.slug,
        sourceType: sourcesActive.type,
        sourceMetadata: sourcesActive.metadata,
        orgSlug: organizationsActive.slug,
        orgName: organizationsActive.name,
      })
```

Update the destructure and result:

```ts
    const { release, sourceName, sourceSlug, sourceType, sourceMetadata, orgSlug, orgName } = rows[0];
```

```ts
    const appStore = appStoreSourceInfo(sourceType ?? "", (sourceMetadata as string | null) ?? null);
    // ... existing `const { metadata: _metadata, ...releaseRest } = release;` etc ...
    const result = {
      ...releaseRest,
      content: hydratedContent,
      media,
      sourceName,
      sourceSlug,
      sourceType,
      org,
      composition,
      appStore,
    };
```

- [ ] **Step 4: Run handler test to verify it passes**

Run: `bun test workers/api/test/release-detail-appstore.test.ts`
Expected: PASS (both cases).

- [ ] **Step 5: Suppress screenshots + add platform byline on the detail page**

In `web/src/app/release/[id]/page.tsx`, add imports (skip any already present):

```ts
import { FallbackImage } from "@/components/fallback-image";
import { appStoreIconUrl } from "@/lib/app-source";
```

Replace the `const media = release.media ?? [];` line (line 87) with:

```ts
  const appStore = release.appStore ?? null;
  const appLabel = appStore ? (appStore.platform === "macos" ? "macOS" : "iOS") : null;
  // App Store screenshots are store marketing, not release content — drop them.
  const media = appStore ? [] : (release.media ?? []);
```

In the byline row (lines 184-191), after the `sourceName` `<span>` (closing at line 191), add:

```tsx
            {appStore && (
              <span className="flex items-center gap-1.5">
                {appStore.iconUrl && (
                  <FallbackImage
                    src={appStoreIconUrl(appStore.iconUrl, 64)}
                    alt=""
                    width={16}
                    height={16}
                    className="rounded-[4px]"
                  />
                )}
                Available for {appLabel}
              </span>
            )}
```

(The `<ReleaseContent ... media={media} />` call at line 240 needs no change — `media` is now `[]` for appstore, so its `MediaGallery` renders nothing.)

- [ ] **Step 6: Type-check worker + web**

Run: `cd workers/api && npx tsc --noEmit && cd - && cd web && npx tsc --noEmit && cd -`
Expected: no errors.

- [ ] **Step 7: Commit**

```bash
git add workers/api/src/routes/sources.ts workers/api/test/release-detail-appstore.test.ts web/src/app/release/[id]/page.tsx
git commit -m "feat: appstore treatment on release detail (suppress screenshots + platform byline)"
```

---

## Task 9: Full verification + manual check

**Files:** none (verification only)

- [ ] **Step 1: Run the full test suite**

Run: `bun test packages/ && bun test tests/ web/ workers/`
Expected: PASS. (Matches the root `test` script's split — `packages/` runs in its own bun process.)

- [ ] **Step 2: Type-check everything**

Run: `npx tsc --noEmit && cd workers/api && npx tsc --noEmit && cd - && cd web && npx tsc --noEmit && cd -`
Expected: no errors in any.

- [ ] **Step 3: Lint + format**

Run: `bun run lint && bun run format:check`
Expected: clean. (If `format:check` flags the new files, run `bun run format` and amend.)

- [ ] **Step 4: Manual browser check (no component test harness)**

Start the web + api dev servers (`bun run dev:web`, `bun run dev:api`) and, for an org with an appstore source (e.g. a tracked iOS/macOS app), open the org **Releases** tab. Verify:
  - The appstore row shows the app icon + "{AppName} v{version}" + "Available for iOS" (or macOS), with no screenshot thumbnail.
  - Clicking the row expands to the release notes (or "No release notes provided.") + a "View on the App Store ↗" link, then collapses.
  - A non-appstore row in the same feed is visually unchanged.
  - The standalone source page (`/sources/<id>`) for that app renders the same compact row.
  - The release detail page (`/release/<id>`) for an appstore release shows the "Available for …" byline and no App Store screenshots.

- [ ] **Step 5: Final review against the spec**

Re-read `docs/superpowers/specs/2026-05-27-mobile-appstore-feed-row-design.md` and confirm each decision is implemented: trigger (`appstore`), Option B layout, screenshots dropped everywhere (feed + detail), expand-to-notes with the empty fallback, scope (org feed + source feed + detail; ticker/search deferred).

---

## Self-Review (completed during planning)

**Spec coverage:**
- Trigger `source.type === "appstore"` → Tasks 2/3/8 (`appStoreSourceInfo` gates on it).
- Option B layout (app name + version heading, platform byline, icon) → Task 5.
- Screenshots dropped in feed rows → Task 5 (no media render in branch). Dropped on detail → Task 8 (`media = []`).
- Expand to notes + "No release notes provided." fallback + App Store link → Task 5.
- Wire threading (org feed source.appStore; detail appStore) → Tasks 1/3/8. (Latest-feed `ReleaseLatestSource` intentionally NOT threaded — its only consumer is the out-of-scope homepage ticker.)
- Icon sizing helper + fallback placeholder + no-version fallback → Tasks 4/5.
- Scope: org feed (Task 6), source feed (Task 7), detail page (Task 8); ticker/search deferred (noted, untouched).

**Placeholder scan:** No TBD/TODO. The one referenced-but-not-pasted region (existing `ReleaseListItem` children in Task 5 Step 2) is existing code identified by line range, wrapped in place — not new code to author.

**Type consistency:** `appStoreSourceInfo` returns `{platform:"ios"|"macos"; iconUrl:string|null}` matching `AppStoreSourceInfoSchema` (Task 1) on every call site (Tasks 3, 8). `AppRowInfo` ({label, iconUrl, appName}) defined in Task 4, consumed identically in Tasks 5/6/7. `appStoreIconUrl(url, px)` signature consistent across Tasks 4/5/8.
