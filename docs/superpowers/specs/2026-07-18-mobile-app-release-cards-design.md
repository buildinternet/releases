# Mobile-app release cards — restyle + cross-promo deprioritization

**Date:** 2026-07-18
**Status:** Design (approved treatment; pending spec review)

## Problem

Mobile-app (`appstore`) releases render in the compact card surfaces exactly like
first-party changelog releases: a full headline, a version subtitle, a boilerplate
body preview ("Bug fixes and small improvements"), and a media thumbnail. For app
releases this is noise — the body is almost always boilerplate, the version string
carries little meaning to a reader, and the app's icon/screenshots rarely change
release-to-release. The app already gives app releases a distinct, leaner treatment
in the **main feed row** and the **release-detail page** (app icon, platform cue,
suppressed media); the compact card surfaces never got it.

Separately, low-value routine app updates dilute the two _cross-promotional_
discovery surfaces (the "From other products" related rail and the platform-wide
"Recent" ticker), where the goal is to surface notable activity from across the
registry — not every routine point release of every tracked app.

## Goals

1. **Restyle** `appstore` releases in all three compact card surfaces into a lean,
   visually-distinct card that reads as "this is a mobile-app release."
2. **Deprioritize** `appstore` releases in the two cross-promo surfaces: show an app
   release there only when the AI `importance` score flags it as notable
   (`importance >= 4`, the existing flame threshold). Leave the org's own feed alone.

## Non-goals

- No change to how app releases render on the org's own **Releases tab** feed row or
  the **release-detail** page — those already have the treatment we're matching.
- No new importance filtering for non-`appstore` releases anywhere.
- No new feature flag. This is a display + ranking refinement, shipped on. (See the
  "Be judicious with feature flags" convention.)
- No Android/Play Store handling — `appstore` platform is `ios` | `macos` only.

## Surfaces

| #   | Surface                                   | Component                                             | Fetch                           | Restyle |  Importance filter   |
| --- | ----------------------------------------- | ----------------------------------------------------- | ------------------------------- | :-----: | :------------------: |
| 1   | "From other products" related rail        | `web/src/components/related-rail.tsx` (`ReleaseCard`) | REST `GET /v1/related/releases` |   ✅    |    ✅ server-side    |
| 2   | "Recent" ticker (homepage, platform-wide) | `web/src/components/shipping-now-ticker.tsx` (`Card`) | GraphQL `HomepageTicker`        |   ✅    |    ✅ client-side    |
| 3   | "Latest releases" teaser (org's own feed) | `web/src/components/org/latest-releases-teaser.tsx`   | GraphQL `OrgReleases`           |   ✅    | ❌ (not cross-promo) |

Field availability today (from tracing):

- **Surface 1** already returns `importance`; **missing** `source.type` and
  `source.appStore` — both must be plumbed through the REST response.
- **Surface 2** already returns `source.appStore`; **missing** `importance` in the
  ticker query — must be added to the GraphQL operation.
- **Surface 3** already returns `importance`, `source.type`, and `source.appStore` —
  fully equipped; restyle only.

## Behavior A — restyle mobile-app compact cards

A release counts as a mobile-app release when its source is `appstore`. Detection:

- Surfaces 2 & 3: `release.source.appStore != null` (already how the ticker detects it).
- Surface 1: `release.source.type === "appstore"` (after plumbing) — with
  `source.appStore` supplying the icon/platform.

When it is a mobile-app release, the compact card renders the lean form:

- **Leading visual:** the app icon via the existing `AppStoreIcon`
  (`web/src/components/app-store-icon.tsx`), replacing the generic media thumbnail.
- **Title:** the app name (the product/app name — e.g. the source's product name).
- **Meta cue:** a subtle platform label, `iOS` or `macOS`, derived from
  `appStore.platform`. Text cue only — **not** a new chip (per the "no new web chips —
  subtle cues instead" convention: weight/muted color with an `aria-label`).
- **Date:** keep the card's existing date/relative-time element unchanged — this is
  the recency context that replaces the (dropped) version string.
- **Attribution:** keep the org attribution; drop the now-redundant product segment
  when the title already is the app name.
- **Dropped for app releases:** the version string, the body preview text, and the
  media thumbnail.

The non-`appstore` path for every card is unchanged.

### Shared implementation

The three cards are separate components with different surrounding chrome, so there is
no single card to edit. To avoid three divergent implementations, factor the app-card
_inner content_ (icon + name + platform cue) into one small presentational helper
consumed by all three, reusing the existing `AppStoreIcon` and the
`app-source.ts` / `appRowInfoFromWire` helpers. Each card keeps its own outer layout
(grid, ticker slide, teaser row) and swaps its default body for this helper when the
release is an app release.

## Behavior B — cross-promo importance filter

Rule: in surfaces 1 and 2, an `appstore` release is shown only if
`importance >= 4`. Non-`appstore` releases are never filtered by importance.
`importance` is nullable; treat `null`/`undefined` as **below threshold** (an app
release with no score is filtered out of cross-promo — fail-closed toward less noise).

Threshold constant: reuse the existing flame threshold (the value the
`ImportanceMarker` already renders a flame at, 4). Reference the shared importance
constants rather than hard-coding `4`.

### Surface 1 (related rail) — server-side

Filter inside the `/v1/related/releases` worker handler: exclude `appstore` candidate
rows with `importance < 4` (or null) from the candidate set **before** the limit is
applied, so the rail stays full and server-ranked. This is done in the same handler
edit that adds `type`/`appStore` to the response.

### Surface 2 (ticker) — client-side

The ticker already over-fetches (`limit: 40`) and filters client-side via
`isMeaningfulRelease` (`shipping-now-ticker.tsx`). Add `importance` to the
`HomepageTicker` query and extend that existing filter: drop an item when it is an app
release (`source.appStore != null`) and `importance < 4`. No worker change.

## Data plumbing

1. **api-types** (`packages/api-types/src/schemas/related.ts`): additively add
   `type: SourceType` and `appStore: AppStoreSourceInfoSchema` (nullable) to
   `RelatedReleaseSourceSchema`. Additive-only (per the api-types additive-by-default
   policy). **Add a changeset** (`bun run changeset`) — this is a published-package
   change.
2. **api worker** (`/v1/related/releases` handler + its query): select and return the
   source `type` and the resolved `appStore` block (same shape the other release
   queries already resolve), and apply the Behavior-B importance filter for app rows.
3. **web**:
   - Mirror the new fields on `RelatedReleaseItem.source` (`web/src/lib/api.ts`).
   - Add `importance` to `web/src/lib/graphql/operations/homepage-ticker.graphql` and
     regenerate GraphQL types.
   - Implement the shared app-card content helper.
   - Wire all three card components to the restyle; add the ticker's client-side
     filter.

No DB/schema migration. No new env var or feature flag.

## Testing

- **Unit — importance filter helper:** a small pure predicate
  (`shouldShowInCrossPromo(release)` or equivalent) covering: non-app release always
  passes; app release with `importance >= 4` passes; app release with `importance` of
  1–3, `null`, and `undefined` is filtered. Test this predicate directly.
- **Unit — app-card content helper:** renders app icon + name + platform cue for `ios`
  and `macos`; asserts version/body/thumbnail are absent; asserts the platform cue
  carries an accessible label.
- **Card components:** for each of the three, a render test with an `appstore` fixture
  (lean form, no thumbnail/body) and a non-`appstore` fixture (unchanged).
- **Worker handler:** a test for `/v1/related/releases` asserting the response now
  carries `source.type`/`source.appStore`, and that a low-importance app row is
  excluded while a high-importance app row and all non-app rows are retained.
- **api-types:** a schema test that `RelatedReleaseSourceSchema` accepts the new
  fields and that omitting them still parses (additive/back-compat).

## Consumer verification (pre-push)

Per repo convention, run the suites that consume the changed code, not just the
package unit tests: `web/` (all three surfaces), `workers/api` (the related handler),
and the `api-types` schema tests. Then drive the actual surfaces in a browser to
confirm the lean card renders and low-importance app releases drop out of the rail and
ticker.

## Open questions

None blocking. The exact app-name source field on the related rail (product name vs.
source name) is an implementation detail to resolve against the handler's available
columns during the plan.
