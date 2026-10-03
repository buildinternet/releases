---
"@buildinternet/releases-core": minor
---

Add `@buildinternet/releases-core/changelog-publish`, the shared planner for publishing a changelog. It plans single-file `##` sections and directory/frontmatter entries, diffs against a since-SHA snapshot, and builds the `upsert-content` batch body the publish-changelog Action posts. `releases publish` will call the same API.
