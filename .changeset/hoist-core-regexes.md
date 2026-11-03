---
"@buildinternet/releases-core": patch
---

Compile the regexes used inside loops in `fts`, `version-sort`, `domain`, and the changelog frontmatter parser once at module load instead of on every iteration. No behavior change.
