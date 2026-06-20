---
title: "Webhooks"
description: "Receive release.created events over HTTPS — org-scoped or filtered by your follows."
adminOnly: false
---

# Webhooks

Outbound HTTPS notifications when new releases are indexed. Each delivery is a signed `POST` with a `release.created` payload.

- **Public contract:** [docs/webhooks.md](https://github.com/buildinternet/releases/blob/main/docs/webhooks.md) in the monorepo (signature verification, retries, replay).
- **Interactive API reference:** [`api.releases.sh/v1/docs`](https://api.releases.sh/v1/docs) — search for `/v1/me/webhooks`.
- **Related:** [REST API](/docs/api/rest) · [MCP Server](/docs/api/mcp)

## Self-serve (`/v1/me/webhooks`)

Requires a signed-in account — browser session cookie, user API key (from `releases login` or Account → API Keys), or an OAuth access token from Sign in with Releases. Same authentication as [follows and your personalized feed](/docs/api/rest#authentication).

### Org-scoped (default)

Create a subscription for one organization, optionally narrowed with ANDed filters (`sourceSlug`, `productSlug`, `releaseType`):

```bash
curl -X POST https://api.releases.sh/v1/me/webhooks \
  -H "Authorization: Bearer $RELEASES_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"orgSlug":"vercel","url":"https://hooks.example.com/releases"}'
```

The response includes a **signing key once** at creation (and again after `rotate-secret`). Store it — you cannot retrieve it later.

Up to **10** org-scoped subscriptions per account.

### Follows-scoped

One webhook URL for everything you follow — same matching rules as `GET /v1/me/feed`:

- Following an **org** → all releases from that org's sources.
- Following a **product** → releases from sources tied to that product.

```bash
curl -X POST https://api.releases.sh/v1/me/webhooks \
  -H "Authorization: Bearer $RELEASES_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"scope":"follows","url":"https://hooks.example.com/my-follows"}'
```

**One** follows-scoped subscription per account (separate from the 10 org-scoped cap). Optional `releaseType` (`feature` | `rollup`) narrows follows delivery. Follow/unfollow changes take effect on the next event — no manual webhook edits.

### Management endpoints

| Method   | Path                                | Purpose                                                                |
| -------- | ----------------------------------- | ---------------------------------------------------------------------- |
| `GET`    | `/v1/me/webhooks`                   | List your subscriptions (includes delivery health)                     |
| `GET`    | `/v1/me/webhooks/:id`               | Detail                                                                 |
| `PATCH`  | `/v1/me/webhooks/:id`               | Update URL, description, `enabled`, or filter fields                   |
| `DELETE` | `/v1/me/webhooks/:id`               | Remove                                                                 |
| `POST`   | `/v1/me/webhooks/:id/rotate-secret` | Rotate HMAC signing key                                                |
| `POST`   | `/v1/me/webhooks/:id/test`          | Enqueue a synthetic test delivery                                      |
| `GET`    | `/v1/me/webhooks/:id/deliveries`    | Recent delivery attempts (see [Delivery activity](#delivery-activity)) |

### Account UI

Signed-in users can manage webhooks without raw API calls: **Account → Notifications** on [releases.sh](https://releases.sh/account/notifications). The Webhooks card supports list/create (follows or org), optional filters (`productSlug`, `sourceSlug`, `releaseType`), test delivery, pause/resume, rotate signing key, and delete. The signing key is shown once at create and rotate.

Each subscription shows **aggregate delivery health** (healthy / degraded / failing / paused). Expand **Activity** to see the last 15 per-attempt rows (time, outcome, HTTP status, latency, event id, error snippet).

### Delivery activity

Every delivery attempt is recorded in a delivery log retained for ~**90 days**. Use it to see why a test or real event failed without tailing your own logs.

```bash
# After releases login
releases webhook test <id>
sleep 25   # delivery-log indexing lag — see below
releases webhook deliveries <id> --limit 10
```

`GET /v1/me/webhooks/:id/deliveries` returns the same data. Optional query params: `limit` (1–100), `failed=true` (failures and retries only).

Each row includes:

| Field           | Meaning                                                               |
| --------------- | --------------------------------------------------------------------- |
| `timestamp`     | When the attempt was made                                             |
| `event_id`      | `X-Releases-Event-Id` / release event id                              |
| `outcome`       | `success`, `retry`, `perm_fail`, `dlq`, `auto_disabled`, or `skipped` |
| `http_status`   | Subscriber response code (0 on network error)                         |
| `latency_ms`    | Round-trip time                                                       |
| `attempt`       | Retry attempt number (1 = first try)                                  |
| `error_message` | Truncated response body or error text on failure                      |

**Indexing lag:** rows typically appear **20–30 seconds** after `POST …/test` or a real delivery. `releases webhook show` may say "No delivery attempts recorded" if you check immediately — wait a moment, then run `deliveries` again or reopen Activity in the account UI.

List/detail endpoints still expose `deliveryHealth` and `consecutiveFailures` for at-a-glance status; the activity log is the per-event drill-down.

### URL safety and test limits

Webhook URLs must be public **HTTPS** endpoints. Private IPs, internal hostnames, and metadata addresses are rejected at registration.

`POST …/test` is rate-limited to **5/min per subscription** and **20/min per account** to prevent abuse.

### CLI

After `releases login`, use `releases webhook list|add|show|edit|remove|test|rotate-secret|deliveries`. Filter flags on `add` / `edit`: `--product`, `--source`, `--type` (`feature` | `rollup`), and `--clear-*` on edit. See the [releases-cli skill](https://github.com/buildinternet/releases-cli/tree/main/skills/releases-cli) for examples. `releases webhook verify` checks a captured payload locally (no auth).

## Admin-provisioned webhooks

Operators with admin API access can manage org-scoped subscriptions via `POST /v1/webhooks` (admin route family). See the admin CLI docs for `releases admin webhook …` commands.
