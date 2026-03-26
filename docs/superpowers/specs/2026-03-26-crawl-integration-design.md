# Cloudflare Crawl Endpoint Integration

## Problem

The scrape adapter fetches a single page via Cloudflare's `/markdown` endpoint. Many changelogs are structured as index pages linking to individual release posts — the adapter only captures the index, missing the actual content. The Cloudflare `/crawl` endpoint can follow those links and return markdown for each sub-page, giving us full release content.

## Design

### CLI Interface

New flags on the `fetch` command:

- `--crawl` — enables crawl mode for the target source(s). Persists `crawlEnabled: true` in `source.metadata` so future fetches automatically crawl. Only valid for `scrape` sources; when run without a slug, persists only on `scrape` sources and logs a per-source warning for `github`/`feed` types encountered.
- `--no-crawl` — one-off override to force single-page mode for a specific invocation. Does **not** clear the persisted `crawlEnabled` setting.
- `--crawl-pattern <glob>` — optional URL pattern for scoping the crawl (e.g., `https://example.com/changelog/*`). If omitted, auto-derived from the source URL by appending `/**`. Persisted in `source.metadata` alongside `crawlEnabled`.

### Fetch Cascade (scrape adapter)

When crawl mode is enabled, the scrape adapter's fetch order changes:

1. **Feed** — skipped when `crawlEnabled` (user explicitly wants sub-pages)
2. **Crawl** — use `/crawl` endpoint, parse each page individually
3. **Single-page fallback** — if crawl job errors (not timeout), fall through to existing `/markdown` → AI path

When crawl mode is **not** enabled, the existing cascade is unchanged: feed → single-page → AI.

### Crawl Flow

New file: `src/adapters/crawl.ts`

**`startCrawl(url, options)`**
- POST to `https://api.cloudflare.com/client/v4/accounts/{id}/browser-rendering/crawl`
- Request body:
  - `url`: source URL
  - `formats: ["markdown"]`
  - `limit`: from `FetchOptions.maxEntries` (omitted when `--all` is used, letting the API default apply)
  - `options.includePatterns`: from `crawlPattern` in source metadata
  - `modifiedSince`: unix timestamp from `source.metadata.lastCrawlAt` (see Incremental Fetching). Omitted when null (first crawl fetches everything).
  - `rejectResourceTypes: ["image", "media", "font", "stylesheet"]` (reduce browser time)
- Returns: job ID string from `response.result`

**`pollCrawlResults(jobId)`**
- GET `https://api.cloudflare.com/client/v4/accounts/{id}/browser-rendering/crawl/{jobId}`
- Polls at 2-second intervals
- Terminates when response body `result.status` is a terminal state: `completed`, `errored`, `cancelled_due_to_timeout`, `cancelled_due_to_limits`, or `cancelled_by_user`
- Timeout: 5 minutes client-side (throws `CrawlTimeoutError`)
- Filters `result.records` to only those with `record.status === "completed"` and non-empty `record.markdown`
- Returns: array of `{ url: string, markdown: string, title?: string }` (title extracted from `record.metadata.title`)
- Throws on client-side timeout. For job-level errors (`errored`, `cancelled_*`), throws `CrawlJobError` with the status.

**`parseCrawlResults(pages, sourceSlug, options)`**
- Runs `parseChangelog()` per page in parallel (concurrency limit: 5)
- Maps the crawl page URL onto each resulting `RawRelease.url`
- Applies `FetchOptions.since` and `FetchOptions.maxEntries` after aggregation
- Skips individual pages where `parseChangelog` throws (logs warning, continues)
- Returns: `RawRelease[]`

### Scrape Adapter Integration

In `src/adapters/scrape.ts`, the crawl path is inserted between feed and single-page:

```
async fetch(source, options):
  meta = getSourceMeta(source)
  crawlActive = (options.crawl === true) or (options.crawl !== false and meta.crawlEnabled)

  if crawlActive:
    try:
      jobId = startCrawl(source.url, { pattern, limit, modifiedSince })
      pages = pollCrawlResults(jobId)
      releases = parseCrawlResults(pages, source.slug, options)
      updateSourceMeta(source, { lastCrawlJobId: jobId, lastCrawlAt: now })
      return releases
    catch CrawlTimeoutError:
      log warning, return []  // timeout = no results, don't fall back
    catch CrawlJobError:
      log warning             // job failed, fall through to single-page

  // Existing cascade: feed → single-page → AI
  // Note: lastContentHash dedup is cleared when crawl mode is first enabled
  // to prevent stale hashes from suppressing the single-page fallback.
  ...
```

### Metadata Schema

Rename `FeedMetadata` → `SourceMetadata` in `src/adapters/feed.ts` and extend with crawl fields:

```ts
export interface SourceMetadata {
  // Feed fields (existing)
  feedUrl?: string;
  feedType?: "rss" | "atom" | "jsonfeed";
  feedDiscoveredAt?: string;
  feedEtag?: string;
  feedLastModified?: string;
  noFeedFound?: boolean;

  // Crawl fields (new)
  crawlEnabled?: boolean;
  crawlPattern?: string;     // e.g., "https://linear.app/changelog/**"
  lastCrawlJobId?: string;   // for debugging/status
  lastCrawlAt?: string;      // ISO timestamp, used for modifiedSince
}
```

Rename helpers accordingly: `getSourceFeedMeta` → `getSourceMeta`, `updateSourceFeedMeta` → `updateSourceMeta`. Update all call sites.

### FetchOptions Extension

Add a `crawl` override to `FetchOptions` in `src/adapters/types.ts`:

```ts
interface FetchOptions {
  since?: Date;
  maxEntries?: number;
  crawl?: boolean;     // --crawl (true) / --no-crawl (false) / unset (use persisted)
}
```

The adapter checks `options.crawl` first (explicit override), then falls back to `metadata.crawlEnabled` (persisted setting).

### Error Handling

- **Crawl timeout** (5 min client-side) → log warning, return empty array. Does not fall back to single-page — a timeout likely means the site is slow/large and single-page wouldn't help.
- **Crawl job error/cancellation** → log warning, fall through to single-page scrape path. The job failed before producing results, so it's worth trying the simpler approach.
- **Individual page parse failure** → log warning, skip that page, continue with others. One bad page shouldn't block the rest.
- **Missing Cloudflare credentials** → same existing `AdapterError` as single-page path.

### Incremental Fetching

The `/crawl` endpoint supports `modifiedSince` (unix timestamp).

- Use `source.metadata.lastCrawlAt` (not `source.lastFetchedAt`) as the reference timestamp. This avoids the stale-timestamp problem when switching from single-page to crawl mode — `lastFetchedAt` reflects the last single-page scrape, not the last crawl.
- On first crawl (`lastCrawlAt` is null), omit `modifiedSince` entirely to fetch all pages.
- After a successful crawl, persist `lastCrawlAt` in metadata.

### Enabling Crawl Mode

When `--crawl` is first passed for a source:
1. Persist `crawlEnabled: true` and `crawlPattern` in metadata
2. Clear `source.lastContentHash` to null — this prevents a stale hash from suppressing the single-page fallback if crawl later fails

## Deferred

- **Background/async crawl mode**: fire-and-forget with `released fetch --crawl-results` to retrieve. Will be needed when crawl limits or page counts grow. Code should be structured to make this transition straightforward — the separate `startCrawl`/`pollCrawlResults`/`parseCrawlResults` functions are designed with this split in mind.
- **Auto-detection of multi-page changelogs**: heuristics to detect index pages (short entries, high link density, low content density) and automatically enable crawl mode. Requires analysis of scrape results to implement well.
- **Crawl via MCP tool**: exposing crawl as an MCP tool parameter. Depends on the async story since MCP calls should be responsive.
- **Crawl for `feed` sources**: feeds already provide structured per-release data; crawl would only help if feed content is truncated. Low priority.

## Files to Create/Modify

- **New**: `src/adapters/crawl.ts` — crawl start, poll, parse orchestration
- **Modify**: `src/adapters/feed.ts` — rename `FeedMetadata` → `SourceMetadata`, rename helpers
- **Modify**: `src/adapters/scrape.ts` — insert crawl path between feed and single-page
- **Modify**: `src/adapters/types.ts` — add `crawl` to `FetchOptions`
- **Modify**: `src/cli/commands/fetch.ts` — add `--crawl`, `--no-crawl`, `--crawl-pattern` flags, persist metadata on first use
- **Modify**: `README.md` — document crawl flags
- **Modify**: `CLAUDE.md` — note crawl mode in conventions
