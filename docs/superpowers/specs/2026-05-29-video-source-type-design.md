# Video source type (YouTube first) — design

**Date:** 2026-05-29
**Status:** Approved design; implementation plan to follow.

## Summary

Add a first-class `video` source type so product-launch videos (starting with
YouTube channels/playlists) become indexed releases. The type is **provider-
generic** (`youtube` now; `vimeo` / `wistia` later) and rides the existing feed
fetch machinery internally, because every supported provider exposes an
Atom/RSS feed. v1 ingests each video as a lightweight, summarizer-cleaned
standalone release; richer paths (transcripts, coverage de-duplication) are
explicit fast-follows.

Motivating example: the "Product Launches" playlist on Anthropic's _Claude_
channel — `https://www.youtube.com/playlist?list=PLmWCw1CzcFilOIgUYuMIJ2iZMo09Ho0va`.

## Why this is worth doing — empirical grounding

We matched all 14 videos in that playlist (2026-03-19 → 2026-05-12) against
everything we currently index for Anthropic in the same window:

| Video (date)                                              | Counterpart in our index?                                   |
| --------------------------------------------------------- | ----------------------------------------------------------- |
| Cowork is now generally available (04-09)                 | ✅ same-day "Claude Cowork generally available"             |
| Introducing Claude Managed Agents (04-08)                 | ✅ same-day "Claude Managed Agents launched in public beta" |
| New agents for legal professionals (05-12)                | ❌ none                                                     |
| Introducing agent view in Claude Code (05-11)             | ❌ none (buried in a version bump)                          |
| New agents for financial services (05-05)                 | ❌ none                                                     |
| Find & fix security vulnerabilities (04-30)               | ❌ none                                                     |
| Claude connects to Autodesk Fusion / Blender (04-28)      | ❌ none                                                     |
| All your everyday apps, in one conversation (04-23)       | ❌ none                                                     |
| New Claude Code desktop app (04-14)                       | ❌ none                                                     |
| How Notion built with Managed Agents (04-08)              | ❌ none (customer case study)                               |
| Mobile / "from anywhere" / preview-running-app (03-19→25) | ❌ none                                                     |

Two conclusions drove the design:

1. **Videos are mostly additive, not redundant.** Only 2 of 14 have any
   counterpart we already index; the rest are launches we miss entirely
   (vertical Cowork agent packs, app integrations, the security scanner, the
   desktop/mobile apps). The playlist is a high-signal launch radar.
2. **Date drift is a non-issue.** The two that _do_ match match **same-day**,
   so coverage auto-linking (a fast-follow) can be conservative when it ships,
   and its absence in v1 costs almost nothing — standalone ingest captures
   ~85% of the value immediately.

A curated "Product Launches" playlist still leaks non-launch content (the Notion
customer case study), so a marketing filter is part of v1, not optional.

## Decisions (settled during brainstorming)

- **Role:** ingest standalone + (later) coverage-link. v1 ships standalone
  ingest only; coverage auto-linking is deferred.
- **Content depth:** description-only, summarizer-cleaned. The adapter is built
  so transcript enrichment can be layered on later without reshaping it.
- **Structure:** a generic `video` source type, provider-discriminated, that
  reuses the feed parser internally — _not_ a YouTube-specific type, and _not_
  a plain untyped feed.

### Why `video` is a new type but App Store-style fetch wiring is _not_ needed

App Store (#1160) earned a dedicated type because it needs a bespoke fetch
mechanism (iTunes Lookup API) that cannot ride the feed adapter. YouTube (and
Vimeo/Wistia) all expose native Atom/RSS, so the _fetch_ is feed-shaped. We add
the `video` type for **semantics and presentation** (it is a distinct medium),
but its **polling behaves feed-like** (ETag conditional GET + backoff), not
App Store-like (always-changed).

## Architecture

### 1. Source type & schema

- Add `"video"` to `SOURCE_TYPES` — `packages/core/src/source-enums.ts:10`.
- Drizzle's `text("type", { enum: [...] })` is a TS-level constraint only; the
  SQLite column is plain `TEXT`. Widening the enum (`schema.ts:314` plus the
  `sourcesActive` / `sourcesVisible` views at `schema.ts:1010` and the
  `releasesVisible` view) is therefore a **no-DDL** change. It still ships with a
  **comment-only marker migration** to satisfy the schema-pairing CI gate (see
  the `reference_schema_pairing_gate_marker_migration` convention — wrangler
  applies it; `tests/db-helper.ts` skips it).
- `SourceTypeSchema = z.enum(SOURCE_TYPES)` in
  `packages/api-types/src/schemas/sources.ts:10` picks up the new value
  automatically. Additive `api-types` minor bump.
- New nested metadata block in `packages/adapters/src/source-meta.ts` (parity
  with `metadata.appStore`):
  - `video: { provider: "youtube" | "vimeo" | "wistia"; channel?: { id?; handle?;
title?; playlistId?; playlistTitle? } }` — provider discriminator + resolved
    identity for display and re-resolution.
  - `feedUrl` / `feedType` (existing) hold the Atom endpoint, so polling reuses
    feed machinery. Storing `feedUrl` is what lets a video source ride the
    existing poll path with no gate edits (see §3).

### 2. Provider registry

New `packages/adapters/src/video/` package area:

- `providers.ts` — a registry table. Each provider entry implements:
  - `matchUrl(url): boolean` — does this URL belong to the provider?
  - `resolveFeed(url): Promise<{ feedUrl; canonicalUrl; channel }>` — turn a
    human URL into the Atom/RSS endpoint plus channel identity.
  - `parseFeed(xml): { channel, releases }` — provider-specific XML parse
    producing channel identity + `RawRelease[]`.
- `index.ts` — `fetchAndParseVideoFeed(feedUrl, provider, conditionalHeaders?,
fetchImpl?)` that fetches the feed (mirroring `fetchAndParseFeed`'s transport:
  bot UA, conditional GET, 304-handling) and delegates the parse to
  `provider.parseFeed`. The parse is provider-specific because the generic feed
  parser (`@rowanmanning/feed-parser`) drops the `media:*` namespace — so it
  would lose both the thumbnail and the description body. The provider parses
  with `fast-xml-parser` (new dep) which keeps `media:group` / `media:thumbnail`
  / `media:description` / `yt:videoId` as literal keys.

YouTube provider specifics:

- `resolveFeed`:
  - `…/playlist?list=PL…` → `https://www.youtube.com/feeds/videos.xml?playlist_id=PL…`
  - `…/channel/UC…` → `…/feeds/videos.xml?channel_id=UC…`
  - `…/@handle` (or `…/c/Name`, `…/user/Name`) → fetch the channel page, scrape
    the `"channelId":"UC…"` (or the RSS `<link>`) to derive the `channel_id`
    feed. The one fragile path; playlist and `/channel/UC…` URLs are pure.
- `parseFeed` (YouTube Atom carries `yt:` + `media:` namespaces) returns
  `{ channel, releases }`, mapping each entry to a `RawRelease`:
  - `url` = `link[rel=alternate]` (`https://www.youtube.com/watch?v=<videoId>`).
  - `media: [{ type: "image", url: media:group/media:thumbnail/@url, alt: title }]`.
  - `content` = `media:group/media:description` (the creator's description, used
    as-is; `contentFromSummary` is intentionally left unset — see §4).
  - feed-root `channel` = `{ id: yt:channelId, title: author/name,
playlistId: yt:playlistId, playlistTitle: title }`.

This registry is the seam Vimeo/Wistia plug into later — no other layer changes
to add a provider.

### 3. Fetch path — three edits (not four)

Because a video source **has `metadata.feedUrl`**, it is already admitted by
`queryDueSources` (its `feedUrl IS NOT NULL` clause) and already HEAD-checked by
`pollOne` like any feed — **those two functions need no edit.** That's the App
Store contrast: App Store has no feed, so it needed explicit `type = 'appstore'`
clauses in both. Video only needs the _parse_ intercepted plus two eligibility
allowlists:

1. **`fetchOne` dispatch** (`workers/api/src/cron/poll-fetch.ts:~1291`) — new
   `else if (isVideoFetched(source))` branch _before_ the generic feed `else`
   (otherwise the generic parser runs and drops thumbnail + description). It
   builds conditional-GET headers from `meta.feedEtag`/`feedLastModified`, calls
   `fetchAndParseVideoFeed(meta.feedUrl, resolveVideoProvider(meta.video.provider), …)`,
   assigns `rawReleases`, and persists the new etag. The shared post-dispatch
   `ingestRawReleases` (marketing classifier + insert + side-effects) runs
   unchanged.
2. **Fetch-phase `fetchable` filter** (`poll-fetch.ts:~192`) — add a `video`
   case returning `true` when `feedUrl` is present (mirrors the `appstore`/feed
   cases).
3. **`POST /v1/sources/:slug/fetch`** eligibility (`routes/sources.ts:~601`) —
   add `isVideoFetched(src)` to the server-side-fetch condition.

### 4. Creation

`POST /v1/sources/video` convenience endpoint (mirrors `POST /v1/sources/appstore`
at `workers/api/src/routes/sources.ts:~2201`):

- Input: a channel/playlist URL + org scoping (`orgId` or `orgSlug`, required
  per #690) + optional `productId`.
- Resolves provider via the registry → `feedUrl`, `canonicalUrl`, channel
  identity. Sets `source.url` to the **human** channel/playlist URL;
  `metadata.feedUrl` / `feedType` to the Atom endpoint; `metadata.video =
{ provider, channel }`; `metadata.marketingFilter = true` (see §6) with a
  `marketingFilterHint`.
- Mints the source and runs an initial fetch.
- CLI surface (`releases admin source create-video`) lives out-of-tree in the
  OSS CLI as a follow-up, mirroring `create-appstore` (cli#247).

### 5. Ingest → release

Each entry becomes a `RawRelease`:

```ts
{
  title,                       // video title
  content: body,               // media:description
  url: watchUrl,               // https://www.youtube.com/watch?v=<id> (dedup key)
  publishedAt,                 // <published>
  media: [{ type: "image", url: thumbnailUrl, alt: title }],
  type: "feature",
}
```

- Dedup is the standard `UNIQUE(source_id, url)` upsert on the `watch?v=` URL.
- **Summarizer:** the existing release-content Haiku pass
  (`packages/ai/src/release-content.ts`) generates `title_generated` /
  `title_short` / `summary` at ingest when the org has content generation on —
  exactly the cleanup thin descriptions need. Honors the existing per-source
  `metadata.summarize` and org-level flag.
- **`contentFromSummary` is intentionally NOT set on video releases.** That flag
  keys the HTML-page feed-enrich path (`assessFeedDepth` → fetch the linked
  page), which for video would mean fetching JS-heavy YouTube watch pages — the
  wrong enrichment. A creator's description is the genuine content, not a
  truncated summary of a fetchable page. The future transcript-enrichment path
  is a separate mechanism (its own `metadata.video` flag), not this one.

### 6. Marketing filter (default-on for video)

Video sources default to `metadata.marketingFilter = true` with a
`marketingFilterHint` such as: _"Suppress customer case studies, customer
testimonials, event recaps, and partner spotlights; keep first-party product
launches and feature announcements."_

`fetchOne` already runs newly-parsed items through `classifyMarketing`
(Haiku 4.5, `@releases/ai-internal/marketing-classifier`) when the flag is set,
inserting flagged items with `suppressed = true` and
`suppressedReason = "marketing_classifier:<slug>"` (slugs include `case_study`,
`event_recap`, `partner_announcement`). This is what suppresses the Notion
case-study video. Fail-open on any classifier error; capped at 20 items/fire.
The flag is per-source metadata, so an operator can tune it off.

### 7. Presentation

A generic, thumbnail-forward `VideoReleaseRow` keyed off `type = 'video'`:

- Thumbnail (16:9), title, a "Watch on {provider}" affordance, optional
  published date / view count. **No emoji** (web UI convention).
- New wire facet `video?: { provider; thumbnailUrl; watchUrl }` added to the
  release item shapes in `@buildinternet/releases-api-types`, mirroring how
  `appStore` was added to `OrgReleaseItem` + `ReleaseDetail` (#1204).
- The facet is produced by the shared `buildReleaseHits` so **both** the API
  worker and the MCP worker carry it (MCP reads query D1 directly — the
  three-query-layer rule: API SQL, MCP SQL, shared builder).
- Rollout follows the App Store shape: org feed + release detail first; spread
  to search card / ticker / rollup row later (the #1206-style pass).

## Data flow

```
create:  channel/playlist URL
           → provider.resolveFeed → { feedUrl, canonicalUrl, channel }
           → source row (type=video, metadata.{feedUrl, feedType, video:{provider,channel}, marketingFilter})
           → initial fetch

poll:    queryDueSources (type=video due?) → pollOne (ETag conditional GET on feedUrl)
           → changed? → fetchOne

fetch:   fetchOne video branch
           → fetchAndParseVideoFeed (feed-style transport + provider.parseFeed)
           → RawRelease[] (title, description body, watch URL, thumbnail)
           → marketing classify (suppress case studies)
           → upsert (UNIQUE(source_id, url))
           → release-content Haiku (title/summary cleanup) for visible rows
           → embed (waitUntil)

read:    releasesVisible → buildReleaseHits attaches `video` facet
           → API + MCP → VideoReleaseRow
```

## Error handling

- **URL resolution failure** at create time (unrecognized provider, `@handle`
  page that yields no feed link) → `400 bad_request` with a clear message; no
  source minted.
- **Feed fetch / parse failure** during polling → standard feed error handling:
  `consecutiveErrors` backoff (1h–72h), `fetch_log` error row. No new path.
- **Missing `media:thumbnail`** → `media: []`; the row renders without a poster
  (still a valid release).
- **Marketing classifier error** → fail-open, item inserted visibly (existing
  behavior).
- **Summarizer error / org flag off** → release stored with raw title +
  description (existing behavior).

## Testing

- **Unit (adapters):** YouTube `resolveFeed` for playlist / channel / `@handle`
  inputs; `parseFeed` pulling watch URL / `media:thumbnail` /
  `media:description` from a captured YouTube Atom fixture.
- **Unit (adapters):** `fetchAndParseVideoFeed` maps a fixture feed → correct
  `RawRelease[]` (incl. single-entry object-not-array and missing-`media:group`
  cases); 304 → empty; non-ok → throw.
- **Worker (in-process smoke, per `reference_worker_route_inprocess_smoke`):**
  `fetchOne` video branch dispatch; ETag conditional-GET no-change path;
  case-study fixture suppressed by the marketing classifier.
- **Schema:** marker migration present so the schema-pairing CI gate passes.
- **Gates:** `bun test` (root + workers) and per-worker `tsc --noEmit`.

## Out of scope (fast-follows)

1. **Transcript / caption enrichment** — the rich-body path. Needs a spike for a
   caption source workable from a Worker (no official no-auth endpoint; YouTube
   `timedtext` is unofficial/rate-limited; Data API caption download needs
   OAuth). It will be gated by its own `metadata.video` flag — deliberately NOT
   the `contentFromSummary` / feed-enrich mechanism, which fetches HTML pages.
2. **Coverage auto-linking** — the deferred half of "Both": a conservative
   same-org + same-day (± window) + title-similarity pass that writes
   `release_coverage` so the rare duplicate (Cowork, Managed Agents) collapses.
   Touches coverage read-paths; data shows it fires ~2/14, always same-day.
3. **Vimeo / Wistia providers** — the registry accepts them; only YouTube ships.
4. **Presentation spread** — extend `VideoReleaseRow` beyond org feed + release
   detail to search card / ticker / rollup (the #1206-style pass).
5. **CLI `create-video`** — out-of-tree OSS CLI follow-up.

```

```
