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

Authenticated with a Better Auth session, a `relu_` user API key, or an OAuth JWT from "Sign in with Releases" — the same principal gate as [follows and your personalized feed](/docs/api/rest#authentication).

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

| Method   | Path                                | Purpose                                                    |
| -------- | ----------------------------------- | ---------------------------------------------------------- |
| `GET`    | `/v1/me/webhooks`                   | List your subscriptions (includes delivery health)         |
| `GET`    | `/v1/me/webhooks/:id`               | Detail                                                     |
| `PATCH`  | `/v1/me/webhooks/:id`               | Update URL, description, `enabled`, or filter fields       |
| `DELETE` | `/v1/me/webhooks/:id`               | Remove                                                     |
| `POST`   | `/v1/me/webhooks/:id/rotate-secret` | Rotate HMAC signing key                                    |
| `POST`   | `/v1/me/webhooks/:id/test`          | Enqueue a synthetic test delivery                          |
| `GET`    | `/v1/me/webhooks/:id/deliveries`    | Recent delivery attempts (Analytics Engine, last ~90 days) |

### Account UI

Signed-in users can manage webhooks without raw API calls: **Account → Notifications** on [releases.sh](https://releases.sh/account/notifications). The Webhooks card supports list/create (follows or org), test delivery, pause/resume, rotate signing key, per-subscription delivery activity, and delete. The signing key is shown once at create and rotate.

### URL safety and test limits

Webhook URLs must be public **HTTPS** endpoints. Private IPs, internal hostnames, and metadata addresses are rejected at registration.

`POST …/test` is rate-limited to **5/min per subscription** and **20/min per account** to prevent abuse.

### CLI

After `releases login`, use `releases webhook list|add|show|edit|remove|test|rotate-secret|deliveries`. See the [releases-cli skill](https://github.com/buildinternet/releases-cli/tree/main/skills/releases-cli) for examples. `releases webhook verify` checks a captured payload locally (no auth).

## Admin-provisioned webhooks

Operators with admin API access can manage org-scoped subscriptions via `POST /v1/webhooks` (admin route family). See the admin CLI docs for `releases admin webhook …` commands.
