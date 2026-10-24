---
"@buildinternet/releases": patch
"@buildinternet/releases-api-types": minor
---

The CLI's org, product and source lookups, the org list, and `releases publish` now go through `@buildinternet/releases-sdk`, typed against the API's wire shapes. That surfaced fields the CLI printed but the API never sent: `releases org get` now shows real Created/Updated times, `releases source show` shows the fetch priority, and `releases org list` replaces its always-empty Updated column with the last release date. In api-types, `OrgDetail` gains `createdAt` / `updatedAt` and types `id` as always present, and `SourceDetail` gains `fetchPriority`.
