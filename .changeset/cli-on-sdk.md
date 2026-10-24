---
"@buildinternet/releases": minor
"@buildinternet/releases-api-types": patch
---

The CLI now sends its public API calls (follows, the personalized feed, webhooks, workspaces, release reads, collections, search, domain lookup, changelogs and overviews) through `@buildinternet/releases-sdk`. `releases feed` pages with `--cursor` instead of `--page`, which the API rejects. In api-types, rows of the org and collection release feeds now type `id` as always present, matching what the API returns.
