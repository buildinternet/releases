# Releases webhooks worker

Queue consumer that delivers real-time `release.created` fan-out to user and org webhook subscriptions, plus Slack/email notification formatting.

## Layout

| Path                     | Purpose                                         |
| ------------------------ | ----------------------------------------------- |
| `index.ts`               | Queue consumer entrypoint.                      |
| `deliver.ts`             | Webhook delivery (signing, retries).            |
| `user-notify.ts`         | Per-user notification fan-out.                  |
| `auto-disable-notify.ts` | Auto-disables repeatedly-failing subscriptions. |
| `email.ts`               | Email notification sending.                     |
| `alert-format.ts`        | Notification payload/message formatting.        |
| `slack-app-id.ts`        | Slack app ID resolution.                        |
| `ae.ts`                  | Analytics Engine event writes.                  |
| `queries.ts`             | D1 query helpers.                               |
| `db.ts`                  | D1 client setup.                                |

> Not part of the root Bun workspace — wrangler manages its dependencies independently (see repo root [`AGENTS.md`](../../AGENTS.md)).

## Deploy

Deployed as `releases-webhooks`:

```bash
bunx wrangler deploy --config workers/webhooks/wrangler.jsonc
```

No local dev script is wired up for this worker.

## Docs

| Doc                                   | Covers                                    |
| ------------------------------------- | ----------------------------------------- |
| [webhooks.md](../../docs/webhooks.md) | Webhook subscriptions, delivery, signing. |
