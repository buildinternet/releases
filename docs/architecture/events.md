# Release event bus

The API worker publishes a `release.created` event each time a release row is
inserted (or upserted) into D1. Subscribers receive the events over a
WebSocket at `GET /v1/releases/stream`. A single global Durable Object
(`ReleaseHub`, bound as `RELEASE_HUB`) owns fan-out and a 1000-event ring
buffer for short-window resume.

## Event contract

```jsonc
{
  "type": "release.created",
  "id": "evt_abc123def4xyz",     // globally unique event id
  "seq": 42,                      // monotonic sequence within the DO
  "ts": 1713484800000,            // epoch ms at publish time
  "release": {
    "id": "rel_...",
    "title": "v1.2.3",
    "version": "1.2.3",
    "publishedAt": "2026-04-18T10:00:00Z",
    "sourceName": "Claude Code",
    "sourceSlug": "claude-code",
    "contentSummary": null,       // omitted on publish; clients fetch via REST if needed
    "media": []
  }
}
```

`seq` is the cursor. Clients should store the most recent seq they
observed and pass it as `?since=<seq>` on reconnect.

## Handshake and replay

1. Client opens `GET /v1/releases/stream[?since=<seq>]` with an `Upgrade: websocket` header.
2. Server sends `{ "type": "ready", "seq": <head> }` as the first frame — even when `since` is omitted, so the client knows the current head for future resume.
3. If `since` was provided and is within the buffer (`since >= oldestSeq - 1`), the server replays each missed event in order.
4. If `since` is older than the buffer head, the server sends `{ "type": "snapshot_gap", "since": <caller>, "oldestSeq": <head> }`. The client should REST-backfill via `GET /v1/releases/latest` and re-subscribe from the new head.

## Publish path

Two ingest sites call `publishReleaseEvents(env, { src, inserted })` via
`ctx.waitUntil` after the D1 commit:

- `POST /v1/sources/:slug/releases/batch` (primary CLI fetch path) — `workers/api/src/routes/sources.ts`
- Hourly cron `fetchOne` — `workers/api/src/cron/poll-fetch.ts`

`publishReleaseEvents` is fire-and-forget: any hub failure is logged and
swallowed so publish errors cannot fail ingestion. Event payloads are built
from the `RETURNING` set of the insert, not zipped against the input — the
upsert's conditional `WHERE` clause means RETURNING omits rows where the
update didn't apply, which would otherwise misalign ids against titles.
When `onConflictDoUpdate` does backfill an existing row, that counts as a
new event; clients dedupe by `release.id`.

## Known caveats

- The stream route is mounted in the no-auth group but is nested under
  `/releases/*`, which is also covered by `publicReadAuthMiddleware`,
  `publicRateLimitMiddleware`, and `dbHealthCheck`. Today `RATE_LIMIT_ENABLED`
  is off in production, so this is a no-op; if we later enable the limiter,
  `/v1/releases/stream` will count WebSocket upgrades against the 120/min/IP
  cap. Either exempt the stream path from the public-read middleware chain
  at that point, or raise the cap for stream connects specifically.

## Cost envelope (initial rollout)

With an average of ~10 new releases per hour and ~70 subscribers (mix of
CLI tails and future web live-view tabs + webhook consumers), the hub
runs in the pennies-per-month range. Hibernation keeps idle connections
free; the buffer is bounded at 1000 events so DO storage stays flat.

See `docs/architecture/remote-mode.md` for how this relates to the
cached `/v1/releases/latest` endpoint (which remains the REST fallback
and the backfill path after `snapshot_gap`).

## Consumers

### CLI tail (`releases tail -f`)

Connects to `/v1/releases/stream` over WebSocket. Falls back to polling
on disconnect. See `src/cli/commands/tail.ts`.

### Webhooks (`workers/webhooks`)

Per-subscription HTTPS POST consumer. The publisher in
`workers/api/src/events/publish.ts` calls `expandAndEnqueue` alongside
`ReleaseHub.publish`; the consumer Worker drains `webhook-delivery`,
signs payloads, retries on transient failures, and DLQs on retry
exhaustion. See [docs/webhooks.md](../webhooks.md) for the public
subscriber contract.
