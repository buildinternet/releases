# SDK grouping on the org sources page

**Date:** 2026-05-21
**Issue:** [#1080](https://github.com/buildinternet/releases/issues/1080) — Source kind enum, follow-up "Web: `kind` chips on org/product pages"
**Status:** Design approved, pending implementation plan

## Goal

Make the org `/sources` page stop drowning its primary changelog under a wall of
per-language SDK rows. A multi-SDK org (Stripe, AWS, OpenAI…) lists every client
library as its own flat row, so the one platform changelog most visitors came for
competes with a dozen SDKs for attention. Fold the SDK family into a single
collapsible group, collapsed by default, so SDK churn is one tidy line instead of
N rows.

This is the first **user-facing** consumer of the `kind` enum (#1080 Phase A/B
shipped the data model, API filters, CLI flags, and the curated backfill that
classified every visible prod row). The data is classified and live; this is the
web surface catching up.

## Scope

**In scope:** Grouping `sdk`-kind sources into one collapsible block on the org
`/sources` tab (`web/src/components/source-table.tsx`), plus the small additive API
change needed to feed it `kind` (see "Blast radius").

**Out of scope** (each its own later step under #1080):

- Kind chips / labels on non-SDK rows.
- Grouping by every kind (platform / tool / mobile / …). This cut is **SDK-only** by
  deliberate choice — it solves the named noise problem without imposing subheadings
  on every org. Generalizing to all kinds is a later decision if it proves useful.
- The releases-feed `?kind=` filter UI, the homepage / latest feed, and overview
  downweighting by kind.
- Any DB/schema migration (the `kind` columns already exist and are backfilled), and
  any API change beyond emitting `kind` on the org-detail payload.

## Blast radius

The grouping logic is frontend, but it needs `kind` on the org-detail payload —
which the `GET /v1/orgs/:slug` handler does **not** currently emit. The schemas
_allow_ `kind` (`SourceListItem`, `ProductListItem`), but the handler hand-builds
its rows and drops it:

- `getOrgSourcesWithStats` (`workers/api/src/queries/orgs.ts:94`) never `SELECT`s
  `s.kind` (and `SourceWithStats` in `workers/api/src/queries/shared.ts` has no
  `kind` field).
- The `sourcesWithStats` map (`workers/api/src/routes/orgs.ts:352`) doesn't copy
  `kind`.
- The org-detail products query (`routes/orgs.ts:273`) selects only
  `id, slug, name, url, description, sourceCount`, and `OrgDetailProductSchema`
  (`packages/api-types/src/schemas/orgs.ts:113`) `.pick(...)` omits `kind`.

So `org.sources[].kind` and `org.products[].kind` are both `undefined` on the
`/sources` page today — there is no frontend-only path. The feature requires a
small, **additive, backwards-compatible** API change to emit each source's own
`kind` plus each product's `kind` (so the web can apply the source→product
inheritance the resolution rule mandates — the backfill deliberately set `kind`
on parent products and left some child sources null).

**No DB migration** — the `kind` columns already exist and are backfilled; this is
purely about emitting columns the handler currently discards. Orgs with fewer than
2 resolved SDK sources render byte-for-byte identical to today.

`org.sources` and `org.products` are already passed into `SourceTable` from
`web/src/app/[orgSlug]/(org)/sources/page.tsx` — they just gain a `kind` field.

## Membership: what counts as an SDK

A source joins the group when its **resolved** kind is `sdk`:

```
resolveSourceKind(source, product) === "sdk"
```

`resolveSourceKind` (from `@buildinternet/releases-core/kinds`) returns the source's
own `kind` if set, else the parent product's `kind`, else `null`. To do the
inheritance lookup we build a `productSlug → kind` map from the `products` prop and
resolve each source against its `productSlug`.

This matches the project-wide resolution rule (`source.kind` wins; inherit from
product when null) so the web surface agrees with the API's release-feed COALESCE
behavior.

## Threshold: when the group forms

The collapsible group only forms at **≥ 2** resolved SDK sources. With 0 or 1, the
SDK source(s) render as normal flat rows — a collapsible "group of one" is friction
with no payoff.

## Structure and placement

```mermaid
flowchart TD
    A[org.sources] --> B{resolve kind == sdk?}
    B -->|no| C[flat rows: sortByImportance, active then muted-inactive]
    B -->|yes| D[sdk bucket]
    D --> E{>= 2 sdk sources?}
    E -->|no| C
    E -->|yes| F[SDKs group: collapsed by default, bottom of active section]
    C --> G[render table]
    F --> G
```

- **Non-SDK sources:** render exactly as today — flat, sorted by `sortByImportance`
  (primary first, then release count desc), active rows then muted-inactive rows.
- **SDKs group:** a single collapsible block placed at the **bottom of the active
  section**, just above the muted-inactive rows. Collapsed by default. This pushes
  SDK churn down so it never competes for the top of the list.

## Group header (no chips)

The header is a full-width row inside the same `<table>` (`<tr><td colSpan>`),
styled as a plain text subheading — **no color chip, no count badge**.

The disclosure affordance is an **SVG chevron** that rotates on open (mirroring
`web/src/components/inactive-sources-toggle.tsx`), not a Unicode caret or emoji —
per the project's no-emoji-in-UI rule.

- **Collapsed:** chevron + subheading **SDKs** + a member preview.
  - Preview = member display names, ordered by release count desc, joined with
    `·`, on a single line, truncated with CSS `text-overflow: ellipsis`. No
    trailing "+N", no count — the line just clips to the column width.
  - Example: `SDKs   node · python · php · ruby · go · java · .NET`
- **Expanded:** rotated chevron + subheading **SDKs**, then the SDK rows beneath in
  the existing indented row style, keeping every current column (Type, Product when
  the org has products, Releases, sparkline, Last update).

## Within-group ordering and inactive SDKs

- SDK rows are sorted by the existing `sortByImportance` (release count desc;
  primary-ness is irrelevant inside an SDK family but the comparator is reused
  as-is).
- **Inactive SDK sources** (`isInactive` → hidden / paused / 0 releases) are pulled
  _into_ the group and shown muted at its bottom, rather than scattered into the
  global inactive section. The SDK family stays whole as one collapsible unit.

## Interactivity

Expand/collapse is local React state and resets on navigation — no persistence in
this first cut.

`SourceTable` is currently a server component. Rather than make the whole table a
client component, extract **only** the collapsible block into a small
`"use client"` child — `SdkSourceGroup` — that owns the open/closed state and
renders the subheading `<tr>` plus its member `<tr>`s. The rest of the table stays
server-rendered. A client component rendering `<tr>` children inside a
server-rendered `<tbody>` is fine.

## Pure helper + testing

Factor the partitioning out of the React tree into a pure, unit-testable helper:

```ts
partitionSdkSources(
  sources: SourceListItem[],
  products: OrgDetail["products"],
): { flat: SourceListItem[]; sdk: SourceListItem[] }
```

It applies the resolve-kind lookup and the ≥2 threshold: when fewer than 2 SDK
sources resolve, they're returned in `flat` and `sdk` is empty (so the caller
renders no group). Tests cover:

- Membership via the source's own `kind`.
- Membership via inherited `product.kind` when `source.kind` is null.
- Threshold boundary: 1 SDK → flat; 2 SDK → grouped.
- A source with `kind: "sdk"` whose product is `platform` still groups (source wins).
- The preview string: ordering by release count, `·` join.

Component-level rendering (collapsed vs expanded, placement at bottom of active) can
be exercised against the helper output.

## Files

**Modify — API (emit `kind` on org detail)**

- `workers/api/src/queries/shared.ts` — add `kind: string | null` to the
  `SourceWithStats` type.
- `workers/api/src/queries/orgs.ts` — `getOrgSourcesWithStats` SELECT: add `s.kind`.
- `workers/api/src/routes/orgs.ts` — `sourcesWithStats` map: add
  `kind: row.kind ?? null`; org-detail products query: add `kind: productsActive.kind`.
- `packages/api-types/src/schemas/orgs.ts` — add `kind: true` to
  `OrgDetailProductSchema`'s `.pick(...)`.

**Modify — Web**

- `web/src/components/source-table.tsx` — partition sources, render the non-SDK flat
  rows as today, render the `SdkSourceGroup` block between flat-active and
  flat-inactive rows; thread an `indent` flag through `renderRow`.

**Create — Web**

- `web/src/lib/sdk-grouping.ts` — pure helpers `partitionSdkSources` + `sdkPreview`
  - `SDK_GROUP_MIN`.
- `web/src/components/sdk-source-group.tsx` — `"use client"` collapsible block
  (subheading `<tr>` + chevron toggle + conditional member rows), mirroring the
  existing `inactive-sources-toggle.tsx` disclosure idiom.

**Create — Tests**

- `tests/unit/sdk-grouping.test.ts` — unit tests for the pure helpers (root
  `bun test`).
- Extend `tests/api/source-kind-read.test.ts` — assert `GET /v1/orgs/:slug` emits
  `kind` on `sources[]` and `products[]`.

Note: source→product inheritance on the web reads the source's own `kind` (now
emitted) and falls back to the parent product's `kind` (now emitted) via
`resolveSourceKind` + a `productSlug → kind` map built from `org.products`.

## Open questions

None outstanding. Confirmed during design: SDK-only scope, treatment B (collapsible
groups) with plain text subheadings, member preview instead of count, bottom
placement, ≥2 threshold, inactive SDKs pulled into the group, no expand-state
persistence.
