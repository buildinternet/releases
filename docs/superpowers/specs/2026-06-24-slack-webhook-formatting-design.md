# Slack-formatted webhook delivery

**Date:** 2026-06-24
**Status:** Design approved, pre-implementation

## Goal

Let a user receive release notifications in Slack by pointing an existing webhook
subscription at a Slack **incoming webhook** URL and choosing a Slack output
format. This is an interim step "before a proper Slack app" — incoming-webhook
only, no OAuth, no slash commands. Discord is a known future format and the design
leaves a seam for it, but Discord is **not** built here.

The whole feature reuses the existing subscription + fan-out + delivery machinery.
The only new behavior is how the request **body** is shaped at delivery time,
selected by an explicit per-subscription `format` field.

## Background (existing system)

- Subscriptions live in `webhook_subscriptions` (`packages/core/src/schema.ts`),
  managed via `/v1/me/webhooks` (`workers/api/src/routes/me-webhooks.ts`) and the
  CLI `releases webhook ...` (`releases-cli`).
- A new release fans out through `workers/api/src/webhooks/expand-and-enqueue.ts`,
  producing a `DeliveryMessage` (`workers/api/src/webhooks/types.ts`) per matching
  subscription. The message captures `url` + `secretVersion` at fan-out time so
  in-flight deliveries are stable across later edits.
- The delivery worker `workers/webhooks/src/deliver.ts` POSTs
  `JSON.stringify(event)` with HMAC-SHA256 signature headers
  (`X-Releases-Signature`, `X-Releases-Timestamp`, `X-Releases-Event-Id`,
  `X-Releases-Version`). Outcome: 2xx `success`, 4xx `perm_fail`, 5xx/network
  `retry`. This engine is format-agnostic and stays unchanged.
- The event body is a `ReleaseEvent` (`workers/api/src/events/types.ts`):
  `event.release.{ id, title, version, publishedAt, sourceName, sourceSlug,
summary, org?: { slug, name, avatarUrl, githubHandle }, product?: { slug, name },
media, ... }`. Slack-relevant fields are title, version, summary, org, product,
  publishedAt, and a release URL.

## Decisions

1. **Explicit `format` field** — source of truth, default preserves today's
   behavior. No URL auto-detection magic.
2. **Compact message (one section + context row)** with the org avatar as a small
   inline icon in the context row. Not the richer header/button layout.
3. **Host guardrail is an allowlist**, not a single exact host: `hooks.slack.com`
   (covers standard workspaces and Enterprise Grid, which share this host) and
   `hooks.slack-gov.com` (GovSlack). Workflow-trigger webhooks live under
   `hooks.slack.com/triggers`, so they pass on host alone.

## Data model

Add one column to `webhook_subscriptions`:

| column   | type | constraint                                    |
| -------- | ---- | --------------------------------------------- |
| `format` | text | `NOT NULL DEFAULT 'json'`, enum `json\|slack` |

- `json` — exactly today's behavior: signed raw `ReleaseEvent` body.
- `slack` — Slack Block Kit body, **unsigned**.

Schema change lands in `packages/core/src/schema.ts` (`WEBHOOK_FORMATS =
["json", "slack"] as const`) with a **paired Drizzle migration** in
`workers/api/migrations/` (schema-pairing CI gate — a real `ALTER TABLE ... ADD
COLUMN format ... DEFAULT 'json'`).

The `format` field is additive wire protocol in `packages/api-types`:

- Create/patch request: optional `format?: "json" | "slack"` (default `json`).
- List/get/create response: echoes `format`.

## The formatter (new isolated unit)

`packages/rendering/src/slack-message.ts`:

```ts
export function formatSlackMessage(event: ReleaseEvent): SlackWebhookBody;
```

Pure, runtime-neutral, worker-safe, unit-testable without the delivery engine.
Returns:

- `text` — plain fallback string (notifications / unfurl-less clients), e.g.
  `"{org/source name} — {title}{ vX.Y.Z}"`.
- `blocks`:
  - **section** (mrkdwn): `*<{releaseUrl}|{title}{ vX.Y.Z}>*` followed by the
    summary, truncated (target ~300 chars, cut on a word boundary, ellipsis).
    Title-only line when `summary` is null.
  - **context**: optional `image` element (the org avatar) + mrkdwn
    `{org or product name} · {date}`. Date uses Slack's
    `<!date^{unixSeconds}^{date_short_pretty}|{fallback}>` so it localizes to the
    viewer; static fallback string when `publishedAt` is null.

Avatar resolution (first that exists, else omit the image element):

1. `event.release.org.avatarUrl`
2. `https://github.com/{org.githubHandle}.png`

Release URL: the canonical web URL for the release (reuse whatever helper the
web/event surfaces already use to build a release permalink; resolve during
implementation — do not invent a new scheme).

`SlackWebhookBody` is a local type in the formatter module (not zod, `packages/
rendering` convention); Discord later adds a sibling `formatDiscordMessage()` and
a `"discord"` enum value, nothing else.

## Delivery

- `DeliveryMessage` gains `format: WebhookFormat`, captured at fan-out time in
  `expand.ts` / `expand-follows.ts` alongside `url` and `secretVersion`.
- `workers/webhooks/src/deliver.ts` branches on `message.format`:
  - `"slack"` → `body = JSON.stringify(formatSlackMessage(message.event))`;
    headers are `Content-Type: application/json` + `User-Agent` only — **no**
    `X-Releases-*` signature headers (Slack ignores them; omitting is cleaner and
    avoids implying a verifiable signature). Outcome mapping is unchanged: Slack
    returns `200 ok` → `success`, `400 invalid_payload` → `perm_fail`,
    5xx → `retry`.
  - `"json"` → today's signed path, byte-for-byte unchanged.

No change to retry/backoff, auto-disable, DLQ, rate limiting, or delivery
analytics — those operate on outcome codes, which are identical across formats.

## Validation (fail-closed)

In the create and patch handlers (`me-webhooks.ts`), when the effective `format`
is `slack`:

- The URL host MUST be in the allowlist `{ hooks.slack.com, hooks.slack-gov.com }`
  (exact host match, case-insensitive). Otherwise reject `400` with a clear
  message ("Slack webhooks must point at a hooks.slack.com incoming webhook URL").
- The existing HTTPS-only + private-IP rejection still applies.

Because Slack subs have no verifiable signature:

- The create response omits the one-time `signingKey` for `format: "slack"`.
- `rotate-secret` and `verify` affordances are hidden/again no-ops for Slack subs
  in the UI and CLI help (the column still exists; it is simply unused).

## Surfaces

- **CLI** (`releases-cli`, `webhook add` / `webhook edit`): add
  `--format json|slack` (default `json`). For `--format slack`, suppress the
  "signing key (shown once)" output and print a one-line "Posts to Slack" note.
  Changeset entry (per repo convention).
- **Web** (`web/src/components/webhooks-panel.tsx` + `web/src/lib/webhooks.ts`):
  a format selector on the create form; for Slack subs hide signing-key / rotate /
  verify chrome and show a "Posts to Slack" hint. No emojis in the UI.
- **Docs** (`web/src/content/docs/api/webhooks.md`): a short "Slack delivery"
  section — how to create a Slack incoming webhook, that `format: "slack"` posts a
  formatted card, and that no signature verification is needed.
- **Test event** (`me-webhooks.ts` `/test`): the synthetic event renders through
  `formatSlackMessage` when the sub's `format` is `slack`, so the test button posts
  a realistic card.

## Testing

- **Unit** (`packages/rendering`): `formatSlackMessage` over full payload;
  no-summary (title-only); no-org / no-avatar (image element omitted, GitHub
  fallback used); long-summary truncation on word boundary; version-less title;
  null `publishedAt` (date fallback).
- **Worker** (`workers/webhooks`): `deliver.ts` slack branch sends the Slack body
  and **no** `X-Releases-*` headers; json branch byte-for-byte unchanged.
- **Route** (`workers/api`): create/patch rejects a non-allowlisted host when
  `format: "slack"`; accepts `hooks.slack.com` and `hooks.slack-gov.com`; `format`
  defaults to `json`; response echoes `format`.

## Out of scope (YAGNI)

- Discord delivery (only the formatter/enum seam is reserved).
- Per-field custom message templates.
- Slack message threading / update-in-place.
- A real Slack OAuth app, slash commands, or interactivity.
- Feature flag — this is additive, opt-in, and low-risk; ships enabled with no
  flag per the repo's "be judicious with feature flags" rule.
