---
title: Send releases to Discord
description: Post new releases to a Discord channel whenever something you follow ships.
---

# Send releases to Discord

Get a Discord message every time an org or product you follow ships a release. There's no bot to
install. You paste a Discord **incoming webhook URL** and Releases Index posts to it.

## 1. Create a Discord incoming webhook

In Discord, open the channel's **Edit Channel → Integrations → Webhooks** (or Server Settings →
Integrations → Webhooks) and create a webhook. Discord gives you a URL that looks like
`https://discord.com/api/webhooks/123456789012345678/abcdefghijklmnopqrstuvwxyz`.

See Discord's [intro to webhooks](https://support.discord.com/hc/en-us/articles/228383668) if you
haven't created one before.

## 2. Connect it on Releases Index

Open [Notifications](/account/notifications), find the **Slack & Discord** section, pick
**Discord**, paste the webhook URL, and click **Connect**. You'll get a Discord message for
everything you follow.

Use the **Test** button to post a sample embed and confirm the channel is wired up.

For a single organization instead, open [Webhooks & API](/account/webhooks), set **Format** to
**Discord message**, choose **Org**, and click **Create**.

## What the message looks like

Each release is posted as a compact Discord embed: a linked title, a short summary, and the
organization's name and avatar. Discord localizes the timestamp to each viewer.

## Keep the URL private

Discord webhooks are **unsigned**: the URL itself is the secret. No signing key is issued and
no signature headers are sent. Treat the URL like a password. To rotate it, remove the Discord
webhook and create a new one with a fresh URL.

## Supported hosts

The URL host must be `discord.com` (or the legacy `discordapp.com`, `canary.discord.com`,
`ptb.discord.com`) and the path must be `/api/webhooks/{id}/{token}`. Other hosts and the
Slack-compat `/slack` suffix are rejected — this format posts a native Discord embed, not a Slack
payload.

## Need more control?

For org-specific alerts, release-type filters, or the raw signed JSON payload, stay on
[Webhooks & API](/account/webhooks) and switch **Format**.
