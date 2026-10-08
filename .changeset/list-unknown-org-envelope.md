---
"@buildinternet/releases": patch
---

`releases list --org <unknown>` (and `--product <unknown>`) now prints "No sources configured." instead of crashing with `undefined is not an object (evaluating 'pageItems.length')`. The sources client normalizes a bare-array `/v1/sources` response into the paginated envelope when one was requested, so older API deploys that short-circuit unknown filters with `[]` no longer break the command.
