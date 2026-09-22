---
"@buildinternet/releases-api-types": minor
---

Add marketing-classifier threshold wire types for `GET/PUT /v1/admin/marketing-classifier` (operator-editable suppression threshold + filtered-source listing). Widen `ClassificationSummary.probability.threshold` from the `0.8` literal to `number` now that the threshold is operator-editable.
