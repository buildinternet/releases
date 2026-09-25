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

Requires a signed-in account: a browser session cookie, a user API key (from `releases login` or Account → API Keys), or an OAuth access token from Sign in with Releases. Same authentication as [follows and your personalized feed](/docs/api/rest#authentication).

### Org-scoped (default)

Create a subscription for one organization, optionally narrowed with ANDed filters (`sourceSlug`, `productSlug`, `releaseType`):

```bash
curl -X POST https://api.releases.sh/v1/me/webhooks \
  -H "Authorization: Bearer $RELEASES_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"orgSlug":"vercel","url":"https://hooks.example.com/releases"}'
```

The response includes a **signing key once** at creation (and again after `rotate-secret`). Store it; you can't retrieve it later.

Up to **10** org-scoped subscriptions per account.

### Follows-scoped

One webhook URL for everything you follow, with the same matching rules as `GET /v1/me/feed`:

- Following an **org** → all releases from that org's sources.
- Following a **product** → releases from sources tied to that product.

```bash
curl -X POST https://api.releases.sh/v1/me/webhooks \
  -H "Authorization: Bearer $RELEASES_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"scope":"follows","url":"https://hooks.example.com/my-follows"}'
```

**One** follows-scoped subscription per account (separate from the 10 org-scoped cap). Optional `releaseType` (`feature` | `rollup`) narrows follows delivery. When you follow or unfollow something, the change applies on the next event. No webhook edits needed.

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

### Finding your workspace id (`/v1/me/workspaces`)

A workspace is your team's account on Releases Index. It's separate from the
companies and products that webhooks watch. Every account has at least one
personal workspace. `GET /v1/me/workspaces` lists the workspaces you belong
to, so scripts, the CLI, and the MCP server can find a workspace id:

```bash
curl https://api.releases.sh/v1/me/workspaces \
  -H "Authorization: Bearer $RELEASES_TOKEN"
```

```json
{
  "workspaces": [
    {
      "id": "Xk3vQ9dLm2PzR8tYw1Hn",
      "name": "Acme Team",
      "slug": "acme-team",
      "logo": null,
      "role": "owner",
      "active": true,
      "createdAt": "2026-01-01T00:00:00.000Z"
    }
  ]
}
```

`role` is your role in that workspace (`owner`, `admin`, or `member`).
`active` marks the workspace you last switched to. This route only reads.
Create, rename, and switch workspaces from
[your account settings](https://releases.sh/account/workspaces).

### Account UI

Signed-in users can manage webhooks without raw API calls: **Account → Webhooks & API** on [releases.sh](https://releases.sh/account/webhooks). The Webhooks card supports list/create (follows or org), optional filters (`productSlug`, `sourceSlug`, `releaseType`), test delivery, pause/resume, rotate signing key, and delete. The signing key is shown once at create and rotate.

From an organization page, **Add webhook** in the header ⋯ menu opens this form already scoped to that org.

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

After `releases login`, use `releases webhook list|add|show|edit|remove|test|rotate-secret|deliveries`. Filter flags on `add` / `edit`: `--product`, `--source`, `--type` (`feature` | `rollup`), and `--clear-*` on edit. See the [releases-cli skill](https://github.com/buildinternet/releases-cli/tree/main/plugins/claude/releases/skills/releases-cli) for examples. `releases webhook verify` checks a captured payload locally (no auth).

## Workspace webhooks (`/v1/workspaces/:workspaceId/webhooks`)

A webhook can also be owned by a workspace (a Workspaces organization, not a registry org) instead of your personal account, so a shared team channel keeps working after the person who set it up leaves. The route family mirrors `/v1/me/webhooks` exactly, one level down under the workspace:

| Method   | Path                                                     | Purpose                                     |
| -------- | -------------------------------------------------------- | ------------------------------------------- |
| `GET`    | `/v1/workspaces/:workspaceId/webhooks`                   | List — includes your `role` and `canManage` |
| `POST`   | `/v1/workspaces/:workspaceId/webhooks`                   | Create (owner/admin only)                   |
| `GET`    | `/v1/workspaces/:workspaceId/webhooks/:id`               | Detail                                      |
| `PATCH`  | `/v1/workspaces/:workspaceId/webhooks/:id`               | Update (owner/admin only)                   |
| `DELETE` | `/v1/workspaces/:workspaceId/webhooks/:id`               | Remove (owner/admin only)                   |
| `POST`   | `/v1/workspaces/:workspaceId/webhooks/:id/rotate-secret` | Rotate HMAC signing key (owner/admin only)  |
| `POST`   | `/v1/workspaces/:workspaceId/webhooks/:id/test`          | Enqueue a synthetic test delivery           |
| `GET`    | `/v1/workspaces/:workspaceId/webhooks/:id/deliveries`    | Recent delivery attempts                    |

Differences from a personal webhook:

- **Org-scoped only** — there's no workspace "follows" scope. `POST` with `{"scope": "follows"}` returns `400`.
- **Owners and admins** create/edit/rotate/delete; **any member** can list, view, and test. A non-member gets `404`; a member without manage rights gets `403`.
- Up to **10** subscriptions per workspace, tracked separately from each member's personal cap.
- Deleting the workspace deletes its webhooks; a member leaving does not.

## Admin-provisioned webhooks

Operators with admin API access can manage org-scoped subscriptions via `POST /v1/webhooks` (admin route family). See the admin CLI docs for `releases admin webhook …` commands.

## Slack delivery

New to this? The [Send releases to Slack](/docs/integrations/slack) guide walks through it
step by step. The reference below covers the API/CLI details.

Set `format: "slack"` (or `--format slack` on the CLI) and point the subscription
at a [Slack incoming webhook](https://docs.slack.dev/messaging/sending-messages-using-incoming-webhooks/)
URL (`https://hooks.slack.com/services/...`). Each release is posted as a compact
Slack message — a linked title, a short summary, and a context line with the
organization's avatar and date.

Slack webhooks are **unsigned**: the URL itself is the secret, so no signing key is
issued and no `X-Releases-*` signature headers are sent. There is nothing to
verify on the Slack side. Use the **Test** button (or `releases webhook test <id>`)
to post a sample card.

The host must be `hooks.slack.com` (standard and Enterprise Grid) or
`hooks.slack-gov.com` (GovSlack); other hosts are rejected at creation.

## Discord delivery

New to this? The [Send releases to Discord](/docs/integrations/discord) guide walks through it
step by step. The reference below covers the API/CLI details.

Set `format: "discord"` (or `--format discord` on the CLI) and point the subscription
at a [Discord incoming webhook](https://support.discord.com/hc/en-us/articles/228383668)
URL (`https://discord.com/api/webhooks/...`). Each release is posted as a compact
Discord embed — a linked title, a short summary, and the organization's avatar and date.

Discord webhooks are **unsigned**: the URL itself is the secret, so no signing key is
issued and no `X-Releases-*` signature headers are sent. There is nothing to
verify on the Discord side. Use the **Send test** button (or `releases webhook test <id>`)
to post a sample embed.

The host must be `discord.com` (or `discordapp.com`, `canary.discord.com`,
`ptb.discord.com`) and the path must be `/api/webhooks/{id}/{token}`; other hosts
and the Slack-compat `/slack` suffix are rejected at creation.
