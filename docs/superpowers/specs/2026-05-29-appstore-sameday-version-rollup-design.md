# App Store same-day version rollup (#1236)

**Status:** approved 2026-05-29
**Issue:** [buildinternet/releases#1236](https://github.com/buildinternet/releases/issues/1236)

## Problem

App Store apps occasionally ship more than one point version on the same
calendar day (a same-day hotfix). Each store version is deduped into its own
release via the `?v=<version>` URL, so the org releases feed shows several
near-duplicate, low-signal rows for one app on one day — App Store notes are
frequently boilerplate ("bug fixes and improvements") or empty.

The original issue proposed **ingest-time suppression** (`suppressedReason =
"same_day_app_version"`). That was **rejected**: suppression rewrites history
and reads as "this release never existed." The chosen direction is **display-time
rollup** — combine same-day duplicates into one expandable row, exactly the way
the SDK same-day clusters are collapsed (#1233). Every release stays a real,
visible row; the feed just collapses the same-day set and lets the user expand it.

## Scope

- **Same-day only**, mirroring the SDK precedent (#1233). Collapses 2+ versions
  of one app that share a single calendar day. Cross-day cadence (an app shipping
  a point version every few days) is explicitly out of scope — different days,
  different rows.
- **Org releases feed only** (`org-release-list` → `buildFeedEntries`). This is
  the surface the "flooded feed" complaint is about. Collections and the
  source-detail page are out of scope (see below).
- **Display-only.** No DB / schema / API / ingest change. No suppression.

## Mechanism

Two web files change. Both build on the rollup machinery shipped in #1233/#1235.

### 1. `web/src/components/collection-timeline-rollup.ts`

`rollupTags` currently keys every bucket on `${org}::(product ?? source)` and
labels it `product?.name ?? source.name`. That key is correct for SDKs (a
monorepo bumps many package sources under one product, and we _want_ them merged).
It is wrong for App Store: Slack iOS (`slack-ios`) and Slack macOS (`slack-macos`)
both hang off the `slack` product, so a product-keyed bucket would wrongly merge
two platforms into one rollup.

Branch the key + label on `source.type === "appstore"`:

- key → `${org}::${source.slug}` (**per-source**, ignoring product)
- label → `source.name` (the app name)

GitHub / default behavior is unchanged. Add an `isAppStore(r)` predicate next to
`isTag` so the source-type checks stay colocated.

### 2. `web/src/components/org-release-entries.ts`

`appendDayEntries` feeds only `dayReleases.filter(isTag)` (GitHub tags) into
`rollupTags`. Broaden that filter to `isTag(r) || isAppStore(r)` so appstore rows
enter the same per-day rollup pass.

- A bucket of 1 (lone same-day version) returns `kind: "single"` from
  `rollupTags`, is never added to `rollupByMember`, and falls through to a flat
  `{ kind: "row" }` — i.e. the normal #1204 compact app row, unchanged.
- A bucket of 2+ returns `kind: "rollup"` and renders through the existing
  `ReleaseRollupRow`.

### Untouched

- `collection-timeline.tsx` — appstore never reaches its `rollupTags` call: it
  partitions on bare `isTag`, so appstore stays in the "posts → hero" partition.
  Broadening the key logic inside `rollupTags` is therefore inert for collections.
- `source-release-list.tsx` — the app's canonical full-history page; no rollup
  machinery, left flat.

## Rendering

Reuse the existing `ReleaseRollupRow` unchanged:

- Collapsed: **"{appName} · N releases"** + version pills (`v25.5.2 v25.5.1 …`,
  from `r.version ?? r.title` — appstore releases carry a version).
- Expanded: child `ReleaseListItem`s.

The expanded children are **not** passed the `appStore` prop today, so they render
as ordinary rows (title/version/notes + screenshot thumb) rather than the compact
app row. That icon polish — collapsed-header app icon + compact expanded children —
is deliberately deferred to **#1206**, which is already scoped for compact-app
presentation parity across surfaces; the rollup row simply becomes another surface
there.

## Edge cases

| Case                                                           | Result                                                                                   |
| -------------------------------------------------------------- | ---------------------------------------------------------------------------------------- |
| iOS + macOS of one product, same day                           | Two separate buckets (per-source key) — two rollups or two singles, never merged         |
| One appstore version on a day                                  | Flat compact app row, unchanged                                                          |
| appstore + github releases, same org + day                     | Independent rollups (distinct keys; github keyed product??source, appstore keyed source) |
| Product with several appstore sources, 1 version each that day | All singles                                                                              |

## Tests

- `collection-timeline-rollup.test.ts`
  - 2+ same appstore source, implied same day → one rollup keyed per-source, label = app name
  - iOS + macOS same product, same day → two buckets (not merged)
  - appstore + github for one org → distinct buckets
- `org-release-entries.test.ts`
  - appstore rows enter the per-day rollup (2+ → rollup row)
  - lone appstore version stays a flat `row`
  - mixed appstore / post / github day preserves published-desc interleave

## Out of scope

- Ingest-time suppression (rejected).
- Collections feed + source-detail "All Releases" surfaces.
- App icon inside the rollup row (→ #1206).
- Cross-day cadence rollup.
