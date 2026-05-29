# 2026-05-29 — SDK/package cluster grouping in the collections feed

## Problem

On a collections feed page (e.g. `/collections/application-platforms`), a single
org's daily block can be dominated by a monorepo source that publishes many package
tags in one day. Live example (collection `application-platforms`, one 40-item page):

| source                  | product?             | tags that day                                                                                        |
| ----------------------- | -------------------- | ---------------------------------------------------------------------------------------------------- |
| `vercel-cli`            | none                 | 10 (`@vercel/python`, `@vercel/express`, `vercel`, `@vercel/aws`, `@vercel/oidc`, `@vercel/node`, …) |
| `vercel-ai-sdk`         | none                 | 9 (`ai@`, `@ai-sdk/gateway`, `@ai-sdk/openai`, `@ai-sdk/anthropic`, …)                               |
| `turborepo`             | `turborepo`          | 2                                                                                                    |
| `cloudflare-workerd`    | `cloudflare-workerd` | 3                                                                                                    |
| `cloudflare-what-s-new` | none                 | 10 (feed posts — distinct content)                                                                   |

The Vercel block alone renders ~21 near-identical full-height rows, each repeating
its source label (`Vercel CLI` ×10, `AI SDK` ×9). This is noise: a reader scanning a
multi-org playlist does not need every package bump expanded inline.

## Root cause

The collections feed already has a rollup (`TagItem`), but `rollupSameProduct`
(`web/src/components/collection-timeline.tsx`) keys its buckets strictly on
`org.slug::product.slug` and pushes every **null-product** row into a `singles`
list that is never collapsed:

```ts
for (const r of tags) {
  if (r.product) {
    /* bucket by org::product */
  } else {
    singles.push({ kind: "single", release: r });
  }
}
```

`vercel-cli` and `vercel-ai-sdk` carry no product, so all 19 of their tags fall into
`singles` and render flat. Product-bearing sources (`turborepo`, `cloudflare-workerd`)
already roll up correctly — the gap is precisely the null-product monorepo sources.

Two facts make the fix safe and small:

1. `source` (`{ slug, name, type }`) is already on every `CollectionReleaseItem` — no
   API/wire change is needed to group by source.
2. The rollup only runs on the `tags` partition, where `isTag(r) = r.source.type === "github"`.
   Feed/scrape/agent posts (e.g. `cloudflare-what-s-new`) are partitioned into `posts`
   and rendered by `PostHero` — they are never reachable by the rollup, so genuine
   content feeds cannot be over-collapsed.

## Design

Single-component change in `web/src/components/collection-timeline.tsx`. No API,
schema, or other-surface changes.

### Grouping rule

- Within each **day × org** block, bucket GitHub-tag rows by **`product?.slug ?? source.slug`**
  (was: `product.slug`, product-only).
- A bucket with **2+ releases collapses** into one summary header. A bucket with exactly
  **1 release** renders as a normal `CommitLogRow` single (unchanged).
- This **unifies** the existing product rollups (`turborepo`, `workerd`) and the new
  null-product source clusters under one presentation: the summary-header style replaces
  the current "promote newest row + 'N earlier today' toggle" `TagItem` layout for **all**
  rollups. (Confirmed with the user: both rollup types use the summary header.)
- Feed/scrape/agent posts are untouched (still `PostHero`).

### Collapsed header UI (summary-header style)

Collapsed by default:

```
▸ Vercel CLI · 10 releases
    @vercel/python  vercel@54.6.1  @vercel/aws  +7
```

- A caret + `{product?.name ?? source.name} · {N} releases` line. Reuse the existing
  `Caret` component and a `useState` open/closed toggle; clicking the header toggles.
- Inline preview pills: up to **3** newest version labels (`release.version ?? release.title`)
  styled like today's `TagItem` pills, plus a `+{N-3}` overflow count when more exist.
  (Today's `TagItem` shows 4 pills in a two-line block; the one-line header keeps it to ~3.)
- The word **"today" is dropped** from the label. The day-section header (`THU May 28, 2026`)
  sits directly above and already supplies the date; "today" is also wrong on any past-day
  section.
- Expanded → render each release in the bucket as the existing `CommitLogRow`, so the
  per-row summary-expand behavior is preserved. Reuse the indented/left-bordered expanded
  row styling already in `TagItem`.

### Ordering

- Within an org block, source/product groups appear in order of their newest release
  (releases arrive published-desc, so first-seen order already achieves this). No change
  to the existing ordering semantics; the post-rollup "no-product singles after rollups"
  reordering is removed because null-product rows now participate in bucketing.

### Stretch (non-core)

- Hash-aware auto-expand: if the page is deep-linked to a `release.id` that lives inside a
  collapsed group, auto-open that group and scroll to it (mirrors the `SourceChips`
  hash handling in `overview-view.tsx`). Marked optional; not required for the core change.

## Components touched

- `web/src/components/collection-timeline.tsx`
  - `rollupSameProduct` → rename to `rollupTags`; change bucket key to `product?.slug ?? source.slug`;
    drop the separate `singles` path (null-product rows now bucket like any other).
  - `TagListItem` rollup variant: replace `productName`-specific fields with a generic
    `label` (`product?.name ?? source.name`) and keep `releases: CollectionReleaseItem[]`.
  - `TagItem` rollup branch: replace the "promote latest + earlier toggle" markup with the
    summary-header markup (caret + `label · N releases` + inline pills; expanded → list of
    `CommitLogRow`). The `single` branch is unchanged.

## Out of scope

- **Org feed** (`/[orgSlug]`) and category feeds render via `org-release-list.tsx` →
  `ReleaseListItem` (a different date-rail layout with no rollup). Bringing the same
  grouping there is a separate, larger change against a different component — noted as a
  possible follow-up, not part of this work.
- No `kind` plumbing onto the wire (the rejected "one SDK super-group per org" option would
  have needed it). Grouping by `product ?? source` already catches the clusters without it.

## Testing

`rollupSameProduct`/`rollupTags` is a pure function but currently module-private with no
existing tests. Export it (or lift it into a small sibling module, e.g.
`collection-timeline.rollup.ts`) so it can be imported by a net-new unit test. Cases:

1. Null-product source with 2+ GitHub tags → one rollup keyed on source.
2. Product-bearing source with 2+ tags → one rollup keyed on product (unification holds).
3. Source/product with exactly 1 tag → `single`, not a rollup.
4. Mixed buckets in one org/day (e.g. `vercel-cli` ×10 + `vercel-ai-sdk` ×9 + `turborepo` ×2)
   → three rollups, correct counts, correct labels.
5. Non-GitHub posts are filtered out before the function (verify the `isTag` partition still
   excludes them).

Verify with `bun test` and `npx tsc --noEmit` in `web/` (and root).

## Acceptance

- On `/collections/application-platforms`, the Vercel daily block shows three collapsed
  headers (`AI SDK · 9 releases`, `Vercel CLI · 10 releases`, `Turborepo · 2 releases`)
  instead of ~21 flat rows; Cloudflare Changelog feed posts are unchanged.
- Expanding a header reveals each tag as a `CommitLogRow` with working per-row summary expand.
- Product rollups (`turborepo`, `workerd`) now use the same summary-header style.
