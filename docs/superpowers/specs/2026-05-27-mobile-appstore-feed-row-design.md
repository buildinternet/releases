# 2026-05-27 — Compact "app update" presentation for App Store releases

## Problem

App Store sources (`source.type === "appstore"`, iOS + macOS — added in #1160) pack every
listing screenshot into `release.media[]`. In the feed, `ReleaseListItem` picks the first
image/gif in `media[]` as the 120×72 thumbnail, so an arbitrary App Store screenshot becomes the
row's thumbnail — rarely meaningful. The row also gives no signal that the item is a mobile/desktop
app, and most app updates carry boilerplate or empty release notes ("Bug fixes and performance
improvements"), so the standard version + notes + thumbnail layout is mostly noise for these rows.

## Goal

Render App Store releases as a compact, app-aware row: the app icon, the app name + version, and a
"Available for iOS/macOS" byline — expandable to the release notes when someone wants them. Drop the
screenshots entirely.

## Decisions (locked during brainstorming)

- **Trigger:** `source.type === "appstore"`. Covers iOS and macOS; matches the exact problem
  (screenshots-as-media + boilerplate notes). Already on the feed wire, no new classification.
  Rejected `kind === "mobile"` (needs wire threading, misses macOS, could catch GitHub-sourced
  mobile SDKs that don't have this problem).
- **Collapsed layout (Option B, chosen via visual companion):** heading is **"{AppName} v{version}"**
  (app name leads so it isn't buried); byline is **"Available for {iOS|macOS}"**; app icon at left;
  chevron affordance; no screenshot thumbnail.
- **Screenshots:** dropped everywhere for appstore rows — collapsed, expanded, and on the release
  detail page. `media[]` stays in the DB; it just isn't rendered for appstore rows.
- **Expanded:** reveals the existing release-notes markdown, or "No release notes provided." when
  empty/whitespace, plus a "View on the App Store ↗" link (the existing `release.url`).
- **Scope:** everywhere `ReleaseListItem` renders (org feed + source feed) and the release detail
  page. Homepage "shipping now" ticker and the search-results card are out of scope (separate
  renderers) — tracked as follow-ups.

## Architecture

### Data: thread platform + icon onto the feed wire

Both fields already exist on the source row, in `source.metadata.appStore`
(`packages/adapters/src/source-meta.ts`):

```ts
appStore?: {
  trackId: string;
  bundleId?: string;
  storefront: string;
  platform: "ios" | "macos";
  firstPublishedAt?: string;
  minOsVersion?: string;
  artworkUrl?: string; // upscaled 1024px mzstatic PNG
}
```

They are **not** on the feed wire today. Add an optional, source-derived block to the feed item's
`source` object, populated only when the source is appstore:

```ts
source.appStore?: { platform: "ios" | "macos"; iconUrl: string | null }
```

- `iconUrl` ← `source.metadata.appStore.artworkUrl` (null when absent).
- `platform` ← `source.metadata.appStore.platform`.
- App name for the heading ← `source.name` (the adapter stores `trackName` there; see
  `refreshAppStoreListing` in `workers/api/src/lib/appstore-materialize.ts`).

**Touch points:**

- `packages/api-types` — extend the `source` shape on `OrgReleaseItem` and `ReleaseLatestItem`
  (source of truth for the wire).
- API handlers that build those items — `workers/api/src/routes/orgs.ts` (org releases feed) and
  `workers/api/src/routes/releases.ts` (latest feed): select `sources.metadata` if not already
  selected, parse via `getSourceMeta`, and attach `appStore` for appstore sources.
- `web/src/lib/api.ts` — mirror the new field on the consumer types (`LatestReleaseItem` and the
  org release item type).

No DB schema change. No migration. (Confirm whether any of these handlers already select
`sources.metadata`; if so, only the mapping is new.)

### Rendering: `web/src/components/release-item.tsx`

Add a branch in `ReleaseListItem` taken when `release.source?.appStore` is present. The branch
replaces the standard heading / subtitle / collapsed-body-with-thumbnail block:

- **Collapsed (default state):**
  - App icon, 36px, rounded, at the left.
  - Heading: `{source.name} v{version}` (version muted/mono). Falls back to just `{source.name}`
    when `version` is null. Keeps the `↗` external-source link and the `/release/:id` deep link on
    the app-name heading, consistent with the standard row.
  - Byline: `Available for iOS` / `Available for macOS` (mapped from `platform`).
  - Chevron affordance. **Always expandable** for appstore rows — do not gate on the
    `isOverflowing` ResizeObserver check, because a one-line row never overflows but still needs to
    reach the notes.
  - No `media[]` render, no `MediaGallery`.
- **Expanded:**
  - Release-notes markdown (`stripLeadingTitle(release.content || release.summary, ...)`), reusing
    the existing markdown pipeline.
  - When the notes are empty/whitespace after stripping: render "No release notes provided."
    (muted).
  - "View on the App Store ↗" link → `release.url`.
  - Screenshots stay hidden.

**Detection must ride on `release.source`, not `sourceByline`.** `sourceByline` is only passed when
an org has multiple sources (`multipleSourcesExist`), so a standalone single-source app would
otherwise miss the branch. This means `ReleaseListItem`'s `release` prop must carry `source`
(widen the prop type, or pass an explicit `appStore` prop derived by each list wrapper).

### Detail page: `web/src/app/release/[id]/release-content.tsx`

Lighter treatment for appstore releases: show the app icon + "Available for {platform}" byline, and
**suppress the screenshots** (otherwise "drop everywhere" leaks here). Notes render as normal (with
the same empty-notes fallback). This requires the same `source.appStore` data on whatever payload
the detail page consumes.

### Icon sizing + edge cases

- Stored `artworkUrl` is a 1024px mzstatic PNG. Add a small helper (mirroring `upscaleArtwork` in
  `packages/adapters/src/appstore.ts`) that rewrites the `/{w}x{h}bb.png` dimension suffix down to
  ~96px (2× a 48px box), so we don't ship a 1024px asset into a 36px slot. Likely home:
  `packages/rendering/src/media-url.ts` or `web/src/lib/media.ts`.
- Render the icon cross-origin (`unoptimized` / plain `<img>`): mzstatic is cross-origin and CF
  Image Transformations 403 on cross-origin (existing constraint, see media-pipeline notes).
- **No icon** (`iconUrl === null`): neutral rounded placeholder showing the app's first initial —
  preserves the "it's an app" cue.
- **No version:** heading is just the app name.

## Testing

- **api-types / handler:** an appstore source emits `source.appStore = { platform, iconUrl }`;
  a non-appstore source omits the block. Platform and icon read from `source.metadata.appStore`.
- **`ReleaseListItem`:** appstore release renders the compact branch (icon + "{AppName} v{version}"
  + "Available for iOS", no thumbnail, no media gallery); empty/whitespace notes → "No release
  notes provided."; expanding reveals notes + App Store link; a non-appstore release is unchanged.
- **Detail page:** appstore release suppresses screenshots and shows the app icon + platform byline.

## Out of scope / follow-ups

- Homepage "shipping now" ticker (`shipping-now-ticker.tsx`) — separate renderer.
- Search-results card (`search-results.tsx`) — separate renderer; would need the same
  `source.appStore` data threaded into `buildReleaseHits`.
- Backfill / ingest changes: none. The icon and platform are already captured at onboarding/poll.
