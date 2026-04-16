---
"@buildinternet/releases": patch
---

Fix the remaining N+1 patterns flagged in the `/v1/orgs/:slug` audit: `getOrgSourcesWithStats` now runs as a single `LEFT JOIN` against a grouped-releases derived table (was 5 correlated subqueries per source row), tag mutations on orgs and products bulk-upsert the tag and join rows in a constant number of roundtrips (was 2× per-tag sequential roundtrips), and the recent-release metrics query for `/v1/orgs/:slug` is folded into the main parallel D1 wave via a scoped subquery.
