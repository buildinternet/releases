# Media thumbnails on compact release cards

**Date:** 2026-07-09
**Status:** Approved (design)

## Goal

When a release featured in a compact "highlight reel" surface has associated
media (screenshot, GIF, or video poster), show a small visual aid — a thumbnail
— inside that card. Applies across every compact release-card / list-row surface
in the web app, not just the home-page RECENT carousel.

Non-goal: changing the prominent, media-rich feed rows (`release-item.tsx`) that
already render thumbnails; redesigning card layouts; adding placeholders for
media-less releases.

## Behavior

- A release with a usable image/GIF thumbnail renders a small (~40×40),
  rounded, `object-cover` thumbnail matching the existing `related-rail.tsx`
  treatment.
- A release with **no** usable media renders exactly as it does today — no
  placeholder, no fallback icon, **no layout shift**.
- "Usable media" = the first `media[]` entry of type `image` or `gif`, using
  `r2Url ?? url`. Video-only media is not used as a thumbnail here (the ticker
  already surfaces a video-source affordance separately). This matches the
  existing first-image picker semantics in `related.ts`.

## Surfaces

| Surface                      | File                                                | Data source                                              | Change                                      |
| ---------------------------- | --------------------------------------------------- | -------------------------------------------------------- | ------------------------------------------- |
| RECENT carousel              | `web/src/components/shipping-now-ticker.tsx`        | GraphQL `homepage-ticker.graphql`                        | Add `media` selection + render thumb        |
| Org "Latest releases" teaser | `web/src/components/org/latest-releases-teaser.tsx` | GraphQL `org-releases.graphql` (already selects `media`) | Render thumb only                           |
| Also-covered-by rail         | `web/src/components/also-covered-by.tsx`            | REST `/v1/releases/:id/coverage`                         | Consume new server `thumbnail`              |
| Lookup rail preview          | `web/src/components/lookup-rail.tsx` (`RelPreview`) | REST lookup releases payload                             | Consume new server `thumbnail`              |
| Related rail                 | `web/src/components/related-rail.tsx`               | REST `/v1/related/releases`                              | **No change** — already renders a thumbnail |

## Backend — API worker (`workers/api/`)

1. **Extract the shared picker.** The first-image thumbnail logic currently
   lives as a private inline function `firstImageThumbnail(raw, mediaOrigin)` in
   `workers/api/src/routes/related.ts` (~lines 369–379). Move it into
   `workers/api/src/utils.ts` next to `parseReleaseMedia` and export it. Refactor
   `related.ts` to import it. This is the single derivation used by every
   endpoint.
   - Returns `{ url, alt? } | null`. `parseReleaseMedia` already resolves
     `r2Key → r2Url` against `mediaOrigin`, so no new URL logic.

2. **Coverage** (`GET /v1/releases/:id/coverage`,
   `workers/api/src/routes/releases.ts`, `fetchCoverageSiblings` ~lines
   400–425): add `media: releases.media` to the drizzle `.select({...})` (same
   `releases` table, no new join), and derive `thumbnail` via the shared helper
   in the row mapping.

3. **Lookup releases preview**: add a derived `thumbnail` to the slim lookup
   releases payload. The underlying full-row lookup query already carries `media`
   (bare `.select()` = `$inferSelect`), so the work is (a) add the field to the
   payload schema and (b) derive it where the slim payload is assembled.
   - **Open item to pin during implementation:** confirm the exact payload the
     `lookup-rail.tsx` `RelPreview` consumes. The GET `source-by-slug` /
     `source-by-coordinate` endpoints return _no_ releases; the release list the
     rail shows comes from the search-embedded / materialize lookup payload
     (`LookupResultPayload.releases`, `packages/api-types/src/schemas/search.ts`
     ~lines 188–220). Trace the actual data path before wiring, and derive the
     thumbnail at that assembly site.

## API types (`packages/api-types/`, published)

- Add optional `thumbnail?: { url: string; alt?: string } | null` to:
  - `ReleaseCoverageSibling` (`schemas/releases.ts` ~line 121).
  - the slim lookup releases item (`schemas/search.ts` ~line 202).
- Both are **additive + optional** — safe wire change; older responses omit them.
- **Do not create a new changeset.** Extend the existing pending changeset
  `.changeset/latest-feed-kind-group.md` (already a `minor` bump of
  `@buildinternet/releases-api-types`) to mention the added `thumbnail` fields,
  so it rides the next release the user is about to cut.

## Frontend — web (`web/`)

- **Shared helper:** add `pickReleaseThumb(media)` to `web/src/lib/media.ts` —
  returns the first `image`/`gif` entry's display URL via the existing
  `releaseThumbUrl` (`r2Url ?? url`), or `null`. Used by the GraphQL-fed
  surfaces. (Do not refactor the existing inline pickers in `release-item.tsx` /
  `collection-timeline.tsx` / `search-results.tsx` — out of scope.)
- **RECENT ticker:** add `media { type url alt r2Url }` to
  `homepage-ticker.graphql`, re-run codegen (`web/codegen.ts`), render the thumb
  in the card via `pickReleaseThumb`.
- **Org latest-releases teaser:** render the thumb via `pickReleaseThumb` (media
  already in `org-releases.graphql`).
- **Also-covered-by** and **lookup-rail preview:** render the new server-provided
  `thumbnail` field.
- **Shared presentation:** one small thumbnail treatment reused across all four
  new surfaces, matching `related-rail.tsx` (~40×40, rounded, `object-cover`,
  same border). Extract a tiny presentational component if it reduces
  duplication; otherwise inline consistently. Thumbnail is decorative — `alt`
  empty when the media has no alt text.

## Testing

- Unit: `pickReleaseThumb` (image/gif picked, video/empty → null, `r2Url`
  preferred). Shared API `firstImageThumbnail` extraction — existing related.ts
  behavior unchanged (keep/port any existing coverage).
- Component: ticker card renders a thumbnail when media present and renders
  unchanged (no thumb node, no layout shift) when absent. Same for the teaser.
- API: coverage response includes `thumbnail` when the sibling has image/gif
  media and omits/nulls it otherwise; lookup payload likewise.
- Verify: drive the home page and a release-detail page in the running app and
  confirm thumbnails appear on cards with media and are absent (no shift)
  otherwise.

## Risks / notes

- `api-types` is published and consumed by the OSS CLI — additive optional
  fields only; no renames/removals.
- The lookup payload data-path ambiguity (above) is the one item to resolve
  early; everything else is mechanical.
- Keep the four new surfaces visually identical to `related-rail` so the app
  reads as one system.
