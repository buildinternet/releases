---
"@buildinternet/releases": minor
"@buildinternet/releases-lib": minor
---

Drop the legacy `RELEASED_*` environment variable names. Use the `RELEASES_*` names (`RELEASES_API_KEY`, `RELEASES_API_URL`, `RELEASES_DATA_DIR`, and so on). `@buildinternet/releases-lib` no longer exports `legacy-env`.
