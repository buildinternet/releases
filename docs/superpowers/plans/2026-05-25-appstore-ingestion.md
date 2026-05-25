# App Store Ingestion Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ingest Apple App Store listings (iOS + macOS) as a new `appstore` source fetch type, minting one Release per store version, with manual add via a store URL and app icons surfaced on products.

**Architecture:** A pure, worker-safe adapter (`packages/adapters/src/appstore.ts`) calls Apple's authless iTunes Lookup API and maps the current version to a `RawRelease`. It slots into the existing `fetchOne` poll-and-diff pipeline via an `isAppStoreFetched` dispatch branch. Per-version dedup uses a version-distinct release URL (`…?v=<version>`) so the existing `(source_id, url)` uniqueness keeps each version a distinct row. A curated `materializeAppStoreSource` helper (modeled on `runLookup`) backs a `POST /v1/sources/appstore` endpoint that resolves a store URL into Org → Product → Source → first Release. A new `products.avatar_url` column (mirroring org avatars) holds the app icon.

**Tech Stack:** Bun, TypeScript (strict), Cloudflare Workers + Hono, Drizzle ORM over D1, Zod (api-types), `bun:test`.

---

## Background the implementer needs

- **`kind` vs `type`:** `kind` (`platform|sdk|mobile|desktop|…`) already exists and is unchanged. The new work is the fetch `type` value `appstore`. iOS sources get `kind:"mobile"`, macOS `kind:"desktop"`.
- **No SQL CHECK on `sources.type`:** adding `appstore` to the enum is a TypeScript-only constant + schema-hint edit. It needs **no migration**. (drizzle's `{ enum: [...] }` hint does not emit a CHECK; the `sources_active`/`sources_visible` views are `.existing()` and the hint is type-only.)
- **The one migration** is `products.avatar_url`. `products_active` is `CREATE VIEW … AS SELECT * FROM products …`; SQLite freezes `*` at create time, so the migration must `DROP VIEW`/`CREATE VIEW` to re-expand the column list.
- **Release insert** (`poll-fetch.ts`) stores `url: raw.url ?? null` verbatim and dedups on `UNIQUE(source_id, url)` via `onConflictDoNothing()`. The version-distinct URL approach therefore needs **zero** changes to the insert path.
- **Adapters are pure** (no `db`). The DB-coupled refresh + materialize logic lives in worker code (`workers/api/src/lib/appstore-materialize.ts`).
- **Test conventions:** pure-adapter tests operate on JSON/string fixtures (see `tests/unit/feed-parsers.test.ts`). Worker tests use `createTestDb()` from `workers/api/test/setup.ts` (a drizzle handle wired as `env.DB`) + `createTestApp(db, routes, { env })`. See `workers/api/test/org-scoped-routes.test.ts`.

## File structure

**Create:**

- `packages/adapters/src/appstore.ts` — pure adapter: types, identifier parsing, URL helpers, `mapListingToRawReleases`, `resolveAppStore`, `appStoreCoordFromSource`.
- `tests/unit/appstore-adapter.test.ts` — adapter unit tests (fixtures + mocked `fetch`).
- `tests/fixtures/appstore/spotify-ios.json` — iTunes Lookup fixture.
- `workers/api/src/lib/appstore-materialize.ts` — `refreshAppStoreListing`, `materializeAppStoreSource`.
- `workers/api/migrations/20260525000000_add_products_avatar_url.sql` — the column + view recreate.
- `workers/api/test/appstore-poll-fetch.test.ts` — dispatch + dedup tests.
- `workers/api/test/appstore-materialize.test.ts` — manual-add endpoint tests.

**Modify:**

- `packages/core/src/source-enums.ts` — add `appstore` to `SOURCE_TYPES`.
- `packages/core/src/schema.ts` — `appstore` in 3 type-enum hints; `avatarUrl` on `products` table + `productsActive` view.
- `packages/adapters/src/source-meta.ts` — `AppStoreMeta` on `SourceMetadata`; `isAppStoreFetched`.
- `packages/api-types/src/schemas/products.ts` — `avatarUrl` on `ProductRowSchema` + `UpdateProductBodySchema`.
- `workers/api/src/cron/poll-fetch.ts` — pollable filter, fetchable pre-filter, `pollOne` branch, `fetchOne` branch.
- `workers/api/src/routes/products.ts` — `avatarUrl` in `patchProductHandler`.
- `workers/api/src/routes/sources.ts` — `POST /v1/sources/appstore` route.
- `workers/api/src/workflows/onboard-source.ts` — `appstore` in `serverSideFetchable`.
- `web/src/lib/og.tsx` — product-avatar fallback preference.
- `web/src/app/admin/status/dashboard.tsx` — `appstore` in the source-type filter.

---

## Task 1: Add `appstore` to the source type enum

**Files:**

- Modify: `packages/core/src/source-enums.ts:10`
- Modify: `packages/core/src/schema.ts:312`, `:958`, `:1018`
- Test: `packages/api-types/test/source-type.test.ts` (create)

- [ ] **Step 1: Write the failing test**

Create `packages/api-types/test/source-type.test.ts`:

```ts
import { describe, it, expect } from "bun:test";
import { SOURCE_TYPES } from "@buildinternet/releases-core/source-enums";
import { SourceTypeSchema } from "../src/schemas/sources.js";

describe("appstore source type", () => {
  it("is a member of SOURCE_TYPES", () => {
    expect(SOURCE_TYPES).toContain("appstore");
  });

  it("is accepted by SourceTypeSchema", () => {
    expect(SourceTypeSchema.parse("appstore")).toBe("appstore");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test packages/api-types/test/source-type.test.ts`
Expected: FAIL — `expect(received).toContain("appstore")` (array lacks the value).

- [ ] **Step 3: Add the enum value**

In `packages/core/src/source-enums.ts:10`:

```ts
export const SOURCE_TYPES = ["github", "scrape", "feed", "agent", "appstore"] as const;
```

In `packages/core/src/schema.ts`, update all three inline enum hints (base table line 312, `sourcesActive` line 958, `sourcesVisible` line 1018) — each currently reads:

```ts
type: text("type", { enum: ["github", "scrape", "feed", "agent"] }).notNull(),
```

Change each to:

```ts
type: text("type", { enum: ["github", "scrape", "feed", "agent", "appstore"] }).notNull(),
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test packages/api-types/test/source-type.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 5: Type-check**

Run: `npx tsc --noEmit`
Expected: no errors. (`SourceTypeSchema`, GraphQL `SourceTypeEnum`, and the `source-types.ts` parsers all derive from `SOURCE_TYPES` automatically.)

- [ ] **Step 6: Commit**

```bash
git add packages/core/src/source-enums.ts packages/core/src/schema.ts packages/api-types/test/source-type.test.ts
git commit -m "feat(core): add appstore source type"
```

---

## Task 2: Add `appStore` metadata + `isAppStoreFetched`

**Files:**

- Modify: `packages/adapters/src/source-meta.ts` (add interface near line 11; add helper near line 204)
- Test: `tests/unit/appstore-source-meta.test.ts` (create)

- [ ] **Step 1: Write the failing test**

Create `tests/unit/appstore-source-meta.test.ts`:

```ts
import { describe, it, expect } from "bun:test";
import { isAppStoreFetched } from "@releases/adapters/source-meta";
import type { Source } from "@buildinternet/releases-core/schema";

function srcOfType(type: string): Source {
  return { type } as unknown as Source;
}

describe("isAppStoreFetched", () => {
  it("is true for type=appstore", () => {
    expect(isAppStoreFetched(srcOfType("appstore"))).toBe(true);
  });
  it("is false for other types", () => {
    expect(isAppStoreFetched(srcOfType("feed"))).toBe(false);
    expect(isAppStoreFetched(srcOfType("github"))).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/unit/appstore-source-meta.test.ts`
Expected: FAIL — `isAppStoreFetched` is not exported.

- [ ] **Step 3: Add the interface and helper**

In `packages/adapters/src/source-meta.ts`, add inside the `SourceMetadata` interface (alongside the existing `feedUrl` / `githubUrl` fields):

```ts
  /**
   * App Store listing routing + cached listing metadata (#appstore). Present
   * only on `type: "appstore"` sources. `trackId` is the iTunes lookup key;
   * `platform` selects the lookup `entity` (macos → macSoftware). `artworkUrl`
   * is the last-seen icon, used to skip no-op product-avatar refreshes.
   */
  appStore?: {
    trackId: string;
    bundleId?: string;
    storefront: string;
    platform: "ios" | "macos";
    firstPublishedAt?: string;
    minOsVersion?: string;
    artworkUrl?: string;
  };
```

Add the helper next to `isGitHubFetched` (after line 207):

```ts
/**
 * True when a source is fetched via the Apple App Store adapter. Unlike
 * `isGitHubFetched`, there's no metadata-override form — the type is the
 * only signal.
 */
export function isAppStoreFetched(source: Source): boolean {
  return source.type === "appstore";
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test tests/unit/appstore-source-meta.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add packages/adapters/src/source-meta.ts tests/unit/appstore-source-meta.test.ts
git commit -m "feat(adapters): appStore source metadata + isAppStoreFetched"
```

---

## Task 3: App Store adapter — pure helpers + mapping

**Files:**

- Create: `packages/adapters/src/appstore.ts`
- Create: `tests/fixtures/appstore/spotify-ios.json`
- Test: `tests/unit/appstore-adapter.test.ts`

- [ ] **Step 1: Create the fixture**

Create `tests/fixtures/appstore/spotify-ios.json`:

```json
{
  "resultCount": 1,
  "results": [
    {
      "trackId": 324684580,
      "bundleId": "com.spotify.client",
      "trackName": "Spotify - Music and Podcasts",
      "version": "9.0.12",
      "currentVersionReleaseDate": "2026-05-19T11:42:00Z",
      "releaseDate": "2011-07-14T01:34:08Z",
      "releaseNotes": "Bug fixes and performance improvements.",
      "trackViewUrl": "https://apps.apple.com/us/app/id324684580?uo=4",
      "artistName": "Spotify",
      "sellerName": "Spotify AB",
      "primaryGenreName": "Music",
      "artworkUrl512": "https://is1-ssl.mzstatic.com/image/thumb/PurpleX/v4/ab/cd/ef/abcdef.png/512x512bb.jpg",
      "artworkUrl100": "https://is1-ssl.mzstatic.com/image/thumb/PurpleX/v4/ab/cd/ef/abcdef.png/100x100bb.jpg",
      "screenshotUrls": [
        "https://is1-ssl.mzstatic.com/image/thumb/aaa/392x696bb.jpg",
        "https://is1-ssl.mzstatic.com/image/thumb/bbb/392x696bb.jpg"
      ],
      "ipadScreenshotUrls": ["https://is1-ssl.mzstatic.com/image/thumb/ccc/748x1024bb.jpg"],
      "minimumOsVersion": "13.0"
    }
  ]
}
```

- [ ] **Step 2: Write the failing test (pure helpers)**

Create `tests/unit/appstore-adapter.test.ts`:

```ts
import { describe, it, expect } from "bun:test";
import { readFileSync } from "fs";
import { join } from "path";
import {
  parseAppStoreIdentifier,
  stripUoParam,
  upscaleArtwork,
  versionDistinctUrl,
  mapListingToRawReleases,
  type AppStoreListing,
} from "@releases/adapters/appstore";

const listing: AppStoreListing = JSON.parse(
  readFileSync(join(import.meta.dirname, "../fixtures/appstore/spotify-ios.json"), "utf-8"),
).results[0];

describe("parseAppStoreIdentifier", () => {
  it("parses a numeric trackId", () => {
    expect(parseAppStoreIdentifier("324684580")).toEqual({
      trackId: "324684580",
      platform: "ios",
      storefront: "us",
    });
  });
  it("parses an apps.apple.com URL", () => {
    expect(parseAppStoreIdentifier("https://apps.apple.com/us/app/spotify/id324684580")).toEqual({
      trackId: "324684580",
      platform: "ios",
      storefront: "us",
    });
  });
  it("honors platform + storefront overrides", () => {
    expect(parseAppStoreIdentifier("324684580", { platform: "macos", storefront: "gb" })).toEqual({
      trackId: "324684580",
      platform: "macos",
      storefront: "gb",
    });
  });
  it("returns null for non-app-store input", () => {
    expect(parseAppStoreIdentifier("github:foo/bar")).toBeNull();
    expect(parseAppStoreIdentifier("")).toBeNull();
  });
});

describe("URL helpers", () => {
  it("strips ?uo= tracking param", () => {
    expect(stripUoParam("https://apps.apple.com/us/app/id324684580?uo=4")).toBe(
      "https://apps.apple.com/us/app/id324684580",
    );
  });
  it("upscales the mzstatic artwork dimension suffix to 1024 png", () => {
    expect(upscaleArtwork(listing.artworkUrl512!)).toBe(
      "https://is1-ssl.mzstatic.com/image/thumb/PurpleX/v4/ab/cd/ef/abcdef.png/1024x1024bb.png",
    );
  });
  it("builds a version-distinct URL", () => {
    expect(versionDistinctUrl("https://apps.apple.com/us/app/id324684580", "9.0.12")).toBe(
      "https://apps.apple.com/us/app/id324684580?v=9.0.12",
    );
  });
});

describe("mapListingToRawReleases", () => {
  const [release] = mapListingToRawReleases(listing, {
    trackId: "324684580",
    platform: "ios",
    storefront: "us",
  });

  it("mints exactly one release for the current version", () => {
    expect(
      mapListingToRawReleases(listing, { trackId: "324684580", platform: "ios", storefront: "us" }),
    ).toHaveLength(1);
  });
  it("maps version, title, content, publishedAt", () => {
    expect(release.version).toBe("9.0.12");
    expect(release.title).toBe("Spotify - Music and Podcasts 9.0.12");
    expect(release.content).toBe("Bug fixes and performance improvements.");
    expect(release.publishedAt).toEqual(new Date("2026-05-19T11:42:00Z"));
  });
  it("uses a version-distinct dedup URL", () => {
    expect(release.url).toBe("https://apps.apple.com/us/app/id324684580?v=9.0.12");
  });
  it("includes screenshots (iphone + ipad) as image media", () => {
    expect(release.media).toEqual([
      { type: "image", url: "https://is1-ssl.mzstatic.com/image/thumb/aaa/392x696bb.jpg" },
      { type: "image", url: "https://is1-ssl.mzstatic.com/image/thumb/bbb/392x696bb.jpg" },
      { type: "image", url: "https://is1-ssl.mzstatic.com/image/thumb/ccc/748x1024bb.jpg" },
    ]);
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `bun test tests/unit/appstore-adapter.test.ts`
Expected: FAIL — module `@releases/adapters/appstore` not found.

- [ ] **Step 4: Implement the pure helpers**

Create `packages/adapters/src/appstore.ts`:

```ts
import type { Source } from "@buildinternet/releases-core/schema";
import type { RawRelease } from "./types.js";
import { RELEASES_BOT_UA } from "./user-agent.js";

/** A single result from the iTunes Lookup API. Only fields we consume are typed. */
export interface AppStoreListing {
  trackId: number;
  bundleId: string;
  trackName: string;
  version: string;
  currentVersionReleaseDate?: string;
  releaseDate?: string;
  releaseNotes?: string;
  trackViewUrl: string;
  artistName?: string;
  sellerName?: string;
  primaryGenreName?: string;
  artworkUrl512?: string;
  artworkUrl100?: string;
  screenshotUrls?: string[];
  ipadScreenshotUrls?: string[];
  minimumOsVersion?: string;
}

/** Resolved fetch coordinate for one platform's listing. */
export interface AppStoreCoordinate {
  trackId: string;
  platform: "ios" | "macos";
  storefront: string;
}

const TRACK_ID_RE = /^\d+$/;
const URL_ID_RE = /\/id(\d+)/;

/**
 * Parse a store identifier — a bare numeric trackId or an
 * `apps.apple.com/.../id<trackId>` URL — into a fetch coordinate. Returns null
 * when the input is neither. `platform`/`storefront` default to ios/us and are
 * overridable via opts.
 */
export function parseAppStoreIdentifier(
  input: string,
  opts?: { platform?: "ios" | "macos"; storefront?: string },
): AppStoreCoordinate | null {
  const platform = opts?.platform ?? "ios";
  const storefront = opts?.storefront ?? "us";
  const trimmed = input.trim();
  if (!trimmed) return null;
  if (TRACK_ID_RE.test(trimmed)) return { trackId: trimmed, platform, storefront };
  const m = trimmed.match(URL_ID_RE);
  if (m && trimmed.includes("apps.apple.com")) {
    return { trackId: m[1]!, platform, storefront };
  }
  return null;
}

/** Drop the `?uo=` (and any other) query string from a trackViewUrl. */
export function stripUoParam(url: string): string {
  const i = url.indexOf("?");
  return i === -1 ? url : url.slice(0, i);
}

/**
 * Swap the mzstatic dimension suffix (`/{w}x{h}bb.{ext}`) for a 1024px PNG.
 * Returns the input unchanged if it doesn't match the known pattern.
 */
export function upscaleArtwork(url: string): string {
  return url.replace(/\/\d+x\d+bb\.(?:jpg|png|webp)$/i, "/1024x1024bb.png");
}

/** Append the version as a `?v=` param so each version is a distinct release URL. */
export function versionDistinctUrl(cleanUrl: string, version: string): string {
  return `${cleanUrl}?v=${encodeURIComponent(version)}`;
}

/** Map a listing into the single RawRelease for its current version. */
export function mapListingToRawReleases(
  listing: AppStoreListing,
  _coord: AppStoreCoordinate,
): RawRelease[] {
  const cleanUrl = stripUoParam(listing.trackViewUrl);
  const screenshots = [...(listing.screenshotUrls ?? []), ...(listing.ipadScreenshotUrls ?? [])];
  const media = screenshots.map((url) => ({ type: "image" as const, url }));
  return [
    {
      version: listing.version,
      title: `${listing.trackName} ${listing.version}`,
      content: listing.releaseNotes ?? "",
      url: versionDistinctUrl(cleanUrl, listing.version),
      publishedAt: listing.currentVersionReleaseDate
        ? new Date(listing.currentVersionReleaseDate)
        : undefined,
      media,
    },
  ];
}

/** Read the appStore coordinate out of a source's metadata. Null if absent. */
export function appStoreCoordFromSource(source: Source): AppStoreCoordinate | null {
  let meta: { appStore?: Partial<AppStoreCoordinate> };
  try {
    meta = JSON.parse(source.metadata ?? "{}");
  } catch {
    return null;
  }
  const a = meta.appStore;
  if (!a?.trackId) return null;
  return {
    trackId: a.trackId,
    platform: a.platform === "macos" ? "macos" : "ios",
    storefront: a.storefront ?? "us",
  };
}

/**
 * Call the iTunes Lookup API for one coordinate. Returns the single listing or
 * null (not-found / empty / non-2xx). Never throws on a bad response — the
 * caller treats null as a no-op poll.
 */
export async function resolveAppStore(coord: AppStoreCoordinate): Promise<AppStoreListing | null> {
  const entity = coord.platform === "macos" ? "&entity=macSoftware" : "";
  const url = `https://itunes.apple.com/lookup?id=${encodeURIComponent(coord.trackId)}&country=${encodeURIComponent(coord.storefront)}${entity}`;
  const res = await fetch(url, { headers: { "User-Agent": RELEASES_BOT_UA } });
  if (!res.ok) return null;
  const data = (await res.json()) as { resultCount?: number; results?: AppStoreListing[] };
  if (!data.resultCount || !data.results?.length) return null;
  return data.results[0]!;
}

/** Convenience: resolve straight from a source row. */
export async function fetchAppStore(source: Source): Promise<RawRelease[]> {
  const coord = appStoreCoordFromSource(source);
  if (!coord) return [];
  const listing = await resolveAppStore(coord);
  if (!listing) return [];
  return mapListingToRawReleases(listing, coord);
}
```

- [ ] **Step 5: Add the package export**

The adapters package exposes submodules via the `@releases/adapters/*` mapping. Confirm `packages/adapters/package.json` `exports` uses a wildcard (`"./*": "./src/*.ts"` or similar). If it lists modules explicitly, add an `"./appstore"` entry mirroring `"./feed"`.

Run: `grep -n "exports" -A20 packages/adapters/package.json`
If a wildcard `"./*"` is present, no edit needed. Otherwise add the `appstore` entry.

- [ ] **Step 6: Run test to verify it passes**

Run: `bun test tests/unit/appstore-adapter.test.ts`
Expected: PASS (all describe blocks).

- [ ] **Step 7: Commit**

```bash
git add packages/adapters/src/appstore.ts tests/unit/appstore-adapter.test.ts tests/fixtures/appstore/spotify-ios.json packages/adapters/package.json
git commit -m "feat(adapters): App Store adapter pure helpers + mapping"
```

---

## Task 4: App Store adapter — `resolveAppStore` over mocked fetch

**Files:**

- Test: `tests/unit/appstore-adapter.test.ts` (extend)

- [ ] **Step 1: Add the failing test**

Append to `tests/unit/appstore-adapter.test.ts`:

```ts
import { resolveAppStore, fetchAppStore } from "@releases/adapters/appstore";

describe("resolveAppStore (network)", () => {
  const realFetch = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  it("requests the macSoftware entity for macos and returns the listing", async () => {
    let requested = "";
    globalThis.fetch = (async (input: string) => {
      requested = String(input);
      return new Response(
        JSON.stringify({ resultCount: 1, results: [{ ...listing, version: "1.2.3" }] }),
        { status: 200 },
      );
    }) as typeof fetch;

    const out = await resolveAppStore({ trackId: "999", platform: "macos", storefront: "gb" });
    expect(requested).toContain("id=999");
    expect(requested).toContain("country=gb");
    expect(requested).toContain("entity=macSoftware");
    expect(out?.version).toBe("1.2.3");
  });

  it("returns null on resultCount=0", async () => {
    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ resultCount: 0, results: [] }), {
        status: 200,
      })) as typeof fetch;
    expect(await resolveAppStore({ trackId: "1", platform: "ios", storefront: "us" })).toBeNull();
  });

  it("returns null on non-2xx", async () => {
    globalThis.fetch = (async () => new Response("nope", { status: 403 })) as typeof fetch;
    expect(await resolveAppStore({ trackId: "1", platform: "ios", storefront: "us" })).toBeNull();
  });

  it("fetchAppStore returns [] when the source has no appStore meta", async () => {
    const src = { type: "appstore", metadata: "{}" } as never;
    expect(await fetchAppStore(src)).toEqual([]);
  });
});
```

Add `afterEach` to the top-level import: `import { describe, it, expect, afterEach } from "bun:test";`

- [ ] **Step 2: Run test to verify it fails (then passes)**

Run: `bun test tests/unit/appstore-adapter.test.ts`
Expected: PASS — the implementation from Task 3 already satisfies these. (If `afterEach` import is missing, the run errors; add it.)

- [ ] **Step 3: Commit**

```bash
git add tests/unit/appstore-adapter.test.ts
git commit -m "test(adapters): resolveAppStore network behavior"
```

---

## Task 5: `products.avatar_url` — migration, schema, view, api-types

**Files:**

- Create: `workers/api/migrations/20260525000000_add_products_avatar_url.sql`
- Modify: `packages/core/src/schema.ts` (products table ~line 126; `productsActive` view ~line 951)
- Modify: `packages/api-types/src/schemas/products.ts` (`ProductRowSchema`, `UpdateProductBodySchema`)
- Test: `workers/api/test/products-avatar.test.ts` (create)

- [ ] **Step 1: Write the migration**

Create `workers/api/migrations/20260525000000_add_products_avatar_url.sql`:

```sql
-- Product app icon (#appstore). Mirrors organizations.avatar_url. Nullable;
-- pointer column (CDN URL or our R2 key). products_active is `SELECT *`, which
-- SQLite freezes at view-create time, so the view is recreated to re-expand
-- the column list and surface avatar_url through the active view.
ALTER TABLE products ADD COLUMN avatar_url TEXT;

DROP VIEW IF EXISTS products_active;
CREATE VIEW products_active AS
  SELECT * FROM products WHERE deleted_at IS NULL;
```

- [ ] **Step 2: Write the failing test**

Create `workers/api/test/products-avatar.test.ts`:

```ts
import { describe, it, expect } from "bun:test";
import { organizations, products, productsActive } from "@buildinternet/releases-core/schema";
import { eq } from "drizzle-orm";
import { createTestDb } from "./setup";

describe("products.avatar_url", () => {
  it("round-trips on the base table and surfaces through products_active", async () => {
    const db = createTestDb();
    await db.insert(organizations).values({ id: "org_a", name: "Acme", slug: "acme" });
    await db.insert(products).values({
      id: "prod_a",
      name: "App",
      slug: "app",
      orgId: "org_a",
      avatarUrl: "https://cdn.example/icon.png",
    });

    const [viaView] = await db
      .select({ avatarUrl: productsActive.avatarUrl })
      .from(productsActive)
      .where(eq(productsActive.id, "prod_a"));
    expect(viaView?.avatarUrl).toBe("https://cdn.example/icon.png");
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `bun test workers/api/test/products-avatar.test.ts`
Expected: FAIL — `avatarUrl` is not a property of `products`/`productsActive` (TS error) or the column is missing from the migrated snapshot.

- [ ] **Step 4: Add the schema column + view column**

In `packages/core/src/schema.ts`, add to the `products` table (after `category` / `kind`, before `createdAt` ~line 128):

```ts
    avatarUrl: text("avatar_url"),
```

And add the same line to the `productsActive` view definition (~line 951, before `createdAt`):

```ts
  avatarUrl: text("avatar_url"),
```

- [ ] **Step 5: Add to api-types**

In `packages/api-types/src/schemas/products.ts`, add to `ProductRowSchema` (after `kind`, line 23):

```ts
  avatarUrl: z.string().nullable().optional(),
```

And add to `UpdateProductBodySchema` (after `kind`, line 104):

```ts
  avatarUrl: z.string().nullable().optional(),
```

- [ ] **Step 6: Run test to verify it passes**

Run: `bun test workers/api/test/products-avatar.test.ts`
Expected: PASS.

If it still fails with a missing-column error, the test snapshot in `tests/db-helper.ts` (`getMigratedSnapshot`) needs to re-apply migrations — it reads `workers/api/migrations/` at build time, so a clean `bun test` run picks up the new file. Re-run once.

- [ ] **Step 7: Type-check**

Run: `npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 8: Commit**

```bash
git add workers/api/migrations/20260525000000_add_products_avatar_url.sql packages/core/src/schema.ts packages/api-types/src/schemas/products.ts workers/api/test/products-avatar.test.ts
git commit -m "feat(api): add products.avatar_url column + view + wire shape"
```

---

## Task 6: Accept `avatarUrl` on `PATCH /v1/products/:slug`

**Files:**

- Modify: `workers/api/src/routes/products.ts:548-576`
- Test: `workers/api/test/products-avatar.test.ts` (extend)

- [ ] **Step 1: Add the failing test**

Append to `workers/api/test/products-avatar.test.ts`:

```ts
import { productRoutes } from "../src/routes/products.js";
import { orgRoutes } from "../src/routes/orgs.js";
import { createTestApp } from "./setup";

describe("PATCH /v1/products avatarUrl", () => {
  it("sets and returns avatarUrl", async () => {
    const db = createTestDb();
    await db.insert(organizations).values({ id: "org_b", name: "Beta", slug: "beta" });
    await db.insert(products).values({ id: "prod_b", name: "B", slug: "b", orgId: "org_b" });
    const fetch = createTestApp(db, [orgRoutes, productRoutes], { env: {} });

    const res = await fetch(
      new Request("https://x.test/v1/orgs/beta/products/b", {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ avatarUrl: "https://cdn.example/b.png" }),
      }),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { avatarUrl?: string };
    expect(body.avatarUrl).toBe("https://cdn.example/b.png");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test workers/api/test/products-avatar.test.ts -t "PATCH"`
Expected: FAIL — `avatarUrl` is dropped (validator strips unknown keys; handler never sets it), so `body.avatarUrl` is `undefined`.

- [ ] **Step 3: Wire `avatarUrl` through the handler**

In `workers/api/src/routes/products.ts`, extend the `body` type in `patchProductHandler` (line 548-558) to include `avatarUrl`:

```ts
  const body: {
    name?: string;
    url?: string | null;
    description?: string | null;
    category?: string | null;
    tags?: string[];
    aliases?: string[];
    kind?: string | null;
    avatarUrl?: string | null;
  } = {
```

Add the update mapping after the `kind` line (line 576):

```ts
if (body.avatarUrl !== undefined) updates.avatarUrl = body.avatarUrl;
```

(`UpdateProductBodySchema` already gained `avatarUrl` in Task 5, so the validator no longer strips it.)

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test workers/api/test/products-avatar.test.ts`
Expected: PASS (all tests in the file).

- [ ] **Step 5: Commit**

```bash
git add workers/api/src/routes/products.ts workers/api/test/products-avatar.test.ts
git commit -m "feat(api): accept avatarUrl on PATCH /v1/products"
```

---

## Task 7: Wire `appstore` into the poll-and-fetch pipeline

**Files:**

- Modify: `workers/api/src/cron/poll-fetch.ts` (`queryDueSources` ~237-241; `pollAndFetch` fetchable filter ~143-176; `pollOne` ~314; `fetchOne` dispatch ~973)
- Modify: `workers/api/src/workflows/onboard-source.ts:121-123`
- Test: `workers/api/test/appstore-poll-fetch.test.ts` (create)

- [ ] **Step 1: Write the failing test**

Create `workers/api/test/appstore-poll-fetch.test.ts`:

```ts
import { describe, it, expect, afterEach } from "bun:test";
import { organizations, sources, releases } from "@buildinternet/releases-core/schema";
import { eq } from "drizzle-orm";
import { fetchOne, pollOne } from "../src/cron/poll-fetch.js";
import { createTestDb } from "./setup";

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

function listingJson(version: string) {
  return JSON.stringify({
    resultCount: 1,
    results: [
      {
        trackId: 324684580,
        bundleId: "com.spotify.client",
        trackName: "Spotify",
        version,
        currentVersionReleaseDate: "2026-05-19T11:42:00Z",
        releaseNotes: `Notes for ${version}`,
        trackViewUrl: "https://apps.apple.com/us/app/id324684580?uo=4",
        artworkUrl512: "https://is1-ssl.mzstatic.com/a/512x512bb.jpg",
        screenshotUrls: [],
        ipadScreenshotUrls: [],
      },
    ],
  });
}

async function seedAppStoreSource(db: ReturnType<typeof createTestDb>) {
  await db.insert(organizations).values({ id: "org_s", name: "Spotify", slug: "spotify" });
  await db.insert(sources).values({
    id: "src_s",
    name: "Spotify",
    slug: "spotify-ios",
    type: "appstore",
    url: "https://apps.apple.com/us/app/id324684580",
    orgId: "org_s",
    metadata: JSON.stringify({
      appStore: { trackId: "324684580", platform: "ios", storefront: "us" },
    }),
  });
  return (await db.select().from(sources).where(eq(sources.id, "src_s")))[0]!;
}

describe("appstore fetchOne", () => {
  it("mints a release with a version-distinct URL, and dedups on re-fetch", async () => {
    const db = createTestDb();
    const source = await seedAppStoreSource(db);
    globalThis.fetch = (async () =>
      new Response(listingJson("9.0.12"), { status: 200 })) as typeof fetch;

    const first = await fetchOne(db, source, {} as never);
    expect(first.releasesInserted).toBe(1);

    const rows = await db.select().from(releases).where(eq(releases.sourceId, "src_s"));
    expect(rows).toHaveLength(1);
    expect(rows[0]!.url).toBe("https://apps.apple.com/us/app/id324684580?v=9.0.12");
    expect(rows[0]!.version).toBe("9.0.12");

    // Re-fetch with the same version → no new release.
    const second = await fetchOne(db, source, {} as never);
    expect(second.releasesInserted).toBe(0);
    expect(await db.select().from(releases).where(eq(releases.sourceId, "src_s"))).toHaveLength(1);
  });

  it("mints a second release when the version bumps", async () => {
    const db = createTestDb();
    const source = await seedAppStoreSource(db);
    globalThis.fetch = (async () =>
      new Response(listingJson("9.0.12"), { status: 200 })) as typeof fetch;
    await fetchOne(db, source, {} as never);
    globalThis.fetch = (async () =>
      new Response(listingJson("9.1.0"), { status: 200 })) as typeof fetch;
    await fetchOne(db, source, {} as never);
    expect(await db.select().from(releases).where(eq(releases.sourceId, "src_s"))).toHaveLength(2);
  });
});

describe("appstore pollOne", () => {
  it("marks the source changed without an HTTP probe", async () => {
    const db = createTestDb();
    const source = await seedAppStoreSource(db);
    const result = await pollOne(db, source, new Date());
    expect(result.changed).toBe(true);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test workers/api/test/appstore-poll-fetch.test.ts`
Expected: FAIL — `pollOne` returns `changed:false` (appstore not handled) and `fetchOne` logs `fetch-missing-feed` → 0 inserted.

- [ ] **Step 3: Add the `pollOne` branch**

In `workers/api/src/cron/poll-fetch.ts`, add immediately after the `isGitHubFetched` block in `pollOne` (after line ~320, the `return { source, changed: true };` for GitHub). Add the import for `isAppStoreFetched` to the existing `@releases/adapters/source-meta` import:

```ts
// App Store sources have no cheap HEAD probe; the lookup is a single tiny
// JSON GET, so mark changed and let fetchOne do the one lookup + dedup
// (mirrors the GitHub branch above).
if (isAppStoreFetched(source)) {
  await db
    .update(sources)
    .set({ lastPolledAt: nowIso, changeDetectedAt: nowIso })
    .where(eq(sources.id, source.id));
  return { source, changed: true };
}
```

- [ ] **Step 4: Add the `fetchOne` dispatch branch**

In `fetchOne`, change the dispatch (line ~973) from `if (isGitHubFetched(...)) { … } else { feed … }` to insert an `else if` before the feed `else`. Add imports at the top of the file: `import { isAppStoreFetched } from "@releases/adapters/source-meta";` (extend existing import) and `import { resolveAppStore, appStoreCoordFromSource, mapListingToRawReleases } from "@releases/adapters/appstore";`.

```ts
    if (isGitHubFetched(source, meta)) {
      rawReleases = await fetchGitHub(source, env.GITHUB_TOKEN, {
        repoUrl: effectiveGitHubUrl(source, meta),
      });
    } else if (isAppStoreFetched(source)) {
      const coord = appStoreCoordFromSource(source);
      const listing = coord ? await resolveAppStore(coord) : null;
      rawReleases = listing ? mapListingToRawReleases(listing, coord!) : [];
      if (!dryRun && listing) {
        await refreshAppStoreListing(db, source, listing);
      }
    } else {
      // …existing feed path unchanged…
```

Add the import for the refresh helper (created in the next step): `import { refreshAppStoreListing } from "../lib/appstore-materialize.js";`

- [ ] **Step 4a: Create the materialize file (refresh half)**

`appstore-materialize.ts` is shared by this task (`refreshAppStoreListing`, called on poll) and Task 8 (`materializeAppStoreSource`, the manual-add path). Create it now with the refresh half; Task 8 appends the materialize function to the same file.

Create `workers/api/src/lib/appstore-materialize.ts`:

```ts
import { eq } from "drizzle-orm";
import { products, sources } from "@buildinternet/releases-core/schema";
import {
  upscaleArtwork,
  type AppStoreListing,
  type AppStoreCoordinate,
} from "@releases/adapters/appstore";
import type { Source } from "@buildinternet/releases-core/schema";
import type { createDb } from "../db.js";

type Db = ReturnType<typeof createDb>;

/** Build the source-row `metadata.appStore` block from a listing + coordinate. */
export function buildAppStoreMeta(listing: AppStoreListing, coord: AppStoreCoordinate): string {
  return JSON.stringify({
    appStore: {
      trackId: coord.trackId,
      bundleId: listing.bundleId,
      storefront: coord.storefront,
      platform: coord.platform,
      firstPublishedAt: listing.releaseDate,
      minOsVersion: listing.minimumOsVersion,
      artworkUrl: listing.artworkUrl512 ? upscaleArtwork(listing.artworkUrl512) : undefined,
    },
  });
}

/**
 * Best-effort refresh of mutable listing fields on poll: source name + the
 * appStore metadata block, and the parent product's avatar when present.
 * Never throws — a failed refresh must not fail the fetch.
 */
export async function refreshAppStoreListing(
  db: Db,
  source: Source,
  listing: AppStoreListing,
): Promise<void> {
  try {
    const parsed = JSON.parse(source.metadata ?? "{}") as {
      appStore?: { platform?: "ios" | "macos"; storefront?: string };
    };
    const coord: AppStoreCoordinate = {
      trackId: String(listing.trackId),
      platform: parsed.appStore?.platform === "macos" ? "macos" : "ios",
      storefront: parsed.appStore?.storefront ?? "us",
    };
    await db
      .update(sources)
      .set({ name: listing.trackName, metadata: buildAppStoreMeta(listing, coord) })
      .where(eq(sources.id, source.id));
    if (source.productId && listing.artworkUrl512) {
      await db
        .update(products)
        .set({ avatarUrl: upscaleArtwork(listing.artworkUrl512) })
        .where(eq(products.id, source.productId));
    }
  } catch {
    // best-effort
  }
}
```

- [ ] **Step 5: Add `appstore` to `queryDueSources` pollable filter**

In `queryDueSources` (lines 237-241), add `OR ${sourcesVisible.type} = 'appstore'` to both branches:

```ts
const pollable = opts?.changeDetectEnabled
  ? sql`(json_extract(${sourcesVisible.metadata}, '$.feedUrl') IS NOT NULL OR json_extract(${sourcesVisible.metadata}, '$.githubUrl') IS NOT NULL OR ${sourcesVisible.type} = 'github' OR ${sourcesVisible.type} = 'appstore' OR ${sourcesVisible.type} IN ('scrape','agent'))`
  : sql`(json_extract(${sourcesVisible.metadata}, '$.feedUrl') IS NOT NULL OR json_extract(${sourcesVisible.metadata}, '$.githubUrl') IS NOT NULL OR ${sourcesVisible.type} = 'github' OR ${sourcesVisible.type} = 'appstore')`;
```

- [ ] **Step 6: Admit `appstore` to the fetchable pre-filter**

In `pollAndFetch`, in the `.filter((s) => { … })` block (line ~155-175), add a branch before the final `return s.type === "github";`:

```ts
if (s.type === "appstore") return true;
return s.type === "github";
```

- [ ] **Step 7: Add `appstore` to onboard backfill eligibility**

In `workers/api/src/workflows/onboard-source.ts` (lines 121-123), extend `serverSideFetchable`:

```ts
const serverSideFetchable =
  source.type === "feed" ||
  source.type === "appstore" ||
  isGitHubFetched(source, meta) ||
  (source.type === "scrape" && meta.feedUrl != null);
```

- [ ] **Step 8: Run test to verify it passes**

Run: `bun test workers/api/test/appstore-poll-fetch.test.ts`
Expected: PASS (all 3 tests). Requires `refreshAppStoreListing` to exist (see Task 8 Step 3 note).

- [ ] **Step 9: Type-check + commit**

Run: `cd workers/api && npx tsc --noEmit && cd ../..`
Expected: no errors.

```bash
git add workers/api/src/cron/poll-fetch.ts workers/api/src/workflows/onboard-source.ts workers/api/test/appstore-poll-fetch.test.ts
git commit -m "feat(api): wire appstore into poll-and-fetch pipeline"
```

---

## Task 8: Manual add — `materializeAppStoreSource` + `POST /v1/sources/appstore`

**Files:**

- Create: `workers/api/src/lib/appstore-materialize.ts`
- Modify: `workers/api/src/routes/sources.ts` (new route; reuse `embedSourceSideEffect`)
- Test: `workers/api/test/appstore-materialize.test.ts` (create)

- [ ] **Step 1: Write the failing test**

Create `workers/api/test/appstore-materialize.test.ts`:

```ts
import { describe, it, expect, afterEach } from "bun:test";
import { organizations, products, sources, releases } from "@buildinternet/releases-core/schema";
import { eq } from "drizzle-orm";
import { sourceRoutes } from "../src/routes/sources.js";
import { createTestDb, createTestApp } from "./setup";

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

const LISTING = JSON.stringify({
  resultCount: 1,
  results: [
    {
      trackId: 324684580,
      bundleId: "com.spotify.client",
      trackName: "Spotify",
      version: "9.0.12",
      currentVersionReleaseDate: "2026-05-19T11:42:00Z",
      releaseNotes: "Bug fixes.",
      trackViewUrl: "https://apps.apple.com/us/app/id324684580?uo=4",
      sellerName: "Spotify AB",
      primaryGenreName: "Music",
      artworkUrl512: "https://is1-ssl.mzstatic.com/a/512x512bb.jpg",
      screenshotUrls: [],
      ipadScreenshotUrls: [],
      minimumOsVersion: "13.0",
    },
  ],
});

describe("POST /v1/sources/appstore", () => {
  it("materializes org + product + source + first release from a store URL", async () => {
    const db = createTestDb();
    globalThis.fetch = (async () => new Response(LISTING, { status: 200 })) as typeof fetch;
    const fetch = createTestApp(db, [sourceRoutes], { env: {} });

    const res = await fetch(
      new Request("https://x.test/v1/sources/appstore", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ url: "https://apps.apple.com/us/app/id324684580" }),
      }),
    );
    expect(res.status).toBe(201);

    const [org] = await db.select().from(organizations).where(eq(organizations.slug, "spotify-ab"));
    expect(org).toBeDefined();

    const [prod] = await db.select().from(products).where(eq(products.orgId, org!.id));
    expect(prod?.kind).toBe("mobile");
    expect(prod?.avatarUrl).toBe("https://is1-ssl.mzstatic.com/a/1024x1024bb.png");

    const [src] = await db.select().from(sources).where(eq(sources.orgId, org!.id));
    expect(src?.type).toBe("appstore");
    expect(src?.slug).toBe("spotify-ios");
    expect(src?.url).toBe("https://apps.apple.com/us/app/id324684580");

    const rel = await db.select().from(releases).where(eq(releases.sourceId, src!.id));
    expect(rel).toHaveLength(1);
    expect(rel[0]!.url).toBe("https://apps.apple.com/us/app/id324684580?v=9.0.12");
  });

  it("is idempotent — a second call returns the existing source, no duplicate", async () => {
    const db = createTestDb();
    globalThis.fetch = (async () => new Response(LISTING, { status: 200 })) as typeof fetch;
    const fetch = createTestApp(db, [sourceRoutes], { env: {} });
    const body = JSON.stringify({ url: "https://apps.apple.com/us/app/id324684580" });
    const init = { method: "POST", headers: { "content-type": "application/json" }, body };

    await fetch(new Request("https://x.test/v1/sources/appstore", init));
    await fetch(new Request("https://x.test/v1/sources/appstore", init));

    expect(await db.select().from(sources)).toHaveLength(1);
    expect(await db.select().from(organizations)).toHaveLength(1);
  });

  it("returns 404 when the lookup finds nothing", async () => {
    const db = createTestDb();
    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ resultCount: 0, results: [] }), {
        status: 200,
      })) as typeof fetch;
    const fetch = createTestApp(db, [sourceRoutes], { env: {} });
    const res = await fetch(
      new Request("https://x.test/v1/sources/appstore", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ trackId: "1" }),
      }),
    );
    expect(res.status).toBe(404);
  });

  it("returns 400 when neither url nor trackId is supplied", async () => {
    const db = createTestDb();
    const fetch = createTestApp(db, [sourceRoutes], { env: {} });
    const res = await fetch(
      new Request("https://x.test/v1/sources/appstore", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({}),
      }),
    );
    expect(res.status).toBe(400);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test workers/api/test/appstore-materialize.test.ts`
Expected: FAIL — route `/v1/sources/appstore` not found (404 for all, including the create cases).

- [ ] **Step 3: Append `materializeAppStoreSource` to `appstore-materialize.ts`**

The file already exists from Task 7 Step 4a (`buildAppStoreMeta`, `refreshAppStoreListing`, the `Db` type, and the `eq`/`products`/`sources`/`upscaleArtwork`/`Source`/`createDb` imports). **Merge** the imports below into the file's existing import block, dropping duplicates, then append the `MaterializeAppStoreParams`/`MaterializeResult` types and the `materializeAppStoreSource` function. (`buildAppStoreMeta` is already in this module, so the call inside `materializeAppStoreSource` resolves locally.)

Imports to merge in:

```ts
// extend the existing drizzle-orm import with: and, desc, sql
import { and, desc, sql } from "drizzle-orm";
// add to the existing schema import: organizations, organizationsActive, productsActive, sourcesActive, releases
import {
  organizations,
  organizationsActive,
  productsActive,
  sourcesActive,
  releases,
} from "@buildinternet/releases-core/schema";
import { newOrgId, newProductId, newSourceId, newReleaseId } from "@buildinternet/releases-core/id";
import { toSlug } from "@buildinternet/releases-core/slug";
import { computeVersionSort } from "@buildinternet/releases-core/version-sort";
import { computeContentSize } from "@buildinternet/releases-core/tokens";
import { RELEASE_URL_UPSERT } from "@releases/core-internal/release-upsert";
// add to the existing adapters/appstore import: parseAppStoreIdentifier, resolveAppStore, mapListingToRawReleases, stripUoParam
import {
  parseAppStoreIdentifier,
  resolveAppStore,
  mapListingToRawReleases,
  stripUoParam,
} from "@releases/adapters/appstore";
```

`Source`, `createDb`, the `Db` type, `buildAppStoreMeta`, and `refreshAppStoreListing` already exist in this file from Task 7. Append the types + function:

```ts
export interface MaterializeAppStoreParams {
  identifier: string;
  platform?: "ios" | "macos";
  storefront?: string;
  orgSlug?: string;
  productSlug?: string;
}

export type MaterializeResult =
  | { status: "bad_request" }
  | { status: "not_found" }
  | {
      status: "indexed" | "existing";
      source: typeof sources.$inferSelect;
      releaseCount: number;
    };

/**
 * Resolve a store identifier and materialize a curated Org → Product → Source
 * → first Release. Idempotent on the source's metadata.appStore.trackId.
 * Modeled on `runLookup` (routes/lookups.ts) but creates curated, visible rows
 * (manual add) rather than hidden on_demand rows.
 */
export async function materializeAppStoreSource(
  db: Db,
  params: MaterializeAppStoreParams,
): Promise<MaterializeResult> {
  const coord = parseAppStoreIdentifier(params.identifier, {
    platform: params.platform,
    storefront: params.storefront,
  });
  if (!coord) return { status: "bad_request" };

  const listing = await resolveAppStore(coord);
  if (!listing) return { status: "not_found" };

  const cleanUrl = stripUoParam(listing.trackViewUrl);

  // Idempotency: an existing appstore source for this trackId wins.
  const existing = await db
    .select()
    .from(sourcesActive)
    .where(
      and(
        eq(sourcesActive.type, "appstore"),
        sql`json_extract(${sourcesActive.metadata}, '$.appStore.trackId') = ${coord.trackId}`,
      ),
    )
    .limit(1);
  if (existing.length > 0) {
    const src = existing[0]! as typeof sources.$inferSelect;
    const rel = await db.select().from(releases).where(eq(releases.sourceId, src.id));
    return { status: "existing", source: src, releaseCount: rel.length };
  }

  // Org (curated). Prefer caller-supplied slug, else derive from seller name.
  const developerName = listing.sellerName ?? listing.artistName ?? listing.trackName;
  const orgSlug = (params.orgSlug ?? toSlug(developerName)).toLowerCase();
  const orgId = newOrgId();
  await db
    .insert(organizations)
    .values({ id: orgId, name: developerName, slug: orgSlug, discovery: "curated" })
    .onConflictDoNothing();
  const [org] = await db
    .select()
    .from(organizationsActive)
    .where(eq(organizationsActive.slug, orgSlug))
    .limit(1);
  const resolvedOrgId = org!.id;

  // Product (curated, always). Prefer caller-supplied slug, else app name.
  const kind = coord.platform === "macos" ? "desktop" : "mobile";
  const icon = listing.artworkUrl512 ? upscaleArtwork(listing.artworkUrl512) : null;
  const productSlug = (params.productSlug ?? toSlug(listing.trackName)).toLowerCase();
  const [existingProduct] = await db
    .select()
    .from(productsActive)
    .where(and(eq(productsActive.orgId, resolvedOrgId), eq(productsActive.slug, productSlug)))
    .limit(1);
  let productId: string;
  if (existingProduct) {
    productId = existingProduct.id;
    if (!existingProduct.avatarUrl && icon) {
      await db.update(products).set({ avatarUrl: icon }).where(eq(products.id, productId));
    }
  } else {
    productId = newProductId();
    await db.insert(products).values({
      id: productId,
      name: listing.trackName,
      slug: productSlug,
      orgId: resolvedOrgId,
      kind,
      avatarUrl: icon,
    });
  }

  // Source (curated, visible). Slug is `<product>-<platform>`.
  const sourceId = newSourceId();
  const sourceSlug = `${productSlug}-${coord.platform === "macos" ? "macos" : "ios"}`;
  const [insertedSource] = await db
    .insert(sources)
    .values({
      id: sourceId,
      name: listing.trackName,
      slug: sourceSlug,
      type: "appstore",
      url: cleanUrl,
      orgId: resolvedOrgId,
      productId,
      kind,
      discovery: "curated",
      isHidden: false,
      metadata: buildAppStoreMeta(listing, coord),
    })
    .returning();

  // First release.
  const raw = mapListingToRawReleases(listing, coord);
  const rows = raw.map((r) => {
    const size = computeContentSize(r.content);
    return {
      id: newReleaseId(),
      sourceId,
      version: r.version ?? null,
      versionSort: computeVersionSort(r.version),
      title: r.title,
      content: r.content,
      url: r.url ?? null,
      contentChars: size.contentChars,
      contentTokens: size.contentTokens,
      publishedAt: r.publishedAt ? r.publishedAt.toISOString() : null,
      media: JSON.stringify(r.media ?? []),
    };
  });
  await db.insert(releases).values(rows).onConflictDoUpdate(RELEASE_URL_UPSERT);

  return { status: "indexed", source: insertedSource!, releaseCount: rows.length };
}
```

> Verify `toSlug` is exported from `@buildinternet/releases-core/slug` (used by `POST /v1/sources`). If the export name differs, match the existing import in `workers/api/src/routes/sources.ts`.

- [ ] **Step 4: Add the route**

In `workers/api/src/routes/sources.ts`, add (near the other `sourceRoutes.post(...)` registrations; `embedSourceSideEffect` is already exported from this file). Add imports:

```ts
import { describeRoute, resolver } from "hono-openapi"; // if not already imported
import { materializeAppStoreSource } from "../lib/appstore-materialize.js";
```

Register the route:

```ts
sourceRoutes.post(
  "/sources/appstore",
  describeRoute({
    hide: hideInProduction,
    tags: ["Sources"],
    summary: "Materialize an Apple App Store source",
    description:
      "Resolves an App Store identifier (an `apps.apple.com/.../id<trackId>` URL or a bare numeric `trackId`) via the iTunes Lookup API and creates a curated Org → Product → Source, minting the current version as the first Release. Idempotent on the resolved trackId. `platform` defaults to `ios` (pass `macos` for Mac App Store apps); `storefront` defaults to `us`. Write — requires a Bearer token.",
    security: [{ bearerAuth: [] }],
    responses: {
      201: { description: "Source materialized (or returned existing)" },
      400: { description: "Missing url/trackId, or unparseable identifier" },
      404: { description: "iTunes Lookup found no matching app" },
    },
  }),
  async (c) => {
    const body = (await c.req.json().catch(() => null)) as {
      url?: string;
      trackId?: string | number;
      platform?: "ios" | "macos";
      storefront?: string;
      orgSlug?: string;
      productSlug?: string;
    } | null;

    const identifier = body?.url ?? (body?.trackId != null ? String(body.trackId) : undefined);
    if (!identifier) {
      return c.json({ error: "bad_request", message: "url or trackId is required" }, 400);
    }

    const db = createDb(c.env.DB);
    const result = await materializeAppStoreSource(db, {
      identifier,
      platform: body?.platform,
      storefront: body?.storefront,
      orgSlug: body?.orgSlug,
      productSlug: body?.productSlug,
    });

    if (result.status === "bad_request") {
      return c.json({ error: "bad_request", message: "Could not parse App Store identifier" }, 400);
    }
    if (result.status === "not_found") {
      return c.json({ error: "not_found", message: "No App Store app for that identifier" }, 404);
    }
    try {
      c.executionCtx.waitUntil(embedSourceSideEffect(c.env, db, result.source.id));
    } catch {
      // no ExecutionContext in tests — embedding is best-effort
    }
    return c.json(result, 201);
  },
);
```

> `hideInProduction` and `createDb` are already imported in `sources.ts`. If `describeRoute` import is already present, don't duplicate it. Register this route **before** any `/sources/:slug` param route only matters for GET; this is POST and path-distinct from `POST /sources`, so ordering is safe — but place it adjacent to the other source POSTs for readability.

- [ ] **Step 5: Run test to verify it passes**

Run: `bun test workers/api/test/appstore-materialize.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 6: OpenAPI coverage gate**

Run: `bun run scripts/check-openapi-coverage.ts` (or the package script that wraps it — check `package.json`).
Expected: PASS. The `describeRoute` annotation makes `POST /v1/sources/appstore` appear in `/v1/openapi.json`. If it reports the route as undocumented, confirm the worker actually serves openapi.json with the route (run the worker tsc and re-check); only add an ALLOWLIST entry if a documented annotation genuinely can't be detected.

- [ ] **Step 7: Type-check + commit**

Run: `cd workers/api && npx tsc --noEmit && cd ../..`
Expected: no errors.

```bash
git add workers/api/src/lib/appstore-materialize.ts workers/api/src/routes/sources.ts workers/api/test/appstore-materialize.test.ts
git commit -m "feat(api): manual App Store source add (POST /v1/sources/appstore)"
```

---

## Task 9: Web — product-avatar fallback in OG/source display

**Files:**

- Modify: `web/src/lib/og.tsx` (extend `resolveAvatarUrl` ~480)
- Test: `web/src/lib/og.avatar.test.ts` (create, if `web` has a test runner configured; otherwise type-check only)

- [ ] **Step 1: Add a product-preference resolver**

In `web/src/lib/og.tsx`, add a thin wrapper above `resolveAvatarUrl` (line 480) that prefers an explicit product avatar before falling back to the org chain:

```ts
/**
 * Resolve the display avatar for a source/release surface: prefer the parent
 * product's icon (e.g. an App Store app icon), then fall back to the org's
 * avatar → GitHub handle chain.
 */
export async function resolveDisplayAvatarUrl(
  productAvatarUrl: string | null | undefined,
  org: OrgAvatarShape,
): Promise<string | null> {
  if (productAvatarUrl) return productAvatarUrl;
  return resolveAvatarUrl(org);
}
```

- [ ] **Step 2: Wire it at the source/release OG data path**

Find where source/release OG images resolve the avatar (search `resolveAvatarUrl(` call sites in `web/src/`). At any call site that has the parent product in scope, switch to `resolveDisplayAvatarUrl(product?.avatarUrl, org)`. Where no product is in scope, leave `resolveAvatarUrl(org)` unchanged.

Run: `grep -rn "resolveAvatarUrl(" web/src`
Expected: update only the call sites that render a source/release (and have product data available). Org-page call sites stay as-is.

- [ ] **Step 3: Type-check**

Run: `cd web && npx tsc --noEmit && cd ..`
Expected: no errors.

- [ ] **Step 4: Commit**

```bash
git add web/src/lib/og.tsx
git commit -m "feat(web): prefer product avatar for source/release display icon"
```

---

## Task 10: Admin dashboard source-type filter

**Files:**

- Modify: `web/src/app/admin/status/dashboard.tsx` (`SourceTypeFilter` type ~1241; `filterButtons` ~1343)

- [ ] **Step 1: Add `appstore` to the filter union + buttons**

Find the `SourceTypeFilter` local type and the `filterButtons` array (grep `SourceTypeFilter` and `filterButtons` in the file). Add `"appstore"` to the union type and a corresponding entry to the buttons array, mirroring the existing `feed`/`github` entries:

```ts
// type union — add "appstore":
type SourceTypeFilter = "all" | "github" | "scrape" | "feed" | "agent" | "appstore";

// filterButtons — add an entry:
{ value: "appstore", label: "App Store" },
```

Match the exact object shape the surrounding entries use (label key names may differ — copy the neighbor entry's shape).

- [ ] **Step 2: Type-check**

Run: `cd web && npx tsc --noEmit && cd ..`
Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add web/src/app/admin/status/dashboard.tsx
git commit -m "feat(web): add App Store to admin source-type filter"
```

---

## Final verification

- [ ] **Full test suite**

Run: `bun test`
Expected: all pass, including the new `appstore-*` and `products-avatar` suites.

- [ ] **Root + worker type-checks**

Run: `npx tsc --noEmit && cd workers/api && npx tsc --noEmit && cd ../.. && cd web && npx tsc --noEmit && cd ..`
Expected: no errors.

- [ ] **Lint + format**

Run: `bun run lint && bun run format:check`
Expected: clean.

- [ ] **OpenAPI coverage gate**

Run: the `check-openapi-coverage` script (see Task 8 Step 6).
Expected: PASS.

- [ ] **Manual smoke (optional, requires deploy or wrangler dev)**

`POST /v1/sources/appstore` with `{ "url": "https://apps.apple.com/us/app/id324684580" }` and a Bearer token → 201 with a materialized source; a second call returns `status: "existing"`; the product carries `avatarUrl`.

---

## Coverage check (spec → tasks)

- Spec §1 (kind vs type, no-migration enum) → Task 1.
- Spec §2.1 (`metadata.appStore`) → Task 2. §2 "always create a product" → Task 8.
- Spec §3 (adapter) → Tasks 3–4. §3 mutable refresh-on-poll → Task 7 (`refreshAppStoreListing`, created in Step 4a and called from the `fetchOne` branch).
- Spec §4 (ingest flow) + §9 cadence → Task 7 (cadence falls out of existing tiers; no code).
- Spec §5 (version-distinct URL) → Tasks 3 (`versionDistinctUrl`) + 7 (dedup test).
- Spec §7 (assets, hotlink, best-effort) → Task 3 (`media` from screenshots; never blocks). Icon → product avatar (Task 8), per the refinement that the icon lives on the product, not on every release row.
- Spec §8 (product icons) → Tasks 5, 6, 8 (populate), 9 (fallback).
- Spec §6 (manual add + resolver; on-demand deferred) → Task 8. `parseCoordinate` appstore arm is **not** built (deferred per spec §10/§12).
- Spec §9 locale/stale-cache → defaults baked into `parseAppStoreIdentifier` (storefront `us`) + `appStoreCoordFromSource`; accept-and-correct = no extra state (no task needed).
- Spec §10 touchpoints → all mapped to tasks above; admin filter → Task 10.
- Spec §12 out-of-scope (Android, R2 mirroring, on-demand, multi-locale, ratings) → not implemented, by design.
