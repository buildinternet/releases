---
title: "Status"
description: "How to check the operational health of releases.sh."
---

# Status

Live service health is exposed via the API.

- **API health:** `GET https://api.releases.sh/v1/health` — returns `{ status: "ok" }` when the API and its downstream dependencies are healthy.
- **Cron and ingest activity:** operators can inspect recent cron runs and per-source fetch state through the internal dashboard at `/status` (admin flag required).

For incident history or to report a user-visible outage, email [hi@releases.sh](mailto:hi@releases.sh).
