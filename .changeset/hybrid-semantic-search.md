---
"@buildinternet/releases": minor
---

Hybrid semantic search now spans releases, registry entities (orgs, products, sources), and chunked source CHANGELOG files, powered by Cloudflare Vectorize and Voyage embeddings. `search_releases` gained a `mode: "lexical" | "semantic" | "hybrid"` parameter (default `hybrid`) and every hit carries a `kind: "release" | "changelog_chunk"` discriminator so chunk matches interleave with release matches. A new `search_registry` MCP tool does semantic lookup across orgs, products, and sources, and `GET /v1/search` accepts the same `mode` param. Writes now fire embeddings automatically via `waitUntil` — release inserts, org/product/source mutations, and changelog refreshes queue non-fatally and fall back to backfill on failure.

To adopt on an existing deployment, set `VOYAGE_API_KEY` as a worker secret, run `scripts/create-vectorize-indexes.sh` to provision the three new Vectorize indexes, and backfill with the new `releases admin embed {releases,entities,changelogs,status}` commands (admin-gated, backed by `POST/GET /v1/admin/embed/*`). Deployments that skip provisioning keep working — search transparently falls back to lexical with `degraded: true` in the response. Agents that pattern-match the old `search_releases` text format should add handling for the `kind` discriminator.
