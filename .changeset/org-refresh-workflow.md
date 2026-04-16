---
"@buildinternet/releases": minor
---

Add org update workflow commands and smarter overview generation. New `releases admin org refresh <slug>` fetches all active sources for an org and regenerates the overview in one step (flags: `--max`, `--concurrency`, `--window`, `--dry-run`, `--skip-overview`, `--json`). New `--org <slug>` filter on `releases admin source fetch` composes with `--stale`, `--changed`, and `--retry-errors` to scope fetches to a single org, and bypasses the remote-mode bulk-fetch block when used alone. Overview generation now caps per-source contributions by type (github: 10, scrape/feed/agent: 20) so high-frequency GitHub sources can't crowd out product changelogs, and `releases admin org show --regenerate` accepts `--window <days>` plus a confirmation log line reporting chars, release count, and window.
