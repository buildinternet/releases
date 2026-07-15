---
"@buildinternet/releases-core": minor
---

Bias org overview release selection toward high-signal releases. Every
truncation stage in `selectReleasesForOverview` (per-source cap, per-kind family
cap, per-product budget, and the global limit) now leads with releases scored
`importance >= 4` (the web flame threshold) before falling back to recency, so a
breaking change or major launch published earlier in the window survives the
caps instead of being crowded out by later churn. A binary high/normal lead with
recency as the spine within each tier; NULL importance is treated as unknown
(folded into the normal bucket), never dropped for being unscored.
