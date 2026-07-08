# Releases webhooks worker

Queue consumer that delivers real-time `release.created` fan-out to user and org webhook subscriptions, plus Slack/email notification formatting.

## Layout

- `index.ts` — queue consumer entrypoint
- `deliver.ts` — webhook delivery (signing, retries)
- `user-notify.ts` — per-user notification fan-out
- `auto-disable-notify.ts` — auto-disables repeatedly-failing subscriptions
- `email.ts` — email notification sending
- `alert-format.ts` — notification payload/message formatting
- `slack-app-id.ts` — Slack app ID resolution
- `ae.ts` — Analytics Engine event writes
- `queries.ts` — D1 query helpers
- `db.ts` — D1 client setup

Not part of the root Bun workspace — wrangler manages its dependencies independently (see repo root `AGENTS.md`).

## Deploy

Deployed as `releases-webhooks`:

```bash
bunx wrangler deploy --config workers/webhooks/wrangler.jsonc
```

No local dev script is wired up for this worker.

## Docs

- [../../docs/webhooks.md](../../docs/webhooks.md) — webhook subscriptions, delivery, signing
