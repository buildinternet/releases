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

Account UI on [Notifications](https://releases.sh/account/notifications): list, create, enable/disable, delete. The panel does not list matched releases.

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

Each JEV call logs an `ai_usage` event (`lane: semantic-alert-match`) with token counts, cost, question count, and release id. No query text.

Optional Analytics Engine points go to the existing classifications dataset with `blob4 = semantic-alert`. Marketing admin queries filter `blob4 = 'marketing'`, so these points stay out of that dashboard. The point carries release id, source id, alert id, disposition (`matched` | `below_threshold` | `failed`), P(true), and the alert threshold. Cost stays on `ai_usage` because one call covers many alerts. Failure categories are `provider_error` or `invalid_probability` — never the provider message.

## Code

- Schema + migrations: `workers/api/src/db/schema-semantic-alerts.ts`, `workers/api/migrations/20260922020000_add_semantic_alerts.sql`, `workers/api/migrations/20260922030000_semantic_alert_matches.sql`
- Routes: `workers/api/src/routes/me-semantic-alerts.ts`
- Matcher: `packages/ai/src/semantic-alert-match.ts`, `workers/api/src/semantic-alerts/run.ts` (hooked from `workers/api/src/events/publish.ts`)
- Wire types: `@buildinternet/releases-api-types` (`SemanticAlert`, list response, threshold and cap constants)
- Web: `web/src/components/semantic-alerts-section.tsx` on the notifications panel
