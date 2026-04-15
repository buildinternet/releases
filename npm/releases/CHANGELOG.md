# @buildinternet/releases

## 0.11.0

### Minor Changes

- ed7a44c: Added token-budgeted slicing to the CHANGELOG reader. The REST route, MCP tool, and CLI command all accept a new `tokens` parameter (cl100k_base via `js-tiktoken`) alongside the existing char-based `limit`. When passed, the slicer walks heading boundaries forward under the token budget with the same snap-and-overshoot rules as char mode, so chaining `nextOffset` still reconstructs the full file exactly.

  Every response now includes `totalTokens` (cached per file in the new `source_changelog_files.tokens` column, populated on every fetch). Token-mode responses also include `sliceTokens` for the returned chunk, so agents can plan context windows precisely. Recommended brackets: 2000 / 5000 / 10000 / 20000.

  - CLI: `releases admin source changelog <slug> --tokens 5000`
  - REST: `GET /v1/sources/:slug/changelog?tokens=5000`
  - MCP: `get_source_changelog({ source, tokens: 5000 })`

  `tokens` takes precedence over `limit` when both are passed. A 256KB safety cap in `countTokensSafe` falls back to a chars/4 heuristic for pathologically large or repetitive input to keep request latency bounded.

- a6f2cc5: CLI table outputs now expose the identifiers needed to drill into any row. `releases show <org>`, `releases latest`, `releases search`, and `releases admin source fetch-log` render short release IDs and `Name (slug)` source labels so every row can be copied straight into `releases show` or `releases latest`. `releases show <product>` also resolves the parent org slug instead of printing a raw `org_…` ID.

  Added follow-up command hints to `releases latest`, `releases search`, `releases list`, `releases admin source fetch-log`, `releases admin org show`, and `releases show <product>` so users always know where to drill next.

- 6103e51: `releases show <org>` now lists the org's 10 most recent releases inline instead of returning bare metadata, and the output no longer points users at admin-only commands. Also enriches `releases show <release-id>` with the content summary, and updates the product hint to a public command.
- 6f7c47d: Adds anonymous usage telemetry for the CLI and local MCP stdio server. Each invocation records command name, CLI version, OS/arch, runtime, exit code, and duration against a stable anonymous ID at `~/.releases/telemetry-id` — no arguments, flag values, paths, slugs, or content are ever sent. Events carry a `clientKind` so external usage can be distinguished from internal agents, sandboxes, CI, and MCP stdio traffic, and an optional `sessionId`/`model` for attribution back to managed agent sessions.

  Opt out with `releases telemetry disable`, `RELEASED_TELEMETRY_DISABLED=1`, or `DO_NOT_TRACK=1`. A one-time first-run notice prints to stderr on external clients. New `releases telemetry status/enable/disable` commands manage the local state.

- f21f52c: Hybrid semantic search now spans releases, registry entities (orgs, products, sources), and chunked source CHANGELOG files, powered by Cloudflare Vectorize and Voyage embeddings. `search_releases` gained a `mode: "lexical" | "semantic" | "hybrid"` parameter (default `hybrid`) and every hit carries a `kind: "release" | "changelog_chunk"` discriminator so chunk matches interleave with release matches. A new `search_registry` MCP tool does semantic lookup across orgs, products, and sources, and `GET /v1/search` accepts the same `mode` param. Writes now fire embeddings automatically via `waitUntil` — release inserts, org/product/source mutations, and changelog refreshes queue non-fatally and fall back to backfill on failure.

  To adopt on an existing deployment, set `VOYAGE_API_KEY` as a worker secret, run `scripts/create-vectorize-indexes.sh` to provision the three new Vectorize indexes, and backfill with the new `releases admin embed {releases,entities,changelogs,status}` commands (admin-gated, backed by `POST/GET /v1/admin/embed/*`). Deployments that skip provisioning keep working — search transparently falls back to lexical with `degraded: true` in the response. Agents that pattern-match the old `search_releases` text format should add handling for the `kind` discriminator.

- 909812e: Source detail pages now include "Related releases" and "Related sources" rails, powered by the existing Vectorize indexes. Two new public-read endpoints back the rails: `GET /v1/related/releases?release=<id>&scope=org|global&limit=N` pulls the anchor release's vector from `releases-v1` and queries for semantically similar releases, and `GET /v1/related/sources?source=<slug|id>&scope=org|global&limit=N` does the same via `entities-v1`. `scope=org` applies a Vectorize metadata filter on `org_id`; `scope=global` (default) skips the filter. Both endpoints exclude the anchor from its own result set and degrade gracefully — if Vectorize bindings are missing, `getByIds` isn't supported, or the anchor hasn't been embedded yet, the response is `{ degraded: true, items: [] }` and the web rails render nothing.

  The entity embed pipeline (`src/lib/embed-entities.ts`) now accepts an optional `orgId` and writes it to Vectorize metadata as `org_id` so the scope filter is populated for new writes. **Existing deployments need a one-shot backfill** of the entity index to populate `org_id` on already-embedded rows: run `releases admin embed entities` against the API worker. Release vectors already carried `org_id` so no release backfill is required. Provisioning the metadata indexes themselves is handled by `scripts/create-vectorize-indexes.sh`, which now also creates metadata indexes for `releases-v1.org_id`, `releases-v1.source_id`, `entities-v1.org_id`, and `entities-v1.type`. Run the script once against your Cloudflare account before the rails can filter by scope.

### Patch Changes

- b8758d4: `releases search` now accepts `--mode <lexical|semantic|hybrid>` to opt into a specific search backend (matches the `/v1/search` and MCP `search_releases` surface). Default remains unset so the server picks its `hybrid` default. Invalid values are rejected with a clear error. Local mode has no Vectorize, so `semantic` / `hybrid` emit a stderr warning and fall through to lexical (mirrors the server's `degraded: true` pattern). `--json` output now includes the server-reported `mode`, `degraded`, and `degradedReason` fields when present.
- 40e2497: Adds an optional per-IP rate limiter for unauthenticated public reads on the hosted API. Gated by a `RATE_LIMIT_ENABLED` worker var that defaults to off, so the initial deploy is a no-op. Callers presenting a valid API key bypass the limiter, so CLI and MCP tooling in remote mode are never throttled. Throttled requests receive a 429 with a `Retry-After` header.
- 9156d4b: Web search now renders `changelog_chunk` hits distinctly from release hits and deep-links them into the source's changelog tab. Chunk hits show a `CHANGELOG` badge with the section heading and a monospace snippet; clicking one navigates to `/<org>/<source>?tab=changelog&offset=<chunkOffset>#chunk`, and the changelog view starts its initial slice at that offset so the user lands on the matched section (snapped forward to the nearest `##` heading by the range API). The `/v1/search` route now emits `score` on release hits and `orgSlug` on chunk hits so the web can re-interleave both kinds into one ranked list.
