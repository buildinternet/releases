# 352 — `/live` page: web consumer of the release event bus

## Problem

The release event bus (`ReleaseHub` DO + `GET /v1/releases/stream`) has one consumer today (the CLI's `releases tail -f`) and a second on the way (webhooks, #343). Before webhook delivery lands, we want a frontend consumer that validates the WebSocket payload and reconnect behavior from a browser client, and that is genuinely useful on its own as the first real-time surface on releases.sh.

Tracking issue: https://github.com/buildinternet/releases/issues/352.

## Goal

Ship a minimal `/live` page that:

1. Subscribes to `/v1/releases/stream` and renders new releases as they arrive.
2. Falls back to polling `/v1/releases/latest` when the WebSocket is unhealthy.
3. Is reachable at `https://releases.sh/live` but not linked from nav, sitemap, or search — "unlisted but accessible."

Non-goals (explicitly out of scope per #352): filtering UI, persistent history beyond the tab's memory, SEO polish, mobile-tuned layout.

## Architecture

### Routes and files

- `web/src/app/live/page.tsx` — server component. Renders `<Header />` and a single client island `<LiveStream apiUrl={...} />`. Metadata sets `robots: { index: false, follow: false }` so accidental discovery doesn't get indexed.
- `web/src/app/live/live-stream.tsx` — `"use client"` island. Owns UI state (list of events, connection indicator). Consumes the new hook. ~100 LOC.
- `web/src/hooks/use-release-stream.ts` — new hook (first file in `web/src/hooks/`). Owns the WebSocket lifecycle, cursor tracking, reconnect backoff, and polling fallback. Returns `{ events, connected, mode }`.

No changes to sitemap.ts or robots.ts. `/live` is simply absent from both.

### Data flow

```
  releases.sh/live (page.tsx, RSC)
         │
         │ passes RELEASED_API_URL
         ▼
  <LiveStream apiUrl> (client)
         │
         │ useReleaseStream(apiUrl)
         ▼
  hook state machine
    ├── WebSocket: wss://<api>/v1/releases/stream[?since=<seq>]
    │     ├── onmessage "ready"      → store seq (head)
    │     ├── onmessage "release.created" → push to events, update seq
    │     └── onmessage "snapshot_gap"    → REST-backfill, resubscribe with new head
    └── Fallback: GET /v1/releases/latest?count=10, every 15s, while WS closed
```

When the WS opens cleanly, polling is off. When the WS closes (any reason other than a deliberate teardown), the hook immediately triggers a polling tick, then keeps polling on the 15s interval until a reconnect succeeds. Reconnect uses exponential backoff (1s → 2s → 4s → … capped at 30s), identical to `dashboard.tsx`.

### Normalized event shape

The hook hands the UI a single normalized type so the view doesn't branch on source:

```ts
type LiveRelease = {
  id: string; // rel_...
  title: string | null; // from event.release.title or REST .title
  version: string | null;
  publishedAt: string; // ISO
  source: { slug: string; name: string };
  url?: string; // only set from REST path; WS payload omits
};
```

WS path populates this from `event.release.{id,title,version,publishedAt,sourceName,sourceSlug}`.
REST path populates from `latest[i].{id,title,version,publishedAt,source.{slug,name},url}`.

Dedup is keyed on `id`. The in-memory buffer is capped at 100 items (newest first); older items drop off.

### Cursor + backfill

- On initial connect the hook opens `/v1/releases/stream` without `since`. The server's first frame is `{ "type": "ready", "seq": <head> }`; the hook stores that as `lastSeq`.
- On every subsequent reconnect, the hook appends `?since=<lastSeq>` so the server replays events with `seq > lastSeq` from the 1000-event ring buffer.
- If the server emits `{ "type": "snapshot_gap", ... }`, the hook:
  1. Hits `/v1/releases/latest?count=10` once and merges items the UI hasn't seen.
  2. Drops `lastSeq` so the next reconnect is a fresh subscribe (server's next `ready` reseeds).
- If `?since=` replay returns gaps we didn't notice (shouldn't happen within the 1000-event buffer at ~10 rel/hr), we're covered by the periodic `latest` top-up polling path.

### Connection lifecycle

- Open on mount.
- Pause when `document.hidden` (page backgrounded): close WS, stop polling, resume on visibility change. Same `visibilitychange` listener shape as `dashboard.tsx`.
- Unmount cleanly tears down the WS, the reconnect timer, and the poll timer.

## UI

Layout: `<Header />` + a single centered column (`max-w-3xl`), matching the other detail pages on the site.

Top of column — a thin status line:

- ✅ Live: small pulsing green dot + "Live" when the WS is open.
- 🔄 Reconnecting: yellow dot + "Reconnecting…" when WS is closed but mount is still active.
- 📡 Polling: muted gray dot + "Polling (WebSocket unavailable)" once the fallback has taken over for more than one poll cycle.

Body — list of release cards, newest first, capped at 100:

- Source name linked to `/[orgSlug]/[sourceSlug]` (the source slug is enough; the org slug comes from the REST shape; for WS-only events we don't have org, so we resolve lazily — see open question below).
- Version (or title if no version), using the same typographic treatment as `release-item.tsx`.
- `<LocalTimestamp>` for relative time.

Empty state (no events seen yet): muted "Waiting for the next release…" line.

### Open question on org slug (WS events)

`/v1/releases/stream` event payload contains `sourceSlug` and `sourceName` but not `orgSlug`, so we can't build a full `/[orgSlug]/[sourceSlug]` link from a WS event alone. Two options:

1. **Link to `/source/[sourceSlug]`** if that route exists (inspection pending) — no org lookup needed.
2. **Extend the stream payload** to include `orgSlug`. Small additive change to `publish.ts`.

Decision: **Option 1**. We already have `/source/[sourceSlug]` and `/[orgSlug]/[sourceSlug]` as valid routes; linking to `/source/...` keeps `/live` frontend-only per the issue's "no schema, no bindings, no API changes" framing. Revisit if the source-slug route turns out not to handle this cleanly; in that case fall back to option 2.

## Error handling

- WebSocket errors (connection failed, protocol error): treat as close; reconnect loop kicks in.
- Polling errors: swallow, the next 15s tick retries.
- `snapshot_gap`: handled above.
- Malformed event JSON: log to console and skip; do not crash the UI.

## Testing

This is frontend-only with live backend dependencies, so testing is light and manual-forward:

- **Unit** (`bun test` via existing Next test rig if present; otherwise skip): a pure reducer function inside the hook that takes `(state, action)` where `action` is `{ type: "ws-event" | "rest-batch" | "reset" }`. This lets us test dedup, cap-at-100, and seq tracking without a DOM or real WebSocket.
- **Manual verification on dev** (the "done when" from #352):
  1. Open `/live`. Confirm the status line shows "Live" within a second of load.
  2. Trigger a fetch (`releases source fetch <slug>` or the admin manual fetch endpoint) and watch a new card appear without reload.
  3. In devtools, `WebSocket`-filter the Network panel and close the socket. Watch the status flip to "Reconnecting…" and then "Polling" after ~2s. Confirm new releases still show up on the 15s cadence.
  4. Reopen connectivity (e.g., switch off airplane mode in the devtools "Throttling" menu) — status returns to "Live" and polling stops.

## Rollout

- Ship on `main` directly after review. No flag — the route is unlinked and adds no cost to existing pages.
- No wrangler, env, or D1 changes.
- Deploy is automatic on merge (Vercel).

## Risks

- **Rate limiting**: `/v1/releases/stream` currently falls under `publicRateLimitMiddleware` (120/min/IP), but `RATE_LIMIT_ENABLED` is off in prod today. If that flag ever flips, `/live` tabs and CLI tails contend for the same budget. Noted in `docs/architecture/events.md`; no action here beyond awareness.
- **Event schema drift**: the hook hard-codes the `release.created` shape. If the payload gains required fields in the future, the hook silently drops them on render but doesn't break. If field renames happen, we need a coordinated ship with the bus — same risk the CLI already carries.
- **100-item cap**: a release flood (rare, but possible during a batch ingest of a long-tail source) could push interesting events off the visible list before the user sees them. Acceptable for v1 — the page is a live ticker, not an archive, per the issue.

## Decision summary

- Unlisted = no nav link + no sitemap entry + `noindex` meta. Not hidden behind a feature flag.
- Hook lives at `web/src/hooks/use-release-stream.ts` (new directory, first file).
- Polling fallback: `/v1/releases/latest?count=10`, 15s interval, on while WS is closed, off while WS is open.
- WS event link target: `/source/[sourceSlug]` to avoid needing `orgSlug` in the event payload.
- Reconnect: same backoff ladder as `web/src/app/status/dashboard.tsx` (1s → 30s).
