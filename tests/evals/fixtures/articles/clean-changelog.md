[Skip to content](#main)

[Acme](/) [Product](/product) [Docs](/docs) [Pricing](/pricing) [Blog](/blog) [Sign in](/login)

- [Changelog](/changelog)
- [Roadmap](/roadmap)
- [Status](https://status.acme.dev)

# Scheduled exports are now generally available

_April 18, 2026 · Platform_

You can now schedule recurring exports of any saved view to S3, GCS, or a webhook. Set a cadence (hourly, daily, weekly), pick a destination, and Acme delivers a fresh snapshot without anyone clicking a button.

## What's new

- **Cron-style schedules.** Pick from presets or supply a raw cron expression.
- **Three destinations.** S3, Google Cloud Storage, and signed webhooks are supported at launch.
- **Delivery receipts.** Every run records bytes written, row count, and duration on the export's history tab.

## Upgrade notes

Existing manual exports keep working unchanged. To schedule one, open the export, click **Automate**, and choose a cadence. Scheduled exports count against your monthly export quota.

---

Subscribe to the changelog via [RSS](/changelog.rss) or [email](/subscribe).

© 2026 Acme, Inc. · [Terms](/terms) · [Privacy](/privacy) · [Twitter](https://twitter.com/acme)
