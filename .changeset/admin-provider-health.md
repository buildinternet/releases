---
"@buildinternet/releases-api-types": minor
---

Add `ProviderHealthSource` and `ProviderHealthResponse` — the wire shape for
`GET /v1/admin/sources/health`, which reports active sources whose
`last_fetched_at` has stopped moving.

The distinction this encodes is deliberate: a source is judged by when it was
last **successfully evaluated**, not when it last produced a release. A source
checked an hour ago with nothing new is healthy; a source whose check timestamp
froze three days ago is broken, however recently it happened to publish. Reading
staleness off release cadence is what let the 2026-07-23 provider outage look
like an ordinary quiet stretch for six days.

`ProviderHealthResponse` carries per-source detail plus aggregate meta
(`totalActiveSources`, `overdueSources`, `overdueOrgs`, `totalOrgs`) — the org
spread is what separates one wedged source from a systemic outage. Additive;
existing responses are unaffected.
