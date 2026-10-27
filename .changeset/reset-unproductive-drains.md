---
"@buildinternet/releases-api-types": patch
---

`PATCH` source updates accept `unproductiveDrains`, so an operator can reset the drain-convergence counter directly. Moving `fetchPriority` off `paused` clears the counter unless the same request sets it.
