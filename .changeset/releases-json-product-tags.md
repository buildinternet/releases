---
"@buildinternet/releases-api-types": minor
---

Allow `tags` on `products[]` entries in the `releases.json` v2 manifest. Product tags mirror the existing org-level `tags` (array of 1–60 char strings, max 50) and are reconciled additively into the existing `product_tags` association — never subject to the no-clobber precedence rule, so a manifest can only add product tags, never remove a curator's. The generated JSON Schema (`https://releases.sh/schemas/releases.json`) is regenerated to match.
