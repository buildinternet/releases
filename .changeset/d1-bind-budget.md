---
"@buildinternet/releases-core": patch
---

Add bind-budget helpers (`maxChunkLength`, `chunkForBindBudget`, `assertBindBudget`) so a prepared statement can be chunked under D1's 100-parameter cap.
