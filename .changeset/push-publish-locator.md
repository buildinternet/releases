---
"@buildinternet/releases-core": minor
"@buildinternet/releases-api-types": minor
---

Push-publish locators in releases.json. A `github` entry can set `publish: "push"` and a `path` (changelog file or glob) to say the owner publishes that changelog instead of the registry polling it. Core stores `publish` and `path` on `release_locations` so the declaration survives stub promotion. API types accept the locator and return the follow-up setup steps from listing validate.
