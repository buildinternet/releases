---
"@buildinternet/releases-core": minor
"@buildinternet/releases-api-types": minor
---

Owner-scoped publish tokens (#2373). Core adds `PUBLISH_SCOPE` (`"publish"`, deliberately off the `read ⊂ write ⊂ admin` ladder) and a nullable `api_tokens.source_id` column. API types add the `/v1/me/publish-tokens` shapes: `CreatePublishTokenBody`, `CreatedPublishToken`, `PublishToken`, `ListPublishTokensResponse`, and `RevokePublishTokenResponse`.
