# Fetch log pagination and accurate counts

**Date:** 2026-04-19
**Status:** Draft

## Problem

The status page fetch-log tab (`web/src/app/status/dashboard.tsx`) fetches at most 200 rows via `GET /v1/status/fetch-log?after=<date>`. The UI's pagination controls and status-filter pills operate client-side over that 200-row window. Two consequences:

1. A "Week" filter at current ingest volumes covers thousands of fetches — the user only ever sees the most recent 200.
2. Filter pills (`Errors 3`, `No change 42`) report counts over the loaded 200, which is misleading — "42 errors this week" may really mean "42 errors among the last 200 fetches, whatever time window those covered."

There is no way to paginate past the cap and no signal for the true shape of the dataset.

The org-scoped view (`web/src/components/org-fetch-log-view.tsx`), which uses the separate `GET /v1/fetch-log?source=...&limit=20` endpoint, has the same structural problem.

## Goals

- User can walk backwards through the full set of fetch-log entries within the active date range.
- Filter-pill counts and the header total reflect the real number of entries in the date range, not what's loaded.
- Fetching and re-filtering stay fast on D1 at the current row volumes.
- The live-tail behavior (new fetches stream in via WebSocket) continues to work.

## Non-goals

- Changing the CLI's `admin source fetch-log` command. It talks to the database directly via drizzle and is unaffected.
- Exporting logs (CSV / JSON download).
- Source-slug search within the dashboard.

## Design

### UX

Load-more button replaces the current Prev/Next controls. Fetch logs are a time-ordered stream that users almost always scan backwards in time; a load-more pattern matches that mental model, keeps existing rows in place as new entries stream in via WebSocket, and avoids the reshuffling artifacts of numbered pagination under live updates.

Header above the list:

```
Showing 75 of 1,842 entries          [ Load 25 more ]
```

When a status filter is active, the visible total is `statusCounts[status]` from the latest count-bearing response:

```
Showing 30 of 42 errors               [ Load 25 more ]
```

Status filter pills render counts from the server's `statusCounts` rollup, so `Errors 42` means 42 errors in the current date range — not 42 in whatever happened to be loaded.

### API changes

**`GET /v1/status/fetch-log`** — response shape changes from a bare array to:

```jsonc
{
  "entries": [ /* existing row shape, unchanged */ ],
  "nextCursor": "2026-04-18T21:12:04.001Z|fl_abc123",  // null when no more pages
  "totalCount": 1842,                                    // omitted on cursor pages
  "statusCounts": {                                      // omitted on cursor pages
    "success": 1720,
    "error": 42,
    "no_change": 60,
    "dry_run": 20
  }
}
```

New query parameters:

- `status` — one of `success | error | no_change | dry_run`. Filters `entries`. Does **not** filter `totalCount` or `statusCounts` — those always reflect the date-range-and-org scope so the pill badges stay accurate.
- `cursor` — opaque base64url of `<createdAt>|<id>`. When present, server skips the count queries and omits `totalCount` / `statusCounts` from the response.
- `limit` — defaults to 25, max 100.

Existing parameters (`after`, `before`, `org`) are unchanged.

**`GET /v1/fetch-log`** (source/org-scoped, used by org pages) — same envelope and parameter additions. Default `limit` raised from 20 to 25 for consistency.

**Backwards compatibility:** both endpoints are consumed only by the in-repo Next.js app. Clean break on response shape — no versioning.

### Data and queries

Sort key is `(createdAt DESC, id DESC)`. `id` is the tiebreaker so batch inserts that share a millisecond get a deterministic order.

Page predicate when `cursor` is present:

```sql
WHERE (createdAt, id) < (:cursorCreatedAt, :cursorId)
  AND <date range + org predicates>
  AND <optional status predicate>
```

Count queries (run only when `cursor` is absent):

```sql
-- totalCount: respects date + org, ignores status filter
SELECT count(*) FROM fetch_log
LEFT JOIN sources ON fetch_log.source_id = sources.id
LEFT JOIN organizations ON sources.org_id = organizations.id
WHERE <date + org predicates>;

-- statusCounts: same scope, grouped
SELECT status, count(*) FROM fetch_log
LEFT JOIN sources ON fetch_log.source_id = sources.id
LEFT JOIN organizations ON sources.org_id = organizations.id
WHERE <date + org predicates>
GROUP BY status;
```

`statusCounts` is padded server-side to always include all four statuses (zero for any missing) so the client doesn't have to backfill defaults.

**Indexes:** `idx_fetch_log_created_at` already exists. `(createdAt, id)` tiebreak uses the PK; no new migration.

**Cost:** week-scoped count is a low-thousands scan — safe on D1. Skipping counts on cursor pages means load-more is a single SELECT.

### UI changes

**Status dashboard (`web/src/app/status/dashboard.tsx`):**

- New `useFetchLog` hook returns `{ entries, totalCount, statusCounts, loadMore, hasMore, loading, reset }`.
- `FetchLogTable` rewrites around the hook. The `fetchLogPage` / `perPage` state and the client-side `filter` state are removed.
- Filter pills are server-driven: clicking one calls `reset()` with the new `status` param.
- WebSocket `fetch:complete` handler continues to prepend new rows into `entries` and bumps `totalCount` plus the relevant `statusCounts` bucket optimistically, so the header stays honest without a refetch.

**Org-scoped view (`web/src/components/org-fetch-log-view.tsx`):** same hook, same load-more pattern, same filter accuracy fix.

### Edge cases

- **Live entry arrives under an active status filter that doesn't match:** bump `statusCounts` for that entry's status, leave `entries` untouched.
- **Date range change:** full `reset()` — new cursor chain, new counts.
- **Stale or undecodable cursor:** server ignores the cursor and returns the first page. The client treats this as a fresh page; no dedicated error state. Low probability given the short browsing session lifetime.
- **Empty results under a filter:** load-more hidden, header reads `0 errors this week` or equivalent.

## Testing

Integration tests in `tests/integration/fetch-log.test.ts`:

- Response envelope shape: `{ entries, nextCursor, totalCount, statusCounts }`.
- Cursor pagination: following `nextCursor` returns the next chunk; `nextCursor` is `null` on the final page.
- `status` filter narrows `entries` but `totalCount` and `statusCounts` still reflect the full date-range scope.
- Cursor requests omit `totalCount` and `statusCounts`.
- `totalCount` matches an independent `SELECT count(*)` over the same scope.

Web UI: manual smoke on the seeded multi-page dataset. No automated dashboard-component tests in this repo.

## Rollout

Single PR. Worker + web ship together — no external consumers of the old array shape.

1. Worker changes (`workers/api/src/routes/status.ts`, `workers/api/src/routes/fetch-log.ts`).
2. Web changes (status dashboard, org fetch-log view, shared hook).
3. Integration tests.
4. Deploy: GH Actions auto-deploys the worker on merge to main; Vercel auto-deploys the web app.

## Out of scope

- CLI changes (`admin source fetch-log`).
- Log export.
- Dashboard search over source slug.
