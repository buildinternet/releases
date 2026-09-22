# Semantic alerts

Phase 1 of [#2304](https://github.com/buildinternet/releases/issues/2304). A signed-in user can save a freeform interest ("Slack integrations with B2B software") next to the follow graph. **This phase does not score releases and does not deliver matches.** There is no JEV call, no hook on `release.created`, and no email or webhook send for an alert.

Structural notifications stay as they are: follows, digest email, and `/v1/me/webhooks` (org or follows scope). Semantic alerts sit beside that lane.

## Locked decisions

| Decision                | Choice                                                                                                                                                                                                                                           |
| ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Candidate pool          | **Follows-only.** When matching exists, a release is eligible only if it already matches the caller's follow graph (same notion as `GET /v1/me/feed`). Not a per-alert column — `GET /v1/me/semantic-alerts` returns `candidatePool: "follows"`. |
| Delivery                | **Webhook and email**, stored now as preferences. Phase 1 does not send either.                                                                                                                                                                  |
| Match threshold         | **0.80** default selected-choice probability. Callers may set 0.50–1.00.                                                                                                                                                                         |
| Alert privacy           | Query text is **user-private**. Do not write it to Analytics Engine points. Phase 1 emits no alert analytics at all; later diagnostics stay structured (ids, scores, outcomes) and must not carry the query.                                     |
| Matcher shape (Phase 2) | Hybrid prefilter to the follow graph, then **one JEV call per release** with multiple `noul` questions (one per candidate alert). Not built here.                                                                                                |

## What ships in Phase 1

- Kill switch `semantic-alerts-enabled` / `SEMANTIC_ALERTS_ENABLED`, **default off**, read by the API worker. See [feature-flags.md](feature-flags.md). Off: `/v1/me/semantic-alerts` answers **404**. The notifications bootstrap returns `semanticAlerts: null`, and the account UI hides the section. On: CRUD works and the bootstrap returns the caller's alerts (possibly empty).
- Table `semantic_alerts` (worker-local, same tenancy as `user_follows`): `sal_` id, `user_id` (cascade on account delete), query, enabled, threshold, `deliver_email`, `deliver_webhook`, optional `webhook_subscription_id` (cleared if that subscription is deleted), timestamps. At most **5** alerts per user, enforced on create (`429 limit_exceeded`).
- Routes under `/v1/me/semantic-alerts`, same principal as follows: Better Auth session or user Bearer (`relu_` / OAuth JWT). `relk_` and anonymous callers are 401. Query must be non-empty after trim and at most 500 characters.
- Account UI on [Notifications](https://releases.sh/account/notifications): list, create, enable/disable, delete, empty state. No "matched releases" list.

`webhookSubscriptionId` must be one of the caller's own `/v1/me/webhooks` rows. `deliverEmail` / `deliverWebhook` are independent booleans so a later sender can honor them without a schema change. An alert may point at a subscription and still leave `deliverWebhook` false.

## Phase 2 (not this change)

After `release.created` / the existing webhook fanout path: load enabled alerts for users whose follows already include that release, ask JEV once per release with one `noul` question per alert, and deliver webhook + email when the probability is at least the alert's threshold. Fail **closed** on matcher errors (no notify). Cap questions per batch. Query text still never goes into Analytics Engine.

## Code

- Schema + migration: `workers/api/src/db/schema-semantic-alerts.ts`, `workers/api/migrations/20260922020000_add_semantic_alerts.sql`
- Routes: `workers/api/src/routes/me-semantic-alerts.ts` (mounted with the other `/v1/me/*` handlers)
- Wire types: `@buildinternet/releases-api-types` (`SemanticAlert`, list response, threshold and cap constants)
- Web: `web/src/components/semantic-alerts-section.tsx` on the notifications panel
