# Friendly release URLs (Zendesk-style)

**Date:** 2026-07-04
**Status:** Approved design, pre-implementation

## Goal

Make release detail URLs human- and crawler-readable by appending a slugified
title to the release ID, Zendesk-style
(`/release/rel_<id>-claude-code-2-0-adds-hooks`). The immutable `rel_` ID at
the front of the segment remains the only routing key: bare-ID links, stale
slugs, and mangled slugs all resolve and 301 to the current canonical form.
The slug follows the current title (Zendesk semantics) — regenerating a title
changes the canonical URL, and that churn is acceptable because the ID keeps
every old link alive.

Explicitly out of scope: adding releases to the sitemap (they stay excluded
per the #1601 index-bloat cleanup), any new AI generation pass (slugs derive
from the existing `title_short`), MCP tool / Atom feed / webhook payload
changes (they can adopt the new API field later), and any schema change.

## URL shape and parsing

Canonical form: `/release/rel_<21-char-nanoid>-<slug>`.

nanoid's default alphabet includes `-` and `_`, so the segment cannot be split
on a delimiter. Parsing is positional: a new `parseReleaseParam()` in
`packages/core` extracts `rel_` + exactly 21 chars as the ID; if the next
character is `-`, everything after it is slug decoration and is ignored for
lookup. A segment that does not match the positional shape falls through to
today's behavior (the whole segment is treated as an ID attempt, which leads
to the existing 404 path).

## Slug derivation

Pure helpers in `packages/core` (in `slug.ts` or a sibling `release-slug.ts`):

- `releaseSlug(release)` = `toSlug(titleShort ?? titleGenerated ?? title ?? version ?? "")`,
  capped at ~80 chars with truncation on a hyphen boundary; returns `""` when
  nothing usable exists.
- `releasePath(release)` = `/release/${id}` when the slug is empty, else
  `/release/${id}-${slug}`.

No stored slug column. `title_short` (already generated at ingest by the
existing Haiku lane) is the primary raw material; no new model call or prompt
change.

## Web route behavior

`web/src/app/release/[id]/page.tsx`:

1. Parse the incoming param with `parseReleaseParam()`.
2. Fetch the release by ID, as today.
3. Compute the current canonical path with `releasePath()`.
4. If the incoming segment differs from the canonical segment, issue a
   permanent redirect (`permanentRedirect`) to the canonical path. One rule
   covers bare-ID links, stale slugs, and mangled slugs.
5. `alternates.canonical` and `openGraph.url` switch to the slugged path.

The `opengraph-image` route uses the same parse so OG images keep working
under slugged URLs.

## Internal link emission

Every place web builds `/release/${id}` (org/source/product timelines, search
results, collections, updates pages) switches to the shared path helper. List
responses generally already carry `titleShort`/`titleGenerated`; during
implementation, verify each list payload includes those fields and add them
where missing so no surface emits bare-ID links inconsistently.

## API surface

- Release responses (detail and list items) gain an additive computed
  `webUrl` field: absolute `https://releases.sh/release/rel_…-slug`, built
  server-side from `WEB_BASE_URL` + the shared core helper.
- `@buildinternet/releases-api-types` gets a minor bump documenting the field
  (additive wire change).
- `GET /v1/releases/:id` tolerates the slugged form by running the same
  positional parse before lookup, so a copied web URL segment works in the
  API and CLI.
- MCP tools, Atom feeds, and webhook payloads are unchanged this round; they
  inherit `webUrl` availability for later adoption.

## Edge cases

- Release with no usable title/version → empty slug → bare-ID canonical; the
  redirect comparison sees equal segments, so no loop.
- A slug that happens to be 21 valid nanoid chars cannot be mistaken for an
  ID: the ID is consumed positionally before the slug is considered.
- Title regenerated → the previously-canonical slugged URL 301s to the new
  one on next visit. Accepted by design.
- Non-`rel_` garbage → existing 404/not-found path, unchanged.

## Testing

- Unit tests (`tests/`) for `parseReleaseParam`: bare ID, slugged form,
  IDs containing `-`/`_`, garbage input, and the 21-char-slug case.
- Unit tests for `releaseSlug`: fallback chain, hyphen-boundary truncation,
  empty result.
- Web-side coverage for the redirect decision (redirect on stale/bare/mangled,
  no redirect on canonical).
- API tests: slug-tolerant `GET /v1/releases/:id`, `webUrl` present and
  correctly formed on detail and list responses.

## Decisions log

- **Derived, not stored** — user chose Zendesk semantics: canonical follows
  the current title; the stable ID makes churn safe. No migration.
- **No dedicated AI slug field** — `toSlug(title_short)` is sufficient;
  revisit only if it produces poor slugs in practice.
- **Sitemap: releases stay out** — friendly URLs propagate via shared links,
  OG tags, and crawl of org/feed pages without re-inviting index bloat.
- **Scope: web + API field** — MCP/feeds/webhooks adopt later.
