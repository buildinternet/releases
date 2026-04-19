# Feed Change Detection

Lightweight, non-AI change detection for feed sources using HTTP HEAD requests. Flags sources that have upstream changes available so that expensive fetch/parse operations can be batched separately.

## Context

We have 15+ feed sources (RSS, Atom, JSON Feed) that we poll for updates. Currently, every check requires a full GET + parse cycle. Most feeds don't change between checks. HEAD requests let us detect changes using only HTTP headers (ETag, Last-Modified, Content-Length) without downloading or parsing feed content.

WebSub/PubSubHubbub adoption in our source set is zero (verified across all 15 feeds), so polling with smart change detection is the primary strategy.

## Design

### Core function: `headCheckFeed()`

Location: `src/adapters/feed.ts`

```typescript
type ChangeStatus = "changed" | "unchanged" | "unknown";

async function headCheckFeed(
  feedUrl: string,
  stored: { etag?: string; lastModified?: string; contentLength?: string },
): Promise<{ status: ChangeStatus; etag?: string; lastModified?: string; contentLength?: string }>;
```

Sends an HTTP HEAD request. Compares response headers against stored values:

1. If server returns `ETag` and it differs from stored `feedEtag` → `"changed"`
2. If server returns `Last-Modified` and it differs from stored `feedLastModified` → `"changed"`
3. If server returns `Content-Length` and it differs from stored `feedContentLength` → `"changed"`
4. If all present headers match stored values → `"unchanged"`
5. If server returns none of these headers → `"unknown"` (can't determine, must fall through to GET)

Returns the current header values alongside the status so callers can persist them.

### Schema addition

New field in `SourceMetadata` (JSON column, no migration needed):

- `feedContentLength?: string` — stored alongside existing `feedEtag` and `feedLastModified`

New column on `sources` table:

- `changeDetectedAt` (text, nullable) — ISO timestamp set when HEAD detects a change, cleared when a full fetch completes

This requires a migration for the `sources` table column.

### CLI command: `released check`

New command that runs HEAD checks across feed sources.

```bash
released check                    # Check all feed sources
released check <slug>             # Check a single source
released check --org vercel       # Check all sources for an org
released check --product nextjs   # Check all sources for a product
released check --json             # Machine-readable output
```

Behavior:

- Queries sources that have a `feedUrl` in metadata
- Runs `headCheckFeed()` against each (concurrency-limited)
- For `"changed"` results: sets `changeDetectedAt` to current timestamp
- For `"unchanged"` results: no-op (preserves existing `changeDetectedAt` if set)
- For `"unknown"` results: sets `changeDetectedAt` (conservative — treat as potentially changed)
- Reports summary: N checked, N changed, N unchanged, N unknown

Table output example:

```
Source               Status      Last Fetched
cloudflare-changelog changed     2h ago
linear               unchanged   45m ago
sentry-changelog     changed     6h ago
stripe-changelog     unknown     1d ago

4 checked: 2 changed, 1 unchanged, 1 unknown
```

### Fetch pre-filter integration

In the existing `fetch --stale` flow, add a HEAD pre-check before the full GET+parse:

- In `fetchViaFeed()`, after conditional headers are prepared and before calling `fetchAndParseFeed()`
- Skip HEAD if this is the first fetch (no stored header values)
- Skip HEAD if `options?.full` is true
- If HEAD returns `"unchanged"` → return empty releases (same as 304 path), clear `changeDetectedAt`
- If HEAD returns `"changed"` or `"unknown"` → proceed to full GET as today
- On successful full fetch → clear `changeDetectedAt`

### What this does NOT do

- No content inspection or heuristics
- No AI involvement
- No feed parsing
- No release creation or update
- Does not replace the existing conditional GET (ETag/If-None-Match) — that still runs on full fetches as a second layer of dedup

## Files to create/modify

- `src/adapters/feed.ts` — Add `headCheckFeed()`, integrate into `fetchViaFeed()`
- `src/db/schema.ts` — Add `changeDetectedAt` column to sources
- `src/db/queries.ts` — Add query helpers for changeDetectedAt (set/clear, list changed sources)
- `src/cli/commands/check.ts` — New CLI command
- `src/cli/index.ts` — Register check command
- D1 migration for `changeDetectedAt` column
