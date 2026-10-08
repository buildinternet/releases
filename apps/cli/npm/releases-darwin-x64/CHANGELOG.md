# @buildinternet/releases-darwin-x64

## 0.83.1

## 0.83.0

## 0.82.0

## 0.81.1

## 0.81.0

## 0.80.1

## 0.80.0

## 0.79.0

## 0.78.1

## 0.78.0

## 0.77.0

## 0.76.0

## 0.75.0

## 0.74.1

## 0.74.0

## 0.73.1

## 0.73.0

## 0.72.0

## 0.71.0

## 0.70.1

## 0.70.0

## 0.69.0

## 0.68.0

## 0.67.3

## 0.67.2

## 0.67.1

## 0.67.0

## 0.66.0

## 0.65.0

## 0.64.0

## 0.63.0

## 0.62.1

## 0.62.0

## 0.61.0

## 0.60.0

## 0.59.0

## 0.58.0

## 0.57.0

## 0.56.0

## 0.55.0

## 0.54.0

## 0.53.0

## 0.52.0

## 0.51.0

## 0.50.0

## 0.49.0

## 0.48.0

### Patch Changes

- 9e3147f: `releases admin overview get` now shows the overview's most recent update time when it differs from the original generation time, while keeping the release and citation counts in the summary line.

## 0.47.0

### Minor Changes

- 5c6b819: Add `--max-content-chars [n]` to `releases admin overview inputs`. In `--json` mode it clips each `selected[].content` to at most `n` characters client-side before printing (bare flag defaults to 1000), leaving every other field — `existingContent`, `media`, `totalAvailable`, and the `selected` length itself — untouched. High-volume orgs emit 500K+ chars of full release content here (sentry's largest single release is ~125K), which exceeds the ~30K Bash stdout cap a Claude Code sub-agent reads through and gets silently truncated, so the overview would be generated from only the first few releases. The clip is purely client-side — the CLI still receives the full payload over the wire — so it removes that footgun without the multi-step `jq` workaround. Omitting the flag preserves today's full-content output.

## 0.46.0

### Minor Changes

- f38f166: Add `releases admin work start <batch>` / `status` / `end` and a sticky run-dir pointer for the maintenance workspace. `RELEASES_RUN_DIR` auto-captures admin mutations into `mutations.jsonl` and defaults the managed-session trace dir, but a one-time `export` doesn't survive an agent harness (each shell is fresh), so logging silently stopped after the first command. `work start` creates `~/.releases/work/runs/<ts>-<batch>/` (honoring `RELEASES_DATA_DIR`) and writes a sticky `~/.releases/work/.current-run` pointer; the CLI now resolves the active run as `RELEASES_RUN_DIR` env → `.current-run` pointer → none, so mutation logging and the trace-dir default work across separate invocations with no env threading. Explicit `RELEASES_RUN_DIR` still wins. `work status` prints the run dir, where it came from, and a mutations/sessions tally; `work end` clears the pointer.

### Patch Changes

- 3f70b35: `releases admin overview update` now always HTML-entity-decodes the content body before uploading. The five entities sub-agents reflexively over-escape when relaying markdown (`&amp;`, `&lt;`, `&gt;`, `&quot;`, `&#39;` — e.g. `Q&amp;A`, `streams.input&lt;T&gt;`) are a transport artifact, not authored content, and the API stores the body verbatim — so an un-decoded entity rendered wrong. The decode is single-pass and idempotent, so an already-clean body (including one a caller pre-decoded to compute citation offsets) is unchanged. `--unescape-html` is now the default and kept as an accepted no-op flag for back-compat.
- dc7c707: `releases admin overview get` now surfaces inline citations. The table line includes a citation count alongside the release count, and `--json` adds `citationCount` plus the full `citations` array. The org overview GET already returns citations ordered by character position — this exposes them so a post-write `overview get` can verify what `overview update` reported (which echoes `citations: N`) without a re-write.

## 0.45.0

## 0.44.0

## 0.43.0

## 0.42.0

## 0.41.0

## 0.40.1

## 0.40.0

## 0.39.0

## 0.38.1

## 0.38.0

## 0.37.0

## 0.36.0

## 0.35.3

## 0.35.2

## 0.35.1

## 0.35.0

## 0.34.0

## 0.33.0

## 0.32.0

## 0.31.0

## 0.30.0

## 0.29.0

## 0.28.1

## 0.28.0

## 0.27.0

## 0.26.0

## 0.25.0

## 0.24.0

## 0.23.0

## 0.22.1

## 0.22.0

## 0.21.0

## 0.20.2

## 0.20.1

## 0.20.0

## 0.19.5

## 0.19.4

## 0.19.3

## 0.19.2

## 0.19.1

### Patch Changes

- caf3cdc: **Fix `releases admin embed {releases,entities,changelogs}` after monorepo route consolidation**

  The API worker moved the three embed-backfill triggers from `/v1/admin/embed/*` to `/v1/workflows/embed-*` in [buildinternet/releases#494](https://github.com/buildinternet/releases/issues/494). Without this bump, those three commands return `404` against the live API.

  Changes:

  - `embedReleases` now posts to `/v1/workflows/embed-releases`
  - `embedEntities` now posts to `/v1/workflows/embed-entities`
  - `embedChangelogs` now posts to `/v1/workflows/embed-changelogs`
  - `getEmbedStatus` stays on `/v1/admin/embed/status` (telemetry reads were not moved)

  The `releases admin embed …` command surface is unchanged — the path rename is invisible to users.

## 0.19.0

### Minor Changes

- e04effe: **Skills synced to the monorepo's consolidated tool surface**

  Mirrors the tool-UX consolidation from the monorepo (upstream issue [buildinternet/releases#459](https://github.com/buildinternet/releases/issues/459)). Deprecated per-action tool names are replaced with the consolidated equivalents across every skill that cited them.

  Typed-tool renames:

  - `add_source` / `edit_source` / `remove_source` / `fetch_source` → `manage_source` with `action: "add" | "edit" | "remove" | "fetch"`
  - `get_playbook` / `update_playbook_notes` → `manage_playbook` with `action: "get" | "update_notes"`
  - `list_categories` — retired; valid categories surface via `manage_org` / `manage_product` tool descriptions and system prompts

  Skill-specific changes:

  - `managing-sources` — Primary Sources section rewritten with conditional `is_primary` guidance, added a note about the slug auto-suffix behavior on `manage_source(action=add)`, ported the Organization Descriptions + Embedding Side Effects sections from upstream.
  - `seeding-playbooks` and `parsing-changelogs` — replaced the stale `releases admin content playbook` CLI path with `releases admin playbook` (the `content` subgroup was removed in #42).
  - `analyzing-releases` and `finding-changelogs` — call-site updates only.

  No CLI behavior changes.

## 0.18.0

## 0.17.0

### Minor Changes

- eaeb755: **`releases admin discovery evaluate <url>` is back**

  Ships the missing thin wrapper around `GET /v1/evaluate?url=...`, returning the AI-backed ingestion recommendation (method, feed URL, provider, confidence, alternatives). Supports `--json` for piping into `jq`. Mirrors the typed MCP `evaluate_url` tool.

  The legacy top-level alias `releases evaluate <url>` still resolves to this subcommand (with a deprecation warning).

  The stale `discover` entry in the legacy alias table has been removed — it pointed to a subcommand that never existed, and the API's `POST /v1/discover` is already covered by `releases admin discovery onboard`. The one in-repo docs reference has been updated.

- 51ec406: **`releases admin playbook <org>` is back**

  Ships the missing CLI wrapper for reading and updating an organization's playbook. Same shape as the old monorepo command, flattened from `admin content playbook` to `admin playbook` (no other live inhabitants of the `admin content` subgroup remain).

  - `releases admin playbook <org>` — read the assembled playbook (header + agent notes)
  - `releases admin playbook <org> --json` — JSON output
  - `releases admin playbook <org> --notes "..."` — replace agent notes; seeds a fresh header on first write

  The old `--regenerate` flag is not being ported. It called deterministic logic (no AI) that already runs automatically via `waitUntil` after every source add/edit/remove, and the `--notes` PATCH route auto-seeds a fresh header if no playbook exists yet.

  Closes buildinternet/releases#246.

## 0.16.1

### Patch Changes

- 8c3a579: Fix `--json` output being truncated at ~96 KB when piped to another process. All JSON output now awaits stdout `drain` before the CLI exits, so piping `releases admin source list --json | jq ...` works correctly on large datasets.

## 0.16.0

### Minor Changes

- 7e617c7: **CLI JSON contract: shared envelope, parsed metadata, truncation warnings**

  `releases list --json` now returns a consistent `{ items, pagination }` envelope whether or not `--limit` is passed, parses `metadata` into a nested object (no more `.metadata | fromjson?` in jq), and emits a stderr warning when results may be truncated.

  - **New shared types** in `@buildinternet/releases-core/cli-contracts`: `ListResponse<T>`, `Pagination`, `DEFAULT_PAGE_SIZE`, `computePagination()`, `parseMetadataField()`, `formatTruncationWarning()`. Single source of truth for the CLI's `--json` output shape.
  - **Default page size is now 500** (previously 100, the API's silent default) so a default `releases list --json` call returns 5× more rows before any risk of truncation. Explicit `--limit` still wins.
  - **Metadata fields are parsed** into nested objects in `--json` output for both the list view and single-source detail view.
  - **Stderr truncation warning** when no `--limit` was passed and `hasMore` is true — no more silent loss of rows.
  - **`--flat` flag** returns the legacy bare-array shape for scripts still tied to it. Not recommended; use the envelope.
  - **Server-side pagination** — `--limit` and `--page` are now passed through to the API instead of applied client-side to an already-truncated result set.

  Fixes buildinternet/releases-cli#24 (CLI side). An API-side follow-up will add an opt-in envelope response so `totalItems` can be populated for every page; until then `totalItems` is only set when the tail of the list is reached.

- 94e05dc: **Add `releases whoami` — mode, API URL, and auth diagnostic**

  New top-level command that reports how the CLI is configured:

  - Current CLI version
  - API URL and whether it's the default (`https://api.releases.sh`) or overridden via `RELEASED_API_URL`
  - Mode (`public` vs `admin`) based on whether `RELEASED_API_KEY` is set
  - Redacted API key hint (first 4 + last 4 characters) so users can confirm which key is active without leaking it
  - Optional `--check` flag that probes the API — a public read in public mode, an auth-gated read in admin mode, so an invalid key surfaces as a 401 instead of a silent success
  - `--json` flag for machine-readable output

### Patch Changes

- 2da36c8: **`releases list --json` now surfaces accurate `totalItems` on every page**

  The API's `?envelope=true` response is now consumed end-to-end: `totalItems`, `totalPages`, and `hasMore` are populated on the first page as well as the tail, instead of only when the final page is reached. The stderr truncation warning on the table view now uses the API-returned `hasMore` instead of inferring from `returned === pageSize` (which flagged spuriously when totalItems was an exact multiple of pageSize).

  - `listSourcesWithOrg({ envelope: true })` returns `ListResponse<SourceWithOrg>` via a typed overload; existing bare-array callers (`check`, MCP) are untouched.
  - Closes the loop opened by the API's envelope support (buildinternet/releases#356).

## 0.15.0

## 0.14.0

## 0.13.2

### Patch Changes

- 3d4df61: Pin CI to bun canary to pick up oven-sh/bun#29272 — fixes `bun build --compile` producing Mach-O binaries that Apple Silicon SIGKILLs on exec due to a broken LC_CODE_SIGNATURE size in bun 1.3.12. Also leapfrogs the npm version timeline past the orphaned `@buildinternet/releases@0.13.0` left behind during the monorepo → OSS repo extraction.

## 0.12.1

### Patch Changes

- ef08acb: Bootstrap public tap distribution — first release cut from the extracted OSS repo. Publishes binaries to `buildinternet/releases-cli` GitHub Releases and regenerates the Homebrew formula at `buildinternet/homebrew-tap`.
