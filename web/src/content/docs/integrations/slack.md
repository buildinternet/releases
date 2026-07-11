---
title: Send releases to Slack
description: Post new releases to a Slack channel whenever something you follow ships.
---

# Send releases to Slack

Get a Slack message every time an org or product you follow ships a release. There's no app
to install. You paste a Slack **incoming webhook URL** and releases.sh posts to it.

## 1. Create a Slack incoming webhook

In Slack, create an [incoming webhook](https://docs.slack.dev/messaging/sending-messages-using-incoming-webhooks/)
for the channel you want releases posted to. Slack gives you a URL that looks like
`https://hooks.slack.com/services/T00000000/B00000000/XXXXXXXXXXXXXXXX`.

## 2. Connect it on releases.sh

Open [Notifications](/account/notifications), find the **Slack** section, paste the webhook
URL, and click **Create**. That's it. You'll get a Slack message for everything you follow.

Use the **Test** button to post a sample message and confirm the channel is wired up.

## What the message looks like

Each release is posted as a compact Slack message: a linked title, a short summary, and a
context line with the organization's avatar and date.

## Keep the URL private

Slack webhooks are **unsigned**: the URL itself is the secret. No signing key is issued and
no signature headers are sent. Treat the URL like a password. To rotate it, remove the Slack
connection and create a new one with a fresh URL.

## Supported hosts

The URL host must be `hooks.slack.com` (standard and Enterprise Grid) or `hooks.slack-gov.com`
(GovSlack). Other hosts are rejected.

## Need more control?

For org-specific alerts, release-type filters, or the raw signed JSON payload, use
[Webhooks & API](/account/webhooks).
