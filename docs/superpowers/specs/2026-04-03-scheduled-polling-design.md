# Scheduled Polling Design

Automated poll-and-fetch pipeline using a Cloudflare Worker cron trigger, with per-source frequency control via the existing `fetchPriority` column.

## Context

The `released poll` command detects upstream feed changes via HEAD requests, and `released fetch --changed` acts on those detections. Currently both are manual CLI invocations. This design automates the pipeline: a Worker cron polls sources on a tier-based schedule and fetches changed feed/GitHub sources directly, without needing the CLI or agent.

## Tier-Based Poll Intervals

The existing `fetchPriority` column (`normal`, `low`, `paused`) maps to poll frequency:

| `fetchPriority` | Poll interval | Use case |
|---|---|---|
| `normal` | 4 hours | Active sources, reasonable freshness |
| `low` | 24 hours | Slow-moving changelogs |
| `paused` | never | Explicitly excluded from all automated activity |

The cron trigger fires every hour. Each run queries for sources whose `lastPolledAt` is null or older than their tier's interval. Most hourly runs will only touch a handful of sources.

If finer granularity is needed later (e.g., a `high` tier at 1h), the enum can be extended without changing the scheduling infrastructure.

## Schema Addition

New column on `sources` table:

- `lastPolledAt` (text, nullable) — ISO timestamp updated after each HEAD check, regardless of result. Used to determine when a source is next due for polling.

Requires a local migration and a D1 migration.

## Cron Handler

The API Worker gets a `scheduled` event handler in `workers/api/src/index.ts`. The handler delegates to a `pollAndFetch()` function in a new `workers/api/src/cron/poll-fetch.ts` module.

### Poll Phase

1. Query D1 for sources where:
   - `fetchPriority` is not `paused`
   - Source has a feed URL in metadata (`json_extract(metadata, '$.feedUrl') IS NOT NULL`)
   - `lastPolledAt` is null OR `lastPolledAt < (now - tier_interval)`
   - Source is not disabled (`isHidden = 0 OR isHidden IS NULL`)
2. For each due source (concurrency-limited to 5):
   - Send HEAD request to feed URL
   - Compare ETag, Last-Modified, Content-Length against stored values
   - Update `lastPolledAt` to now
   - Update stored header values in metadata
   - If changed or unknown: set `changeDetectedAt`

This reuses the existing `headCheckFeed()` function from `src/adapters/feed.ts`.

### Fetch Phase

After polling, sources with `changeDetectedAt` set are processed based on type:

**Feed sources** — The Worker imports the feed adapter (`src/adapters/feed.ts`) and runs `fetchViaFeed()` directly against D1. This is a lightweight operation: HTTP GET, XML/JSON parse, DB insert. No AI, no browser rendering, no external process. On successful fetch:
- Insert new releases via Drizzle
- Clear `changeDetectedAt`
- Update `lastFetchedAt`, reset backoff counters

**GitHub sources** — Same as feed sources. The GitHub releases API returns structured JSON that the existing adapter handles without AI.

**Scrape/agent sources** — Only `changeDetectedAt` is set. These require Cloudflare Browser Rendering or the agent and are left for `released fetch --changed` (CLI) or a future dispatch mechanism. The cron does not attempt to fetch these.

### Error Handling

- HEAD check failures: set `lastPolledAt` (don't re-poll too soon), log, continue to next source
- Fetch failures: increment `consecutiveErrors`, set `nextFetchAfter` backoff, log, continue
- The cron handler must not throw — individual source errors are caught and logged

### Concurrency

- Poll phase: up to 5 concurrent HEAD requests
- Fetch phase: up to 3 concurrent feed fetches (D1 write pressure is the constraint)

## Worker Configuration

In `workers/api/wrangler.jsonc`, add a cron trigger:

```jsonc
"triggers": {
  "crons": ["0 * * * *"]  // every hour, on the hour
}
```

No new bindings needed — the Worker already has D1 (`DB`) and the Drizzle schema.

## File Map

| File | Action | Responsibility |
|---|---|---|
| `src/db/schema.ts` | Modify | Add `lastPolledAt` column to `sources` table |
| `src/db/migrations/0003_*.sql` | Create | Local migration for `lastPolledAt` |
| `workers/api/migrations/0003_add_last_polled_at.sql` | Create | D1 migration for `lastPolledAt` |
| `workers/api/src/cron/poll-fetch.ts` | Create | Cron handler: poll due sources, fetch changed feeds |
| `workers/api/src/index.ts` | Modify | Register `scheduled` event handler |
| `workers/api/wrangler.jsonc` | Modify | Add cron trigger |
| `src/db/queries.ts` | Modify | Add `listDueSources()` and `updateLastPolledAt()` helpers |

## What This Does NOT Do

- No AI or content enrichment — purely mechanical fetch+parse+insert
- No scrape source fetching — those stay with the CLI/agent
- No summary generation — that remains in the CLI fetch flow
- No media upload to R2 — feed releases rarely have media; if needed later, it can be added
- No session tracking via StatusHub — the cron is internal, not user-facing
