---
"@buildinternet/releases": minor
---

CLI table outputs now expose the identifiers needed to drill into any row. `releases show <org>`, `releases latest`, `releases search`, and `releases admin source fetch-log` render short release IDs and `Name (slug)` source labels so every row can be copied straight into `releases show` or `releases latest`. `releases show <product>` also resolves the parent org slug instead of printing a raw `org_…` ID.

Added follow-up command hints to `releases latest`, `releases search`, `releases list`, `releases admin source fetch-log`, `releases admin org show`, and `releases show <product>` so users always know where to drill next.
