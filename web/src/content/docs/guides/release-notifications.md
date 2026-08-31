---
title: "How to Get Notified When Products Ship Updates"
description: "Every way to get pushed a notification when a changelog updates — Slack and Discord messages, email digests, RSS, and signed webhooks for your own systems."
adminOnly: false
---

# How to get notified when products ship updates

Checking changelogs by hand doesn't scale past two or three products. This guide covers every way to flip that around — the update comes to you: a Slack or Discord message when something ships, an email digest on your schedule, a feed in your reader, or a signed webhook into your own systems.

The options form a ladder from zero-setup to fully programmable. Most of the Releases-powered ones share one primitive: [follow](/following) the orgs and products you care about (a free account), and every channel below delivers that same follow list.

## What the publisher already offers

Before adding anything, check the two native options:

- **GitHub's "Watch → Custom → Releases"** on a repo emails you (or notifies in-app) on every tagged release. Solid for libraries; useless for hosted products whose updates never get a tag.
- **The vendor's own newsletter or in-app "what's new" panel.** Coverage is whatever marketing decides to send, on their schedule.

Both are per-product and per-channel. Everything below gives you one subscription across your whole stack.

## RSS: the quiet default

If you already live in a feed reader, subscribe to feeds and you're done — no account needed. Every Releases org, source, and collection page serves Atom by appending `.atom` to its URL (`releases.sh/anthropic.atom`), including changelogs that publish no feed of their own. The [RSS guide](/docs/guides/changelog-rss-feed) covers this end to end.

If you'd rather have one feed than many: sign in, follow your orgs, and generate a **personal feed token** on [Notifications](/account/notifications) — a private Atom URL of everything you follow, updated as your follows change.

RSS is pull, not push: your reader decides when to check. For "tell me the moment it ships", keep going.

## Slack notifications

The most common ask — "post new releases to our team channel" — takes two steps and no app install:

1. Create a [Slack incoming webhook](https://docs.slack.dev/messaging/sending-messages-using-incoming-webhooks/) for the channel.
2. Paste the URL into the Slack section of [Notifications](/account/notifications).

Each release you follow arrives as a compact message: linked title, short summary, org avatar, and date. There's a Test button to confirm the wiring. Full details, including why the webhook URL must stay secret: [Send releases to Slack](/docs/integrations/slack).

## Discord notifications

There's no one-paste Discord equivalent yet, but two well-trodden paths get you there:

- **An RSS-to-Discord bot.** Bots like [MonitoRSS](https://monitorss.xyz) post feed entries into a channel. Point one at any `.atom` URL — an org, a source, or your personal feed token — and you have changelog notifications in Discord with zero code.
- **A webhook relay.** Create a [follows-scoped webhook](#webhooks-for-your-own-systems) and point it at a small relay (a Cloudflare Worker, or an automation platform like Zapier, Make, or Pipedream) that reformats the payload into a [Discord webhook](https://support.discord.com/hc/en-us/articles/228383668) message. More moving parts, full control over formatting and filtering.

The same two patterns cover Microsoft Teams, Mattermost, and anything else with incoming webhooks or an RSS bot.

## Email digest

For a rollup instead of a stream: turn on the **release digest** on [Notifications](/account/notifications) and pick daily or weekly. You get one email summarizing what shipped across everything you follow — the right cadence when you want awareness, not interruptions.

## Webhooks, for your own systems

When the destination is your code — an internal tool, a database, a bot you're building — subscribe directly. Each new release you've scoped to arrives as a signed `POST` with a `release.created` payload:

```bash
curl -X POST https://api.releases.sh/v1/me/webhooks \
  -H "Authorization: Bearer $RELEASES_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"scope":"follows","url":"https://hooks.example.com/my-follows"}'
```

Subscriptions come in two scopes — one URL for everything you follow, or per-org with filters (`sourceSlug`, `productSlug`, `releaseType`) — with HMAC signatures, retries, delivery logs, and a test endpoint. See the [webhooks docs](/docs/api/webhooks) for the contract.

## For agents

An agent usually shouldn't sit on a push channel — it should check on demand. Add the MCP server and "what changed in my stack this week?" becomes a tool call:

```bash
claude mcp add --transport http releases https://mcp.releases.sh/mcp
```

For a live terminal view, the CLI can follow the stream directly: `releases tail -f` polls for new releases as they land. And a follows-scoped webhook works as an agent trigger too — new release in, agent run out.

## Which one should I use?

| You want                              | Use                                                             |
| ------------------------------------- | --------------------------------------------------------------- |
| Updates in a feed reader              | `.atom` feeds, or a personal feed token for your follows        |
| A message in a team Slack channel     | The Slack connection on [Notifications](/account/notifications) |
| A message in Discord (or Teams, etc.) | An RSS bot on a `.atom` URL, or a webhook + relay               |
| One summary email a day or week       | The release digest                                              |
| Events into your own code             | Signed webhooks (`/v1/me/webhooks`)                             |
| An agent that checks on demand        | The MCP server or CLI                                           |

## FAQ

### How fast are the notifications?

Push channels (Slack, webhooks) fire when a release is indexed, which follows the source's polling schedule — typically within a few hours of the publisher posting, often much sooner for active sources. RSS adds your reader's own refresh interval on top. The digest batches to its cadence by design.

### Can I cut the noise down?

Several dials: follow specific products instead of whole orgs, subscribe to a single source's feed instead of the org's, or set `releaseType: "feature"` on a webhook to skip rollup-style entries like routine version bumps.

### Do I need an account?

Only for the follow-based channels (Slack, digest, personal feed, webhooks). Public `.atom`, `.json`, and `.md` feeds and the MCP server's read tools work with no account at all.

### What if a product I want isn't indexed?

[Submit it](/submit), or if it's your product, [get listed](/docs/listing). Once a source is in the index, every channel on this page works for it — including changelogs that publish no feed or API of their own.

### Can one webhook feed multiple channels?

Yes — that's the relay pattern. One follows-scoped webhook into a small worker or automation platform can fan out to Discord, Teams, a database, and a dashboard at once, with your own formatting per destination.
