---
"@buildinternet/releases": patch
---

`releases search` now accepts `--mode <lexical|semantic|hybrid>` to opt into a specific search backend (matches the `/v1/search` and MCP `search_releases` surface). Default remains unset so the server picks its `hybrid` default. Invalid values are rejected with a clear error. Local mode has no Vectorize, so `semantic` / `hybrid` emit a stderr warning and fall through to lexical (mirrors the server's `degraded: true` pattern). `--json` output now includes the server-reported `mode`, `degraded`, and `degradedReason` fields when present.
