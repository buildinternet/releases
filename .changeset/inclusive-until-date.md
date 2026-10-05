---
"@buildinternet/releases-core": patch
---

`resolveDateParam` takes an optional `{ bound: "end" }`: a bare date then resolves to the last millisecond of that UTC day, so an `until` of `2026-06-25` includes June 25. It also now rejects impossible calendar dates like `2026-02-30` instead of rolling them over to the next month.
