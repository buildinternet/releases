---
"@buildinternet/releases": minor
---

Added token-budgeted slicing to the CHANGELOG reader. The REST route, MCP tool, and CLI command all accept a new `tokens` parameter (cl100k_base via `js-tiktoken`) alongside the existing char-based `limit`. When passed, the slicer walks heading boundaries forward under the token budget with the same snap-and-overshoot rules as char mode, so chaining `nextOffset` still reconstructs the full file exactly.

Every response now includes `totalTokens` (cached per file in the new `source_changelog_files.tokens` column, populated on every fetch). Token-mode responses also include `sliceTokens` for the returned chunk, so agents can plan context windows precisely. Recommended brackets: 2000 / 5000 / 10000 / 20000.

- CLI: `releases admin source changelog <slug> --tokens 5000`
- REST: `GET /v1/sources/:slug/changelog?tokens=5000`
- MCP: `get_source_changelog({ source, tokens: 5000 })`

`tokens` takes precedence over `limit` when both are passed. A 256KB safety cap in `countTokensSafe` falls back to a chars/4 heuristic for pathologically large or repetitive input to keep request latency bounded.
