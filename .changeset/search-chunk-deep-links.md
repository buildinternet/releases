---
"@buildinternet/releases": patch
---

Web search now renders `changelog_chunk` hits distinctly from release hits and deep-links them into the source's changelog tab. Chunk hits show a `CHANGELOG` badge with the section heading and a monospace snippet; clicking one navigates to `/<org>/<source>?tab=changelog&offset=<chunkOffset>#chunk`, and the changelog view starts its initial slice at that offset so the user lands on the matched section (snapped forward to the nearest `##` heading by the range API). The `/v1/search` route now emits `score` on release hits and `orgSlug` on chunk hits so the web can re-interleave both kinds into one ranked list.
