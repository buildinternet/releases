# CLI changelog on `/updates` — design

**Date:** 2026-06-11
**Status:** approved, ready for implementation plan
**Related:** [self-published changelog design](2026-06-10-self-published-changelog-design.md), self-changelog Phase 2 (#1567/#1572), SDK version-tag rollup (#1541)

## Problem

Yesterday we shipped the project's own product changelog on `/updates` — a date-keyed
stream of daily `rollup` releases for the web app / platform, published from a running
`CHANGELOG.md` into the `releases-sh` org's push-only `agent` source `product-changelog`.

That covered the platform but not the **CLI**, which is a different shape:

- Published to npm as `@buildinternet/releases` (currently **v0.62.0**), versioned with
  **changesets**; every version cuts a git tag + a **GitHub Release** with already-written,
  human-readable notes (changeset summaries, grouped Minor/Patch).
- Ships **fast** — sometimes 2–3 versions in a single day.
- Genuinely a **separate product** from the web app/registry, living out-of-tree in
  `buildinternet/releases-cli`.

So the core tension is **version-keyed (CLI) vs. date-keyed (platform)**, and **separate
product vs. one unified stream**. We want the CLI's release notes on `/updates` without
cluttering the day with one row per version when several ship the same day.

## Decisions (locked during brainstorm)

1. **Data:** The CLI becomes a real **github source** under a new **"CLI" product** in the
   `releases-sh` org — one release row per version, auto-ingested from GitHub Releases.
2. **Layout:** One unified `/updates` **day spine**. Each day shows the platform rollup and,
   when the CLI shipped, a single **combined CLI card** with `vX.Y` version pills. Same-day
   versions combine into one card; each version stays a real, linkable release row.
3. **Voice:** Per-version friendly `titleShort` summaries (already produced by the github
   ingest summarizer) joined into the CLI card's line. Raw changeset notes stay on the
   per-version detail page.

## Why this shape

The CLI already produces excellent release notes via changesets. The github fetch adapter
ingests GitHub Releases **with their bodies** (`packages/adapters/src/github.ts`:
`tag_name` → `version`, `body` → `content`, dedup on the release `html_url`), fetches
**immediately on source-create with no managed-agent cost**, and the ingest pipeline runs
the Haiku/Gemini summarizer so each version gets a `titleShort`/`summary` for free. The
version-keyed github path avoids the invented-version quirk that hit the date-rollups
(that quirk only appears on version-less rollups). Result: ~zero ongoing maintenance, and
the interesting work is purely the `/updates` presentation.

## Architecture

### 1. Data model — one-time seed, no schema change

- `POST /v1/products` → product **"CLI"** under `releases-sh`. Slug `cli` (confirmed not in
  `packages/core/src/reserved-slugs.ts`; fallback `releases-cli`). Set `category`/`kind` so
  it reads as a developer tool. `url: https://github.com/buildinternet/releases-cli`.
- `POST /v1/sources` → **github** source, `url:
https://github.com/buildinternet/releases-cli`, `productSlug: cli`, `type: github`. The
  existing `product-changelog` source keeps `isPrimary`. Creation auto-fetches all ~62
  releases; each lands with `version` = tag, `content` = changeset body, and a
  summarizer-generated `titleShort`/`summary`.
- **Verify** the generated `titleShort`s read cleanly; spot-fix any outliers via
  `generate-content` regenerate.

The seed is reversible (delete source + product; releases cascade/hard-delete) and
idempotent on re-fetch (dedup on `(source_id, url)`).

### 2. Presentation — all in `web/`

Reuse, don't reinvent: the day's CLI versions collapse through the existing
`rollupTags()` / `isTag()` in `web/src/components/collection-timeline-rollup.ts`
(`isTag(r) = r.source.type === "github"`; bucket key `${orgSlug}::${productSlug}` — a "CLI"
product gives a clean bucket).

New, pure, unit-tested helper that turns the org release feed into a day spine:

- **Input:** the `releases-sh` org release array (already SSR-seeded + cursor-paginated in
  `web/src/app/updates/page.tsx`).
- **Discriminate** each release:
  - _Platform_ = `source.slug === "product-changelog"` (`type: rollup`).
  - _CLI_ = `isTag(r)` / `product?.slug === "cli"`.
- **Group by calendar day** of `publishedAt` (newest day first).
- Within a day:
  - Platform block: render the rollup as today.
  - CLI block: feed the day's CLI releases through `rollupTags()` → one
    `vX.Y vX.Y vX.Y` pill group; the joined `titleShort`s become the summary line; each
    pill links to that version's on-site release detail. A single-version day skips the
    rollup and shows one entry.
- Days with only-platform, only-CLI, or both all render cleanly.

New CLI day-card component renders the pill group + joined-summary line + per-version
links. `web/src/app/updates/page.tsx` swaps `OrgReleaseList` for the grouped list,
preserving the SSR seed + cursor load-more (re-group on append).

### 3. What we get for free

Because the CLI is a real product+source, it also gains its own product page
(`/releases-sh/cli` route family), Atom feed inclusion, search indexing, and
**follows/digests** — where the same `rollupTags` pill treatment (PR #1541) already
applies. No extra work for any of those.

## Known effects to accept (out of v1 scope to change)

- The generic `/releases-sh/releases` org page and `/releases-sh.atom` feed will now
  include CLI versions interleaved with platform rollups. That's the honest full feed;
  `/updates` is the curated face. Accepted.
- The org **overview** briefing is generated from recent releases, so it'll begin
  mentioning CLI shipping. Accepted for v1; scoping the overview to the changelog source is
  a later option if it dilutes the platform story.
- **Rollout ordering:** the seed makes CLI versions appear on the _existing_ `/updates`
  (ungrouped) the moment the source exists. So **deploy the grouping code first, seed
  second** — otherwise `/updates` briefly shows flat, ungrouped CLI rows.

## Testing

- Pure day-spine/rollup helper: bun unit tests over fixture feeds — same-day multi-version,
  single-version day, platform-only day, CLI-only day, empty feed, ordering.
- Component render: the CLI card renders pills + joined line; pills link to detail.
- Visual check on the page against seeded (or fixture) data before go-live.

## Build order

1. Pure grouping/rollup helper (TDD).
2. CLI day-card component.
3. Wire `/updates` page to the grouped list.
4. Tests + visual check.
5. **Rollout:** deploy web → seed product + github source → verify summaries + grouped page.

## Out of scope

- Dedicated `/updates/cli` page or bespoke CLI pipeline (rejected: re-authors notes the
  GitHub Release already gives us).
- Folding CLI versions into the daily draft engine / cross-repo reach (rejected: loses
  per-version structure).
- Overview scoping, per-version inline expand (links to detail suffice for v1).
