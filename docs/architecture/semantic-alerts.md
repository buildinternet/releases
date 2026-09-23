# Semantic alerts

[#2304](https://github.com/buildinternet/releases/issues/2304). A signed-in user saves a freeform interest ("Slack integrations with B2B software") next to the follow graph. After `release.created`, Releases scores that release against the user's enabled alerts and, on a match, sends email and/or a webhook.

Structural notifications stay as they are: follows, digest email, and `/v1/me/webhooks` (org or follows scope). Semantic alerts sit beside that lane. The same release can still fan out on a follows webhook and, separately, notify because an alert matched.

## Locked decisions

| Decision        | Choice                                                                                                                                                                                                                                                       |
| --------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Candidate pool  | **Follows-only.** A release is eligible only when it already matches the owner's follow graph (org follow or product follow, same predicate as `GET /v1/me/feed`). Not a per-alert column — `GET /v1/me/semantic-alerts` returns `candidatePool: "follows"`. |
| Delivery        | **Webhook and email**, each a preference on the alert.                                                                                                                                                                                                       |
| Match threshold | The alert's stored threshold. Default **0.80** selected-choice probability (allowed 0.50–1.00).                                                                                                                                                              |
| Alert privacy   | Query text is **user-private**. It is sent to JEV as question criteria and, on a match, written into the owner's email. It is not written to logs or Analytics Engine points.                                                                                |
| Matcher shape   | Hybrid: prefilter to the follow graph, then **one JEV call per release** with multiple `noul` questions (one per candidate alert). Questions are capped at 12 per call and chunked.                                                                          |
| Matcher errors  | **Fail closed.** A thrown provider call, a missing probability, or a missing model does not notify. There is no second model.                                                                                                                                |
| Kill switch     | `semantic-alerts-enabled` / `SEMANTIC_ALERTS_ENABLED`, **default off**. Off: routes 404, the account UI hides the section, and the matcher returns before any read or JEV call. Structural webhooks are unaffected.                                          |

## Preferences

Table `semantic_alerts` (worker-local, same tenancy as `user_follows`): `sal_` id, `user_id` (cascade on account delete), query, enabled, threshold, `deliver_email`, `deliver_webhook`, optional `webhook_subscription_id` (cleared if that subscription is deleted), timestamps. At most **5** alerts per user (`429 limit_exceeded` on create).

Routes under `/v1/me/semantic-alerts`, same principal as follows: Better Auth session or user Bearer (`relu_` / OAuth JWT). `relk_` and anonymous callers are 401. Query must be non-empty after trim and at most 500 characters.

`webhookSubscriptionId` must be one of the caller's own `/v1/me/webhooks` rows. `deliverEmail` / `deliverWebhook` are independent. An alert may point at a subscription and still leave `deliverWebhook` false. An alert with both flags false is stored but never scored.

`GET /v1/me/semantic-alerts` and `semanticAlerts` on the notifications bootstrap add `activity` on each alert: `matches7d`, `matches30d` (the 30-day count includes the 7-day window), `lastMatchedAt`, and `lastMatch` (`releaseId`, `title`, `path`) when the release row still exists. Create, update, and single-get omit `activity`. The read is two statements for the caller's alert ids — a grouped count limited to 30 days, and one latest row per id left-joined to `releases` and capped at that id count (max 5). Index `idx_semantic_alert_matches_alert_created` on `(alert_id, created_at)`. No extra matcher writes and no cron.

Account UI on [Notifications](https://releases.sh/account/notifications): list, create, edit (query, threshold, email, webhook), enable/disable, and delete. Each row shows trailing activity from claimed matches: last matched (relative time and a release link when the row still exists) plus counts for the last 7 and 30 days. Below-threshold scores are not stored for this view.

## Matcher

`publishReleaseEvents` runs the matcher beside the ReleaseHub publish and the structural webhook fanout. Both ingest publish sites (poll-fetch and `/releases/batch`) go through that function.

For each inserted release:

1. If the flag is off, stop.
2. Load enabled alerts whose owner follows the release's org or product and that have email or webhook delivery turned on. No follow anchor (no org and no product) skips the model.
3. Skip alerts that already have a `semantic_alert_matches` row for this release, so a republish does not call JEV again for a pair that already notified.
4. Build one shared state from the release title, URL, summary, and content excerpt. The excerpt cap is the marketing classifier's `MAX_CONTENT_CHARS` (2000). Alert text is not part of the state.
5. Ask JEV (`typesafe/jev-1.13` through the OpenRouter Decisions seam, `aisdkDecisionModel`) one `noul` question per remaining alert. The AI SDK spells that question `boolean`; OpenRouter wires it as `noul`. The freeform query is the `true` criterion ("matches interest"). Chunks of 12 share one call. There is no Anthropic fallback: a missing `OPENROUTER_API_KEY` or a constructor failure skips delivery.
6. Match when P(true) is finite, in `[0, 1]`, and **greater than or equal to** that alert's threshold. P(true) is the selected-choice probability of the matches-interest option. Provider confidence is not used. A missing or non-finite probability is a failure, not a non-match that we retry on another model.
7. On a match, insert `semantic_alert_matches` (`PRIMARY KEY (alert_id, release_id)`). The insert is the idempotency lock: conflict means do not send again.

A thrown chunk marks those alerts failed and continues with the next chunk. Failed alerts are not claimed, so a later publish can try again. They are not notified on the failing attempt.

## Delivery

Email uses `AUTH_EMAIL` and the shared `renderEmail` shell (`buildSemanticAlertEmail`). The message includes the interest text, the release title, and a link to the release plus `/account/notifications`. The send log records alert id and release id only.

Webhook, when `deliverWebhook` is set:

- A linked `webhookSubscriptionId` delivers to that subscription when it is still enabled and owned by the alert's user. A disabled or missing link does not fall through to a different URL.
- Otherwise the user's enabled follows-scoped subscription is used.

The payload is the same signed `release.created` event the structural fanout uses, enqueued on `WEBHOOK_DELIVERY_QUEUE`. Subscribers that dedupe on `X-Releases-Event-Id` will collapse a semantic delivery that repeats an event they already received from the follows webhook.

## Telemetry

Each JEV call logs an `ai_usage` event (`lane: semantic-alert-match`) with token counts, cost, question count, and release id. No query text. Daily and weekly spend queries for that lane are in [ai-provider-monitors.md → Interest alert match spend](../runbooks/ai-provider-monitors.md#interest-alert-match-spend).

Optional Analytics Engine points go to the existing classifications dataset with `blob4 = semantic-alert`. Marketing admin queries filter `blob4 = 'marketing'`, so these points stay out of that dashboard. The point carries release id, source id, alert id, disposition (`matched` | `below_threshold` | `failed`), P(true), and the alert threshold. Cost stays on `ai_usage` because one call covers many alerts. Failure categories are `provider_error` or `invalid_probability` — never the provider message.

## Operator visibility

Admin or root (`admin/semantic-alerts`, same gate as the preview). Not behind `semantic-alerts-enabled`.

`GET /v1/admin/semantic-alerts/summary` reads those points for a window (`after`, `before`, `bucket` — same bounds as the marketing summary: default last 7 days, max 100 days). The writer always sets origin `ingest`, and the summary keeps that filter. Counts use `SUM(_sample_interval)`. The body is:

- `totals.scored` — `matched` + `belowThreshold` (a probability came back)
- `totals.matchRate` — `matched / scored`, or null when nothing was scored
- `totals.failed` — fail-closed. Stays out of the rate
- `series` — the same three counts per hour or day
- `failures` — `provider_error`, `invalid_probability`, or `unknown`
- `probability` — ten bins of P(true) on `double1`. `0.8` is the start of the default-threshold bin. Each point still stores its own threshold; the chart marks the default

`meta.sampled` is true, `meta.retentionDays` is 90, and `meta.costLane` is `semantic-alert-match`. The response has no alert query, no alert id, and no dollar total. Missing Analytics Engine credentials are `503` `deliveries_unavailable`. A failed statement is `502` `ae_query_failed` with `{ query, status }` only. The summary is cached for 45 seconds in `LATEST_CACHE` under `semantic-alert-summary:v1:` (same TTL trick as marketing classifications).

**Admin → Semantic alerts** (`/admin/semantic-alerts`) renders the summary for 24h / 7d / 30d and pastes the Axiom spend queries under the chart. The synthetic-release preview stays on the same page.

## Admin preview

Operator tool for local development and live demos. Admin or root only (`admin/semantic-alerts` in `adminRoutes`). It is not behind `semantic-alerts-enabled` — inserts work while the user-facing lane is off. When `userId` is set, the response scores that account's enabled alerts through `matchSemanticAlertsForUser` (the same JEV path as production, without claiming or delivering again).

`POST /v1/admin/semantic-alerts/preview` with `{ count?, sourceId?, userId?, seed? }`:

- `count` is an integer from 1 to **20** (default 5).
- Omit `sourceId` to use the dedicated org `semantic-alerts-demo` / source `preview`. The handler creates them if needed: visible (so a follow puts rows in the Phase 2 candidate pool — the feed query drops hidden orgs and sources), not featured, org `fetchPaused`, source `fetchPriority: paused`. The placeholder URL is `https://demo.releases.invalid/changelog` and is never polled.
- `sourceId` is `src_…` or `orgSlug/sourceSlug` when the demo org is the wrong target. A bare slug is rejected. This is the only way to write onto any other org.
- Rows go through `ingestReleaseBatch` and `runBatchIngestEffects` (the batch upsert, `publishReleaseEvents`, and webhook fanout). Summaries and embeddings are skipped so a demo does not spend the summarize lane or write vectors.
- Titles are prefixed `[demo]`. `metadata.semanticAlertDemo` is `true`. The dedicated demo source refuses a request that would push it past 20 flagged rows (`429 limit_exceeded`).
- `userId`, when set, must be a real account. The response `matcher` field is `scored` when the JEV model is available (including an empty candidate set), or `unavailable` with `model_unavailable` when OpenRouter cannot be built. Omit `userId` and `matcher.status` is `skipped`. A matcher exception is reported as `error` and does not roll back the insert or the follow. Create enabled alerts on that account before expecting matches.
- On a successful preview of the dedicated demo source, `userId` upserts an org follow of `semantic-alerts-demo` for that account before insert and publish, so the follows-only matcher has a candidate pool. `follow.ensured` is `true` when that upsert ran, including when the follow was already there. Purge leaves the follow in place. Omit `userId` and no follow is written (`follow.ensured` is `false`). An explicit `sourceId` is not auto-followed — follow that org before expecting matches there.

`POST /v1/admin/semantic-alerts/purge` deletes **only** rows with `semanticAlertDemo: true`. It does not unfollow `semantic-alerts-demo`. Unfollow from the account if the demo org should leave the feed.

- `{}` purges the dedicated demo source.
- `{ sourceId }` purges flagged rows on that source.
- `{ all: true }` purges every flagged row. Unflagged releases are left in place.

The same actions are on **Admin → Semantic alerts** (`/admin/semantic-alerts`), proxied through `/api/proxy` so the root key stays server-side.

## Code

- Schema + migrations: `workers/api/src/db/schema-semantic-alerts.ts`, `workers/api/migrations/20260922020000_add_semantic_alerts.sql`, `workers/api/migrations/20260922030000_semantic_alert_matches.sql`, `workers/api/migrations/20260922200000_semantic_alert_matches_alert_created_idx.sql`
- Routes: `workers/api/src/routes/me-semantic-alerts.ts`
- Matcher: `packages/ai/src/semantic-alert-match.ts`, `workers/api/src/semantic-alerts/run.ts` (hooked from `workers/api/src/events/publish.ts`), `workers/api/src/lib/semantic-alert-matcher.ts` (admin preview seam)
- Wire types: `@buildinternet/releases-api-types` (`SemanticAlert`, `SemanticAlertActivity` on list rows, threshold and cap constants)
- Web: `web/src/components/semantic-alerts-section.tsx` on the notifications panel
- Admin preview: `workers/api/src/routes/admin-semantic-alerts.ts`, `workers/api/src/lib/semantic-alert-demo.ts`, `/admin/semantic-alerts`
- Admin quality summary: `workers/api/src/lib/semantic-alert-summary.ts`, `GET /v1/admin/semantic-alerts/summary`
