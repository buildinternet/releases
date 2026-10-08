# @buildinternet/releases

## 0.83.2

### Patch Changes

- d6d2c30: The CLI is now built and published from the `buildinternet/releases` monorepo. Install commands are unchanged; GitHub release binaries and the Homebrew formula now point at that repo.
- 5deafce: `releases list --org <unknown>` (and `--product <unknown>`) now prints "No sources configured." instead of crashing with `undefined is not an object (evaluating 'pageItems.length')`. The sources client normalizes a bare-array `/v1/sources` response into the paginated envelope when one was requested, so older API deploys that short-circuit unknown filters with `[]` no longer break the command.

## 0.83.1

### Patch Changes

- a69c3d6: Skills and the Claude Code plugin now install from `buildinternet/releases` (the monorepo). `releases skills install` and the update check point there; installs made from `buildinternet/releases-cli` are still recognised.
- a7598a1: `--since` / `--until` now reject impossible calendar dates like `2026-02-30` locally (exit code 2) instead of sending them to the API, which returns a 400 for them.

## 0.83.0

### Minor Changes

- 03e8198: Add `releases publish` so GitLab CI, Buildkite, and local docs builds can push changelog updates with `RELEASES_API_TOKEN`, using the same plan as the publish-changelog GitHub Action.

  `releases json validate` accepts `publish: "push"` changelog locators from the current releases.json schema.

## 0.82.0

### Minor Changes

- 47efef1: Add `--official` / `--no-official` to `releases admin oauth client create`, a new `releases admin oauth client update` command for the `official`, `trusted` and `disabled` flags, and show `official` in `client list` / `get` output. The flag controls the "Verified by Releases Index" badge on the consent page and needs an API with buildinternet/releases#2421. An older API ignores `official` on create and rejects an `update` that sets only `official`.

## 0.81.1

### Patch Changes

- caf3ae1: Point the Claude plugin at the `agents.releases.sh/mcp` endpoint and add documentation, support and terms links to its manifest.
- 9eff9b1: Document which Releases.sh services the Claude plugin reaches and what they keep.
- 0767e87: Move the agent skills into the self-contained Claude plugin folder (`plugins/claude/releases/skills/`) so the plugin passes Claude plugin directory validation. `npx skills add buildinternet/releases-cli` finds them at the new path, and the skills update check now reads that path.

## 0.81.0

### Minor Changes

- 7237636: `releases login` no longer keeps a signed-in browser session on disk — only the read-only API key it mints. `releases keys` and `releases publish-token` now open a fresh one-time browser approval for each command and sign that session back out as soon as the command finishes, instead of reusing a stored session; every subcommand takes `--no-browser` (same as `login`) to print the URL + code instead. `releases auth logout` revokes the stored key directly (no browser approval needed) and always removes the local credential, even if the server-side revoke fails. A credential file saved before this change is upgraded in place: any leftover session token is signed out and stripped the next time it's touched.

## 0.80.1

### Patch Changes

- d28f481: Fix `releases login` leaking a new `relu_` key on every run. It now remembers the minted key's id and revokes the key it replaces once the new one is safely stored. When the server's active-key limit is hit, the error names the commands to list and revoke keys. `releases auth logout` also revokes the stored key server-side, best-effort. Fixes #418.

## 0.80.0

### Minor Changes

- f591610: Add `releases publish-token create/list/revoke` for minting a `relk_` token scoped to one source (used by the `publish-changelog` GitHub Action as `RELEASES_API_TOKEN`), matching `POST/GET/DELETE /v1/me/publish-tokens[/:id]`. Companion to buildinternet/releases#2388.

## 0.79.0

### Minor Changes

- d58db28: `releases admin discovery onboard` no longer starts a remote discovery session. The discovery worker and `POST /v1/workflows/discover` were retired (buildinternet/releases#2352); the command now exits 1 with a pointer to `releases admin org create`, `releases admin source create`, and the `local-ingest` skill. `onboard apply` and the `--managed-agents` / `--sandbox` engine flags are removed.

## 0.78.1

### Patch Changes

- f8f6646: Fix the macOS binaries being killed on launch. They are now built on macOS and ad-hoc code-signed; v0.77.0 and v0.78.0 shipped with invalid signatures, which macOS 27 enforces (`brew upgrade` failed while generating shell completions).

## 0.78.0

### Minor Changes

- b1e47d9: Add `--workspace <id-or-slug>` to `releases webhook list/add/show/edit/remove/test/rotate-secret` for managing a shared workspace-owned webhook instead of your own, and a new `releases workspace list` command to find a workspace's id, slug, and your role in it (#406).

## 0.77.0

### Minor Changes

- e68e6ac: Add `--format discord` to `releases webhook add`/`edit` to deliver releases as formatted Discord embeds via a Discord incoming webhook URL. Human-readable webhook output redacts the delivery URL (the secret for Slack/Discord); `--json` still includes it.

## 0.76.0

### Minor Changes

- a279404: Add `releases admin recommendations notify-added` so operators can opt in to emailing a submitter that their suggested source was added to the registry.

## 0.75.0

### Minor Changes

- a060d4d: Add `releases changelog` to print recent product updates from releases.sh (the self-published `releases-sh` feed) and a link to https://releases.sh/updates. Also available as the local MCP `changelog` tool.

## 0.74.1

### Patch Changes

- 17b9d2d: Route `feedback`, `submit`, and `keys` through the shared `apiFetch` transport instead of each rolling its own `fetch` call. `apiFetch` gained an opt-in `skipDefaultAuth` flag so a caller-supplied `Authorization` header (used by `keys`' session-token flow) isn't overwritten by a configured admin/API key. Error messages, idempotency behavior, and command output are unchanged.

## 0.74.0

### Minor Changes

- a19a535: Send an `Idempotency-Key` header on effectful write requests (feedback submit, webhook create/rotate-secret/test, API-key mint) so a retry after a network failure replays the original response instead of double-submitting. A key reused with a different payload now surfaces a clear `idempotency_conflict` message instead of a raw 409.

## 0.73.1

### Patch Changes

- 7fe55de: `source backfill --dry-run` now reports how much of the extracted history the source doesn't already have, as `N not yet stored`. Previously the dry-run line reported only how many entries were on the page, which said nothing about whether any of them were missing — during the 2026-07-23 ingest outage that gap let a run over a source missing its entire recent history read as uneventful. Requires an API worker carrying the new `notStored` field; against an older server the clause is omitted rather than guessed. The report type also catches up with the server: `inserted` is `null` on a dry run (nothing was written, no count computed) rather than a fabricated `0`.
- b124608: Fix `getApiUrl()` memoizing the API base URL process-wide on first call. Under `bun test`, every test file shares one process, so whichever file called it first locked the base URL for the rest of the run — files that set `RELEASES_API_URL` afterward got the stale (production) URL instead and their assertions failed. This was silently CI-red on `main` (22 tests failing) because CI's clean environment produces a call order that trips the memoization, while a developer machine with real credentials hits a different, unrelated set of failures. `getApiUrl()` now re-resolves from the environment on every call instead of caching.
- f7a1b54: Fix `releases stats` reporting every source as never-fetched with zero recent releases. The command composed its summary from the legacy flat fields of `/v1/stats` and hardcoded source health, `releasesInPeriod`, and every `lastFetchedAt` to `0`/`null` — a stale workaround from before the endpoint returned the full `StatsSummary` shape. It now reads the server's real values, so the output reflects actual ingestion health instead of implying the index is dead.

## 0.73.0

### Minor Changes

- 88999c9: `releases search --json` now passes AI-scored `importance` (1–5) through in the slim search-hit shape, normalized to `null` when unscored — same norm as `get` / `tail` / `latest`. The TTY search table also marks importance ≥ 4 with the quiet glyph. Bumps `@buildinternet/releases-api-types` to `^0.48.0` for the search/related/digest wire field (monorepo #2135).

### Patch Changes

- e97462a: Surface a NODE_EXTRA_CA_CERTS / SSL_CERT_FILE hint on TLS certificate verification failures, and document custom-CA support (TLS-intercepting proxies) in the README.

## 0.72.0

### Minor Changes

- 0b1a45e: Remove the deprecated `get_source_changelog` tool from the local stdio MCP bridge. It was deprecated in 0.71.0 in favor of `get_catalog_entry` with the `changelog_*` params (`include_changelog` / `changelog_path` / `changelog_offset` / `changelog_limit` / `changelog_tokens`); calling `get_source_changelog` by name now returns MCP's standard unknown-tool error. The REST helper `sourceChangelog()` is unchanged — `get_catalog_entry` and the `admin source changelog` CLI command still use it.
- e7d50b4: `releases search` gains `--category <slug>` and `--collection <slug>` filters. `--category` scopes hits to organizations in a category (the API validates and resolves curator aliases like `e-commerce` → `commerce`, so the value is forwarded as-is); `--collection` scopes to a curated collection's member orgs (unknown slugs report "no collection matching …", mirroring `--domain`). Both forward to the new `/v1/search` params and compose with the existing `--domain` / `--product` / `--kind` / `--since` / `--until` scopes.
- 2d4b707: Surface the registry's AI-scored release `importance` (1–5, `null` when unscored). `tail`/`latest` gains `--min-importance <1-5>` (forwarded as `?minImportance=`); the human table marks importance ≥4 with a quiet glyph (outline at 4, solid at 5), mirroring the web's render threshold, while `--json` output (`get`/`tail`/`latest`) passes the raw score through verbatim, including `null`. Bumps the `@buildinternet/releases-api-types` and `@buildinternet/releases-core` pins to the versions that carry the `importance` field.

## 0.71.0

### Minor Changes

- 735ba8a: The local stdio MCP bridge's `get_catalog_entry` tool now accepts `include_changelog`, `changelog_path`, `changelog_offset`, `changelog_limit`, and `changelog_tokens` — matching the hosted server at mcp.releases.sh — so a source entry's tracked CHANGELOG can be inlined or sliced in the same call, without a separate lookup. `changelog_tokens` takes precedence over `changelog_limit`, and any `changelog_*` param implies `include_changelog`; the params are ignored (with a clear message) for product entries. The standalone `get_source_changelog` tool is now deprecated in favor of these params — it remains registered and functional for this release, but agents should migrate.
- 7ba0ebd: `releases org get` now renders stub-tier orgs (#1947): a `stub · not yet tracked` marker on the header and a `Declared locations` section listing each declared locator (kind, target, `canonical` flag), plus a hint to promote. Previously a stub printed as a bare identity block with no indication it was a declared-but-untracked listing. `--json` output is unchanged.

### Patch Changes

- 64951a6: Add `releases admin release refetch <releaseId>` to re-fetch a single release's live page and heal it in place (title/content/publishedAt, same `rel_` id). Supports `--url` for releases whose stored URL is a synthesized `#fragment` index anchor, defaults to a dry-run preview, and writes with `--apply`.
- abeab6e: Consolidate agent skills by audience: this repo now ships only the three user-facing skills (`releases-mcp`, `releases-cli`, `analyzing-releases`). The `releases-admin` plugin, its five mirrored operator skills, and the `discovery`/`worker` agent definitions are removed — the canonical operator skills live in the backend monorepo's `.claude/skills/` tree. The `@buildinternet/releases-skills` npm wrapper is retired (removed from the workspace and the changesets fixed group; deprecated on npm). `npx skills add buildinternet/releases-cli` and `releases skills install` continue to work unchanged.

## 0.70.1

### Patch Changes

- cee0540: Fix overview stale warning to use content write time (`updatedAt`) instead of original generation time. Amended overviews no longer show as months-old when recently rewritten.

## 0.70.0

### Minor Changes

- eaa4ad1: Add `releases json export <org>` — generate a `releases.json` v2 domain manifest from an already-tracked org. Reconstructs the manifest from what the registry knows about the org (products + release sources) by calling the backend `GET /v1/orgs/:slug/manifest` endpoint, so an owner can host the result at `/.well-known/releases.json` and take ownership of their listing. Prints to stdout by default (pipeable into `releases json validate -`) or writes to a file with `-o/--output`. Completes the owner round-trip alongside `releases json validate`. Re-ingest enriches missing fields only (fill-if-empty), never overwriting existing values.

  Bumps `@buildinternet/releases-api-types` to `^0.41.0` for the product-level `tags` field, so `releases json validate` accepts manifests that declare product tags. `json export` itself trusts the backend and does not strict-validate the API response against the pinned schema (the deployed API can run ahead of the published types), so it only guards for a `version: 2` shape.

## 0.69.0

### Minor Changes

- f1f11ae: `releases json validate <domain>` now validates live against the registry's listing endpoint (previously deferred). The domain form POSTs the public `/v1/listing/validate` endpoint and renders the verdict plus the materialization plan — identity, products, and each release locator with its classification ("goes live" / "reviewed first") — ending with an activation pointer for unlisted domains. Exit codes: 0 valid, 1 invalid or check failed (the old unconditional exit 2 is gone). `--json` emits the raw `ListingValidationResult` merged with `{ target }`. Bumps `@buildinternet/releases-api-types` to ^0.39.0 for the listing wire types.
- af88692: `releases admin release update` (and its deprecated `release edit` alias) now accept a `--url <url>` flag to set a release's canonical URL. Passing a non-empty value sets the URL; passing an empty string (`--url ""`) clears it. The backend `PATCH /v1/releases/:id` route already accepted the `url` field — this wires it through the CLI.
- 042efbd: Add stub-tier org verbs (buildinternet/releases#1947): `releases admin org create-stub` (curator-authored stub org with repeatable `--location` JSON locators and/or `--from-file`), `releases admin org create-stub-from-domain <domain>` (stub from a domain's `/.well-known/releases.json` manifest, `--dry-run` supported), and `releases admin org promote <slug>` (materialize declared locations into sources and flip the org to tracked, `--dry-run` supported). Bumps `@buildinternet/releases-api-types` to ^0.38.0 for the stub-tier wire types.

## 0.68.0

### Minor Changes

- c1e5ee6: Add `releases json validate <path>` — validate a `releases.json` v2 owner manifest against the published schema (`ReleasesJsonConfigSchema`) before publishing it. Accepts a file path or `-` for stdin, detects the hosting scope (domain vs repo) for readable path-anchored errors, and supports `--json` for machine output (exit 0 valid / 1 invalid). The `domain` form (live fetch + materialization plan) is deferred until the public dry-run endpoint lands (buildinternet/releases#1910) so web and CLI share one verdict.

### Patch Changes

- cf95da6: Adopt `@buildinternet/releases-api-types` 0.37.0 (releases.json v2 schema) and migrate the repo-root `releases.json` to the v2 manifest format (product binding + `github: "self"` release locator).

## 0.67.3

### Patch Changes

- 9fae093: `releases admin org update --overview-cadence <days|auto>` — pin an org's automated overview-regen cadence (1–90 days) or clear back to the velocity-tiered automatic default; `releases admin org get` shows the override when set (buildinternet/releases#1895).
- cb01cc2: Removed `releases admin overview batch` — its API route was retired in buildinternet/releases#1902; use the automated overview regen (per-org cadence) or `--overview-cadence` instead.

## 0.67.2

### Patch Changes

- b8d7f2f: Read API error messages through api-types' canonical `decodeApiError` instead of a hand-rolled envelope reader. Behavior is unchanged — the nested `{ error: { code, type, message } }` envelope, a legacy flat `{ message }` body, and malformed payloads (which fall back to the HTTP status text) all resolve exactly as before — but the CLI now shares the published wire-shape decoder rather than duplicating it. Bumps `@buildinternet/releases-api-types` to `^0.35.0` and `@buildinternet/releases-core` to `^0.25.0` (the versions that first export the errors module).

## 0.67.1

### Patch Changes

- 9a286fa: Read API error messages from the standardized nested error envelope. The API now
  returns `{ error: { code, type, message } }`; the CLI was still reading a
  top-level `body.message`, so non-2xx responses surfaced a generic status text
  (e.g. "Bad Request") instead of the server's actual message. A new
  `apiErrorMessage()` reader pulls `error.message` (tolerating the legacy flat
  `{ message }` body), restoring precise error output.

## 0.67.0

### Minor Changes

- bf51f1b: Add `--auto-generate-content` / `--no-auto-generate-content` to `releases admin org update` — the single backend gate that decides whether an org gets AI overviews and per-release summaries. Previously the only way to toggle it was a raw `curl` PATCH. `releases admin org get` now shows the current value, and `releases admin overview plan` surfaces an `opted_out` action for orgs the batch skips because the flag is off.

## 0.66.0

### Minor Changes

- 26e14ad: Add `--format slack` to `releases webhook add`/`edit` to deliver releases as formatted Slack messages via a Slack incoming webhook URL.

## 0.65.0

### Minor Changes

- 5d70021: Agent-DX: uniform `dryRun: true` marker on every dry-run output, and `--dry-run` for the mutations that lacked it.

  - Every `--json` dry-run payload now carries a uniform `dryRun: true` marker (via the new `markDryRun` helper in `src/lib/dry-run.ts`), additively — each command keeps its existing preview fields (`status: "would-add"`, `wouldUpdate`, `wouldRemove`, `wouldPost`, …). An agent can now detect "this was a preview, not a write" without per-command knowledge.
  - Added `--dry-run` to the mutations that previously had none: `follow`/`unfollow`, `keys create`/`keys revoke`, `admin webhook add`/`edit`/`remove`/`test`/`rotate-secret`, and `admin onboard apply` (per-source would-action preview, no writes).
  - `admin release delete --source` and `import` gained a `--json` dry-run body where they previously printed only text.

- e806807: Agent-DX: `--fields` projection mask on the reader commands.

  `--fields id,version,source.slug` post-filters `--json` output down to a comma-separated mask (dot-notation for nested keys), so an agent can pull exactly the leaves it needs and spend fewer tokens.

  - Available on `get` (release/source/org/product), `search`, and `tail`/`latest`.
  - It's a post-projection over whatever shape the reader produced, so it **composes with `--full`** (mask the full payload) and reuses the slim vocabulary by default — no new field names to learn.
  - Dot-notation walks plain objects only (request an array-valued field like `media` whole). A field that resolves nowhere is dropped with one stderr warning; `--fields` without `--json` warns and is ignored, matching `--full`.
  - Generic backend in `src/lib/fields.ts` (`projectFields`/`applyFieldMask`), reusable for future readers.

- 292b1c8: Agent-DX: `--page-all` streams every page of a list reader as NDJSON.

  `releases list --json --page-all` (and `org list` / `admin product list`) walks every page itself and emits one source/org/product per line as newline-delimited JSON, instead of returning a single `{ items, pagination }` page the caller has to paginate by hand.

  - One agent command consumes a whole result set — no `--page`/`--limit` bookkeeping, no truncation warning to react to.
  - NDJSON keeps memory flat and lets a consumer (`jq -c`, a stream parser) process rows as they arrive rather than buffering one giant array.
  - `--json`-only, like `--full`/`--fields`: without `--json` it warns and falls through to the normal table. `--page-all` together with `--page` is rejected (they contradict). `--limit` still sets the per-request page size as a round-trip tuning knob.
  - Shared backend in `src/lib/paginate.ts` (`streamAllPages`), reusable for future page-based readers.

- 403738a: Agent-DX: raw JSON payloads for source mutations via `--input`.

  `releases admin source create` and `releases admin source update` now accept a `--input <json>` body, so an agent can send the request shape directly instead of reverse-mapping it onto a dozen bespoke flags. Pass a literal JSON string, `@<path>` for a file, or `-` for stdin.

  - The body maps to the **CLI input shape**, not the raw API — dedup, org-resolution, metadata-packing, and validation still run. `create --input` mirrors a `--batch` element (`name`/`url`/`type`/`org`/`metadataSet`/…); `update --input` maps to the update fields plus a convenience `metadata` object (each key set directly, a JSON `null` value deletes it).
  - `--strict`/`--dry-run`/`--json` remain execution modifiers from the flags (the body never sets them). On `create`, `--input` is mutually exclusive with `--batch`.
  - Invalid JSON and shape errors throw `CliError`, so they serialize to the structured `{ error }` payload under `--json`.

### Patch Changes

- 624370c: Agent-DX hardening: structured `--json` errors and input validation.

  - When `--json` is set, thrown errors now emit a parseable `{ error: { kind, message, status?, method?, path?, field? } }` payload on stdout (with a non-zero exit) instead of an unstructured stderr dump. Without `--json`, known error types (API + invalid-input) print a clean one-line message rather than a stack trace.
  - User-supplied identifiers are validated before any network call — control characters, `..` traversal, `%` percent-encoding, embedded `?`/`#`, whitespace, and backslashes are rejected at the entity resolvers (`findOrg`/`findProduct`/`findSource`/`getRelease`). `apiFetch` gains a control-character backstop, and file-reading flags reject `..` traversal.

- c0c91f1: Fix: streaming output (`--page-all`, `tail -f --json`) now exits cleanly when a reader closes the pipe early (`… | head`).

  Piping NDJSON streaming output into a consumer that closes stdout before EOF — e.g. `releases list --json --page-all | head` or `… | jq | head` — caused the CLI to hang indefinitely. On the early close the next stdout write raises EPIPE, which Bun surfaces as an `'error'` event (rather than crashing); with no handler, the writer was left awaiting a `'drain'` that can never fire. A startup `process.stdout.on("error", …)` handler now treats a broken pipe as a clean `exit(0)`, so `| head` terminates immediately. Full consumption (to EOF, to a file, `| wc -l`) is unaffected.

## 0.64.0

### Minor Changes

- f874edd: Add user-facing `releases webhook` commands for self-serve `/v1/me/webhooks`: `list`, `add`, `show`, `edit`, `remove`, `test`, `rotate-secret`, and `deliveries`. Requires `releases login` (or `RELEASES_API_KEY`). Supports org-scoped (`--org`, optional `--source`) and follows-scoped (`--scope follows`) subscriptions. `webhook verify` remains a local, no-auth signature check. Closes buildinternet/releases-cli#320.

### Patch Changes

- 1dfac19: Add `--product`, `--type`, and `--clear-*` filter flags to `releases webhook add` and `webhook edit`, matching per-event filters on `POST/PATCH /v1/me/webhooks`. Companion to buildinternet/releases#1683.

## 0.63.0

### Minor Changes

- 767f32f: Add bulk release delete and suppress to `releases admin release`. Multiple positional `rel_…` IDs or `--file` (one ID per line, `-` for stdin) route through `DELETE /v1/releases/batch` and `POST /v1/releases/batch-suppress`; a single ID keeps the existing per-row endpoints. `scripts/bulk-suppress.ts` now uses the batch API grouped by reason instead of one HTTP call per release. Pairs with buildinternet/releases#1654.

### Patch Changes

- 728f826: Wrap `apiFetch` transport errors (DNS failure, connection refused, abort) with endpoint context. The thrown message now includes the HTTP verb and path (`API request failed on GET /v1/…: ECONNREFUSED`), matching the existing HTTP-error message shape. The original error is preserved via `cause`.
- 728f826: Return `undefined` from `getMonthlySummary` on a GET 404 instead of throwing `TypeError: Cannot read properties of null`. The function's declared return type is `Promise<ReleaseSummary | undefined>`; the null guard (`rows?.[0]`) now honors that contract.
- 88192e9: Show a one-line account nudge ("Create a free account for personalized feeds and higher rate limits — run `releases login`") on the bare `releases` landing screen when no credential is configured. TTY-only and self-resolving once signed in, mirroring the completion notice.
- 728f826: Constrain API-derived trace IDs (`session.sessionId`, workflow `instanceId`) to a single safe path segment before writing trace files, so a malicious or tampered API response can't traverse out of the trace directory (`../`, separators, absolute paths). Fails closed: an unusable id throws rather than writing to an unexpected location.
- 61afcc3: Internal refactor: split `src/api/client.ts` into per-domain modules (admin, collections, follows, orgs, products, releases, sources, webhooks) behind a re-export barrel. No user-visible changes.
- 728f826: Restrict credential file ACLs on Windows using `icacls` after write so the token file is readable only by the current user. Soft-fails silently if `icacls` is unavailable, leaving login functional. Unix behavior unchanged.

## 0.62.1

### Patch Changes

- 09aec58: `releases admin source fetch` no longer silently drops a source identifier when combined with `--org` (#307). Previously `source fetch <identifier> --org <org>` ignored the identifier and dispatched a managed-agent session over every active source in the org; it now errors out on the conflict, matching `releases latest`'s `--product`/`--org` rejection. Passing both the positional identifier and `--source` is also rejected instead of silently preferring the positional. The `--org` fan-out additionally skips push-only `agent` sources — they have no fetch adapter, so dispatching a session over one was a wasted no-op — and reports how many were skipped.
- ec76928: `releases import` now dedups org accounts on the exact `(platform, handle)` pair instead of platform alone (#283). `org_accounts` is one-to-many — the server's unique index is on the pair — so an org can hold a second handle on a platform it's already linked to (e.g. Cloudflare's `x/Cloudflare` plus `x/cfchangelog`). Previously, importing a manifest that added a second handle on an already-linked platform was silently skipped, logging "already linked" for a handle that was never linked. The import now fetches the org's full account list and links any pair it doesn't already hold; an exact already-linked pair still reports "already linked" and is not re-created. The `--dry-run` preview mirrors the same dedup so it no longer over-reports accounts it would link.
- 4c3f42f: Add `releases admin source show <src_…|org/slug|slug>` (alias `get`) to inspect a single source's config — type, fetch method, priority/paused state, last-fetch, and the metadata flags operators care about (render/crawl, feed URL, parse instructions, etc.). `--json` returns the source with parsed metadata instead of the raw JSON-in-JSON string. Previously the only way to read a source's config was to dump the whole org and filter the `sources` array by hand (#295).

  Fix `source update <src_…> --json`: the JSON-refresh step re-resolved the source by its bare slug, so updating a source whose slug collides across orgs (e.g. `release-notes`) threw `AmbiguousSourceError` _after_ the update had already applied — even though the source was addressed by an unambiguous `src_…` id. The refresh now resolves through the typed id (#294).

## 0.62.0

### Minor Changes

- ca636fa: Improve the release-reader ergonomics for `get`, `latest`/`tail`, and `list` (#303, #304):
  - `get <id> --json` now surfaces `media[]` (with the R2-mirrored `r2Url`) when a release has media, plus a `contentTruncated: true` hint so callers know the body was projected to an excerpt and `--full` exists. Previously the slim shape dropped media entirely with no signal it existed, forcing a round-trip to `--full` or the raw API to verify media presence. `--full` is unchanged.
  - `latest`/`tail` gain `--limit` (an alias for the existing `--count`) so the absence of `--limit` — which works on other commands — no longer errors with "unknown option". Both clamp to the server's `[1, 100]` window, and a one-shot listing that fills the requested window now prints a truncation hint to stderr (raise `--limit`, narrow with `--since`/`--until`/`--source`/`--org`, or for `--product` feeds, page with the surfaced `--cursor`).
  - `latest --product` is cursor-paginated; a new `--cursor` flag pages through it deterministically (the global latest feed has no cursor — it is count-capped — so `--cursor` errors there).
  - `releases list` now shows a `Releases` per-source count column in the text table, so "how many releases does this source have?" is answerable without dropping to `--json` (which already carried `releaseCount`) or the raw API.

### Patch Changes

- e045fe0: Trim the README to a leaner npm landing page (291 → ~130 lines): merge the install paths, condense the shell-completion and output-format prose into pointers to `--help`, drop the closed-beta admin-triage detail, and consolidate the auth sections. Reframe sign-in messaging around its present-day value — following orgs/products and a personalized feed — with read-only keys explicitly non-write/non-admin (and a path to higher rate limits), rather than leading with the closed-beta write/admin caveat.

## 0.61.0

### Minor Changes

- 695039d: Add personalized follows + feed verbs: `releases follow <org|product>`, `releases unfollow <org|product>`, `releases following` (list), and `releases feed` (your personalized release timeline). They act on the signed-in user's account via the API's `/v1/me/*` routes — sign in with `releases login` (or set `RELEASES_API_KEY`) first. `follow`/`unfollow` accept an org slug, an `org/product` coordinate, or an `org_…`/`prod_…` id; `feed` reuses the same renderer as `releases tail` and is page-paginated (`--page` / `--limit`, `--json`). Requires `@buildinternet/releases-api-types` ≥ 0.32.0 for the follows wire types.
- de9ce26: Add `releases source fetch <source> --dry-run`: probe a single source without writing to D1 or dispatching (billing) the managed agent. For a client-rendered scrape source (`crawlEnabled`/`renderRequired`) it renders the index once via Browser Rendering and reports how many candidate release links were found — the cheap "can the steady-state cron render actually see releases here, or is it hitting an empty JS shell?" check that onboarding previously had no way to answer. For a feed/GitHub source it reports candidate releases parsed. Single source only; `--json` supported.

## 0.60.0

### Minor Changes

- 5d191ea: Add `releases admin webhook` commands for managing outbound webhook subscriptions: `add`, `list`, `show`, `edit`, `remove`, `test`, `rotate-secret`, and `deliveries`. These wrap the existing root-key-gated `/v1/webhooks` API routes so Phase-A operators can manage subscriptions without raw API calls.

  The subscriber-facing `webhook verify` (local signature check, no auth) moves from `admin webhook verify` to top-level `webhook verify`.

- 313ffb0: Rename the local stdio MCP server's tools (`releases admin mcp serve`) to mirror the canonical names served by the hosted server at `mcp.releases.sh`: `search_releases` → `search` (now returns the full unified result — orgs, catalog, and releases — with an optional `type` section filter), `list_sources` + `list_products` → `list_catalog` (org-scoped via `GET /v1/orgs/:slug/catalog`; global path folds products + standalone sources), and `get_product` → `get_catalog_entry` (dispatches product vs. source on the identifier prefix). `get_source` / `get_source_changelog` are unchanged.

## 0.59.0

### Minor Changes

- 639d0cd: feat(admin): `releases admin oauth client …` verbs

  Add CLI verbs to register and manage "Sign in with Releases" OAuth clients, wrapping the root-key-gated `/v1/admin/oauth/clients` routes from buildinternet/releases#1482. `create` (with `--redirect-uri`/`--scope` repeatable, `--trusted`, `--public`/PKCE, `--no-pkce`) prints the `reloc_` secret once; `list`/`get` are secret-free; `disable`/`enable` toggle the reversible kill switch; `trust`/`untrust` toggle consent-screen skipping; `rotate-secret` issues a new secret once; `delete` is a hard removal.

- d3581d0: feat(admin): `releases admin user set-role | get-role | list-roles` (#288)

  Add CLI verbs to manage user roles — the OAuth scope-entitlement source of truth (`user`→read, `curator`→read+write, `admin`→read+write+admin) — wrapping the root-key-gated `/v1/admin/users/role` routes from buildinternet/releases#1485. `set-role` shows `previousRole → role`; `get-role` reads one user; `list-roles` lists curator/admin users. Backfills the changeset omitted when #288 merged.

## 0.58.0

### Minor Changes

- 67ff782: Add `releases keys` verbs (create/list/revoke) for self-serve, read-only user API keys. Authenticated via the device-flow session token persisted at login, with transparent re-auth on expiry.

## 0.57.0

### Minor Changes

- 1f92ee4: feat(cli): `releases login` — device authorization (RFC 8628) (#282)

  Add a top-level `releases login` command that authenticates the CLI via the OAuth 2.0 Device Authorization Grant (RFC 8628): it requests a device/user code, opens the verification URL in the browser (with a headless copy-paste fallback), polls for approval, then exchanges the device session for a durable read-only `relu_` API key minted via `POST /v1/api-keys` and stores it through the existing credential path. Backfills the changeset omitted when #282 merged.

- 8a6c994: feat(org): `admin org avatar <org> --from <source>` — one-step avatar ingest (#1406)

  Resolve an image, mirror it to R2, and set the org avatar in a single command. `--from` accepts an `https://` URL, or a shortcut derived from the org's own data (no fuzzy matching): `github` (the org's linked GitHub handle → `github.com/{handle}.png`), `favicon` (the org domain's apple-touch-icon), or `appstore` (the org's App Store source → iTunes 1024px artwork). Resolution runs CLI-side; the server fetches, validates it's a square raster, and stores it — CF credentials stay server-side. Backed by `POST /v1/orgs/:slug/avatar` (api-types 0.30.0).

## 0.56.0

### Minor Changes

- d0d1346: Add entity-notice rendering (Part A) and set/clear verbs (Part B) for org, product, and source entities (#278).

  **Part A — render:** `releases get`, `releases org get`, and `releases admin source update` detail views now display a curator notice in yellow when the API returns one — formatted as `Notice: <message> → <coordinate-or-href>` (pointer omitted when absent). The notice also passes through in all `--json` outputs.

  **Part B — set/clear:** New flags on the three entity update commands:

  - `releases org update --notice <msg>` / `--notice-link <coord|url>` / `--notice-link-text <label>` / `--clear-notice`
  - `releases admin product update` — same flags
  - `releases admin source update` — same flags

  `--notice-link` is routed automatically: an `https?://` value is sent as `href`; anything else is validated as a 1–2-segment registry coordinate (`org` or `org/slug`) and sent as `coordinate`. `--clear-notice` sends `{ notice: null }` to remove an existing notice. The flags are mutually exclusive (`--clear-notice` + `--notice` exits with an error).

  All flag parsing lives in `src/lib/notice.ts`. The `Notice` type is imported from `@buildinternet/releases-core@0.23.0` (canonical source); this PR also bumps `@buildinternet/releases-api-types` to `^0.29.0`.

### Patch Changes

- 6ef7321: `admin source fetch-log <source>` now shows an in-progress banner when a managed-agent fetch is still running for that source — the session id plus how long it has been running — so an operator can tell a live fetch from a stuck one instead of seeing only terminal history (#1360). The source-filtered query reads the API's enveloped `activeSession`; `--json` output is unchanged (still the bare logs array). The status column also labels the `crawl_timeout` (#1361) and `blocked` (#1171) states distinctly instead of rendering them as "no change".

## 0.55.0

### Minor Changes

- c5c4a3e: Add a `--local` handoff flag to `admin source fetch <slug>` (#273). It stages local onboarding for the `local-ingest` skill instead of dispatching the remote managed agent: it runs the same robots.txt / Content-Signal opt-out preflight as the monorepo skill (refuses on `ai-input=no` / `ai-train=no`, e.g. `conductor.build`; `--force` overrides with explicit publisher permission), resolves the source, discovers candidate page URLs from `/sitemap.xml` (filtered to the changelog path) or the index HTML, classifies the page shape, and prints a structured handoff brief (`--json` supported) — the org-scoped batch endpoint, the preflight verdict + parsed Content-Signal, and a capped candidate-URL list with an explicit skip note (no silent truncation). No managed-agent session, no model call, and no Anthropic/adapter dependency added to the thin client — HTTP fetch + string parsing only. Exit codes: 0 proceed, 1 refuse, 2 unknown.
- 4730f53: Add `--hard` to `admin release delete --source` and `admin source delete`. The default stays a soft delete (releases suppress, sources tombstone), but `--hard` passes `?hard=true` so rows are removed outright and the `UNIQUE(source_id, url)` dedup slot frees up — enabling a clean purge + re-ingest without a full org hard-delete (#1184). Also fixes the soft `release delete --source` summary, which previously printed `Deleted undefined releases` because the API returns `{ suppressed }` on that path.

### Patch Changes

- 8f6f272: Bump `@buildinternet/releases-api-types` from `^0.24.0` to `^0.27.0` and `commander` from `^14.0.3` to `^15.0.0` (ESM-only; no API changes required for this CLI).

## 0.54.0

### Minor Changes

- 9069be7: Add `--primary` to `admin source create` so an org's primary changelog can be marked in one step (`isPrimary` on the create POST), instead of creating the source and then running a follow-up `admin source update <slug> --primary`. The REST create endpoint and the `manage_source` "add" action already accepted this — the CLI was the only surface missing it, so it no longer rejects the `--primary` the `managing-sources` skill documents.
- 1072996: Add `admin source create-video <channel-or-playlist-url> --org <slug>` to materialize a `video` source from a YouTube channel/playlist (`POST /v1/sources/video`), surfacing the resolved provider/channel and backfilled release count. The generic `source create` now rejects `--type video` and pasted `youtube.com`/`youtu.be` URLs with a pointer to the dedicated verb — mirroring the App Store guard — so a YouTube URL can no longer be silently mis-created as an empty-bodied feed source.

## 0.53.0

### Minor Changes

- 1447aad: `admin org update` and `admin source update` now accept `--discovery <status>` to promote or demote discovery status (`curated | agent | on_demand`).
- 54003b5: `admin product list` now lists products across all orgs when the org argument is omitted.

  The org argument is optional: `releases admin product list` (no org) enumerates products across every org, honoring `--kind`, `--json`, and the new `--limit`/`--page` pagination flags. The cross-org table gains an **Org** column so a bare product slug stays attributable; org-scoped listing keeps its original columns. This closes the CLI↔MCP gap that blocked a cross-org `kind=sdk` audit — previously expressible only via the remote MCP `list_catalog` tool (buildinternet/releases-cli#259). Backed by the existing org-agnostic `GET /v1/products` endpoint; no API change required.

### Patch Changes

- 59ff421: Resolving a source by a **bare slug** (`admin source fetch`/`fetch-log`/`update`, the MCP `get_source` / `get_source_changelog` tools, and every other command that takes a source identifier) now errors and lists the matching `org/slug` + `src_…` candidates when that slug exists under more than one org, instead of silently resolving to the oldest match. Source slugs are unique per-org but not globally, so a bare `blog` could previously read from — or `update` could mutate — a source in the wrong org. Disambiguate with an `org/slug` coordinate or a `src_…` id (both already supported). Requires the API's `?slug=` source filter (releases#1323).
- 6562369: Fix crash in `admin overview inputs` when the API returns 404 for on_demand orgs.

## 0.52.0

### Minor Changes

- c4d9046: Admin source/org ergonomics: three fixes surfaced during a Discord onboarding cleanup.

  - `admin source backfill <id|slug>` — new verb wrapping the full-history backfill endpoint (`POST /v1/workflows/backfill-source`). Resolves a slug to the typed `src_…` ID, dry-runs by default (counts + date range), and writes with `--no-dry-run`/`--commit`. Supports `--max-windows` and `--markdown-file` (for JS-heavy / bot-blocked pages the worker can't fetch itself). (#252)
  - `admin source create` now accepts `--keyword-allow <list>` (→ `metadata.feedKeywordAllow`) and the general repeatable `--metadata-set key=value`, so feed filters are set atomically at create time. This closes the race where a follow-up `source update` lost to the onboard auto-fetch and ingested the whole unfiltered feed. (#237)
  - `admin org delete --hard` now succeeds: it sends the typed `org_` ID the destructive path requires instead of the slug the server rejects. Soft delete still uses the slug. (#236)

- a744cad: Admin source backfill/re-extract: async-aware backfill + a new `reextract` verb.

  - `admin source backfill` now handles the async dispatch shape. Deep Firecrawl backfills run as a durable workflow (buildinternet/releases#1281/#1282) and return `202 { instanceId, statusUrl }` instead of a report; the CLI now detects this rather than crashing on the non-report body. Matching `admin overview batch`, it **dispatches and returns the workflow instance ID by default** (non-blocking — the right primitive for the CLI's primary agent users), with `--wait` to poll inline and render the report. New sibling `admin source backfill-status <instanceId>` does a single-shot status read (renders the report when complete) so a dispatched workflow can be polled on the caller's own cadence. The Firecrawl-ceiling `guidance` hint is now surfaced. (buildinternet/releases#1285)
  - `admin source reextract <id|slug>` — new verb wrapping `POST /v1/workflows/reextract-source` (buildinternet/releases#1284). Re-extracts releases from a stored raw snapshot (`released-raw`) with no live scrape, no Firecrawl credits, deterministic input — for reprocessing history after extraction/parse logic improves. Dry-run by default; `--snapshot-id` pins a specific capture, `--commit`/`--no-dry-run` writes. Surfaces the endpoint's actionable errors (`no_snapshot`/`snapshot_not_found` 404, `snapshot_expired` 410, non-scrape 400, missing bucket/key 503). (buildinternet/releases-cli#257)

- a188184: `admin org update` now accepts `--featured` / `--no-featured`, so operators can curate the editorially-featured org list (the home-page rail, buildinternet/releases#1274/#1275) from the terminal instead of only via the web Admin menu or a raw API `PATCH`. The flag maps to `PATCH /v1/orgs/:slug { featured }`; aliased onto the deprecated `org edit` too. (#253)

## 0.51.0

### Minor Changes

- 8935518: Add App Store source support to the admin CLI.
  - New `releases admin source create-appstore <url-or-id>` verb — accepts an `apps.apple.com` URL, a bare numeric track ID, or an `appstore:<trackId>` coordinate, with `--platform ios|macos`, `--org`, `--product`, `--storefront`, `--json`, and `--dry-run`. It calls `POST /v1/sources/appstore`, which resolves the listing, mints the first release, and backfills the product's app-icon avatar.
  - `releases admin source create` now recognizes `appstore` as a valid type and rejects `--type appstore` / pasted `apps.apple.com` URLs with a pointer to `create-appstore` (source types are now sourced from `@buildinternet/releases-core` instead of a hard-coded list).
  - `releases admin product list` and `releases get <product>` surface the product `avatarUrl` (the app icon).

### Patch Changes

- 7a28fc2: Document the `source create-appstore` verb in the `releases-cli` admin skill reference: a dedicated "Create App Store source" section (identifier forms, `--platform`/`--storefront`, idempotency, the pre-create-product workflow) plus a note on the `create` command that App Store apps use it.
- ed73777: Document Firecrawl monitoring as a fetch backend in the changelog skills: add it as step 5 of the `parsing-changelogs` pipeline overview, and note in `managing-sources` / `finding-changelogs` that for sources behind a Cloudflare Managed Challenge (persistent `no_change` / 0 releases that `--render` can't fix), Firecrawl is enabled per-source via the admin API (`POST /v1/sources/:slug/firecrawl/sync`), not a CLI verb or `--metadata-set`.

## 0.50.0

### Minor Changes

- 15ad436: Tighten and enrich `releases get` output for products, orgs, and sources.
  - **Products now show their latest releases inline.** A product card previously printed only metadata and pointed you at the org feed (which mixes sibling products) or a single source — an extra round-trip for the unit that's now primary. It now embeds a preview of the product's cross-source feed, matching what `get <org>` and `get <source>` already did, and the `--json` output gains a `releases` array.
  - **Leaner cards.** The standalone type label ("Product" / "Organization" / "Source") and the separate ID / Slug / Org rows are folded into a single header line — `Name by OrgName (orgSlug/slug)` (orgs, having no parent, render `Name (slug)`). The "by Org" clause is dropped when the name already names the org, so App Store-style names like "Claude by Anthropic" don't double up. Empty fields (e.g. a missing URL) are omitted instead of printing a dash, redundant counts (the product card's source count, the org card's product total and bare source total) are dropped, and the typed ID moves to a dim trailing line.
  - **Release rows lead with the title.** The feed description column now prefers the title family (AI headline → title) over the `summary`/content excerpt: feed surfaces often serve a raw content excerpt in `summary` when there's no curated AI summary yet, which buried the far more useful title (e.g. "Claude Design by Anthropic Labs" instead of "New Anthropic Labs product that lets you collaborate…"). The product and source cards also drop the leading source column — the owning entity is already in the header — so the title gets full width and App Store rows stop repeating "Claude by Anthropic │ Claude by Anthropic 1.2…".
  - **Clearer Next steps.** The product card's footer now leads with `releases latest --product <org/slug>` and a `--since 90d` variant, replacing an opaque "drill into one source" hint that pointed at an arbitrary first source by raw `src_` id. Org and source footers use the unified `latest` verb and note the `--since` window.
  - **The org card's release feed names the owning product.** Now that the release-feed wire carries the owning product (api-types 0.23.0), `get <org>` keeps a leading column — populated with the product name (falling back to the source) — so a multi-product org's feed shows _which product_ shipped each release instead of dropping the column entirely.
  - **`releases search` gains `--product`.** Scope a full-text / semantic query to a single product's sources — e.g. `releases search "webhooks" --product vercel/next-js --since 90d`. Accepts an `org/slug` coordinate, a `prod_…` id, or a product slug, and composes with `--kind` / `--since` / `--until` / `--mode`. An unknown product warns and returns no results, mirroring `--domain`.

## 0.49.0

### Minor Changes

- f57a80e: Add a keyless `releases submit <url>` command to suggest a changelog or release-notes source for the registry — the terminal peer of the web submit form. Accepts an optional `--note` and `--contact`, normalizes a missing scheme to `https://`, and supports interactive/stdin input plus `--dry-run`. Maintainers review the queue via the new `releases admin recommendations list/triage/archive/delete` verbs, mirroring the existing `admin feedback` triage surface.
- 7721a3f: Add `releases latest --product <org/slug>` (alias `releases tail --product`) to show one product's cross-source release feed, backed by `GET /v1/orgs/:slug/releases?product=`. Accepts an `org/slug` coordinate, a `prod_…` id, or a bare product slug; composes with `--count`, `--since`/`--until`, `--include-coverage`, `--json`/`--full`, and `--follow`. It can't combine with a `[source]` argument or `--org`.

  The local MCP server's `get_latest_releases` tool now filters by product correctly too — previously its `product` argument was misrouted as a source filter, silently returning the wrong results.

## 0.48.0

### Minor Changes

- 7ee9840: Auto-create products at onboarding: `onboard apply` now reads optional `productName`/`productSlug` tags emitted by the discovery agent and performs a lookup-or-create for each distinct product before attaching sources to the right product under the org.

### Patch Changes

- 9e3147f: `releases admin overview get` now shows the overview's most recent update time when it differs from the original generation time, while keeping the release and citation counts in the summary line.

## 0.47.0

### Minor Changes

- 5c6b819: Add `--max-content-chars [n]` to `releases admin overview inputs`. In `--json` mode it clips each `selected[].content` to at most `n` characters client-side before printing (bare flag defaults to 1000), leaving every other field — `existingContent`, `media`, `totalAvailable`, and the `selected` length itself — untouched. High-volume orgs emit 500K+ chars of full release content here (sentry's largest single release is ~125K), which exceeds the ~30K Bash stdout cap a Claude Code sub-agent reads through and gets silently truncated, so the overview would be generated from only the first few releases. The clip is purely client-side — the CLI still receives the full payload over the wire — so it removes that footgun without the multi-step `jq` workaround. Omitting the flag preserves today's full-content output.

## 0.46.0

### Minor Changes

- 1a1575e: Add the `releases admin feedback` triage write-path: `triage <id> --status <new|triaged|closed>`, `archive <id>` (with `--undo` to restore), and `delete <id>` (hard delete, gated behind an id typeback or `--yes`). `admin feedback list` gains `--include-archived` and now marks archived rows. Consumes the new `PATCH`/`DELETE /v1/feedback/:id` endpoints.
- 616fe8a: Add `releases admin source stuck` — lists sources that chronically fail to fetch (pause candidates) by reading the fetch-log error streak. Supports `--window`, `--min-attempts`, `--include-paused`, `--limit`, `--page`, and `--json`.
- f38f166: Add `releases admin work start <batch>` / `status` / `end` and a sticky run-dir pointer for the maintenance workspace. `RELEASES_RUN_DIR` auto-captures admin mutations into `mutations.jsonl` and defaults the managed-session trace dir, but a one-time `export` doesn't survive an agent harness (each shell is fresh), so logging silently stopped after the first command. `work start` creates `~/.releases/work/runs/<ts>-<batch>/` (honoring `RELEASES_DATA_DIR`) and writes a sticky `~/.releases/work/.current-run` pointer; the CLI now resolves the active run as `RELEASES_RUN_DIR` env → `.current-run` pointer → none, so mutation logging and the trace-dir default work across separate invocations with no env threading. Explicit `RELEASES_RUN_DIR` still wins. `work status` prints the run dir, where it came from, and a mutations/sessions tally; `work end` clears the pointer.

### Patch Changes

- 3f70b35: `releases admin overview update` now always HTML-entity-decodes the content body before uploading. The five entities sub-agents reflexively over-escape when relaying markdown (`&amp;`, `&lt;`, `&gt;`, `&quot;`, `&#39;` — e.g. `Q&amp;A`, `streams.input&lt;T&gt;`) are a transport artifact, not authored content, and the API stores the body verbatim — so an un-decoded entity rendered wrong. The decode is single-pass and idempotent, so an already-clean body (including one a caller pre-decoded to compute citation offsets) is unchanged. `--unescape-html` is now the default and kept as an accepted no-op flag for back-compat.
- dc7c707: `releases admin overview get` now surfaces inline citations. The table line includes a citation count alongside the release count, and `--json` adds `citationCount` plus the full `citations` array. The org overview GET already returns citations ordered by character position — this exposes them so a post-write `overview get` can verify what `overview update` reported (which echoes `citations: N`) without a re-write.
- b9df70e: Reconcile the reader-facing skills (`releases-mcp`, `releases-cli`, `analyzing-releases`) with the live API surface. Removed references to tools/commands that don't exist (`summarize_changes`, `compare_products`, `get_source_changelog`, `manage_*`, `releases summary`/`compare`) and the deprecated `list_sources`/`list_products`/`search_releases` shims; documented the collections trio, `lookup_domain`, `agent-context`, and `since`/`until` time windows; and clarified that summarize/compare are agent-synthesized. Moved `finding-changelogs` to the operator (`releases-admin`) plugin since it's a key-gated curation workflow.

## 0.45.0

### Minor Changes

- dc6ae62: Rework `search` / `tail`/`latest` human output and slim the default `--json`.

  The human view for `search` and `tail`/`latest` is now a single column-aligned row per release (identity · description · relative age · dimmed `rel_…`); `search` adds a cleaned, markdown-stripped excerpt under each hit instead of dumping raw markdown. The piped (non-TTY) TSV path is fixed to one clean row per release.

  `--json` now returns a lean release shape by default for `get` / `search` / `tail`/`latest` (`id`, `version`, `title`, `summary`, `excerpt`, `url`, `publishedAt`, nested `source`/`org`, `contentChars`, `contentTokens`); pass `--full` to recover the complete payload (`content`, `contentHash`, `versionSort`, `composition`, the `title*` variants, …). Scripts that read dropped fields should add `--full`.

### Patch Changes

- c5ece26: Refine the release reader output: clearer ownership, shorter labels, human dates.
  - `search` release hits now lead with the owning org as `Org/Source` (e.g. `Axiom/Changelog`) so it's clear who ships each result. The org prefix is skipped when the source name already starts with the org name (`Railway Changelog` stays as-is rather than becoming `Railway/Railway Changelog`). Feed views (`get` entity cards, scoped `tail`) are unchanged — the org is already established there.
  - The release detail cards (`get <rel_…>` and `release get`) now show an `Org:` line so the owning company is named even when the source is generic (e.g. an "API Release Notes" source under Google).
  - `get` / `release get` print the publish date as `Jul 22, 2024` instead of the raw ISO timestamp. `--json` still emits ISO `publishedAt` for machine consumers.
  - Trimmed the AI-attribution labels on the `get` card to `AI summary` / `AI headline`, and dropped the redundant `Release` heading above the title.

## 0.44.0

### Minor Changes

- 4a72ff1: Add `releases feedback` to send feedback about the CLI (arg, stdin, or interactive; `--contact`, `--type`, `--json`, `--dry-run`), and `releases admin feedback list` to review submissions.
- 62f7f78: Add `--since` / `--until` time-window filters to `releases search` and `releases tail|latest`. Each accepts an ISO date (`2026-01-01`) or relative shorthand (`90d`, `4w`, `6m`, `2y`) and filters releases by publish date, composing with the existing filters. Enables capability-discovery queries like `releases search "slack integration" --since 90d`.

## 0.43.0

### Minor Changes

- cf83217: Standardize environment variables on the `RELEASES_` prefix (`RELEASES_API_KEY`, `RELEASES_API_URL`, `RELEASES_DATA_DIR`, `RELEASES_TELEMETRY_DISABLED`, `RELEASES_DISCOVERY_ENGINE`, `RELEASES_CLIENT_*`, `RELEASES_INSTALL_DIR`). Legacy `RELEASED_`-prefixed names still work but now emit a one-time deprecation warning and will be removed in a future release.

## 0.42.0

### Minor Changes

- a3a08d5: Improve top-level help discoverability and surface the web catalog.
  - `releases --help` (and `releases help`) now list **every** command — `lookup`, `collection`, `auth`, `whoami`, `completion`, `skills`, and more — instead of the curated seven. Bare `releases` still shows the friendly quick-start.
  - The landing screen now shows the web catalog (`https://releases.sh`) in its header, and the full `--help` listing carries it too.
  - Removed the `Exit codes: see README.md#exit-codes` footer line from the landing screen.
  - The curated landing now labels the command `tail` (matching the "most common commands" block) instead of its `latest` alias.
  - The first-run completion hint no longer nags when completions are already installed by the package manager (e.g. Homebrew generates them at install time). Documented that Homebrew installs completions automatically while npm / shell-installer / binary users run `releases completion install` once.
  - The landing screen and `--help` now show a persistent, self-resolving notice when shell completion isn't set up (e.g. for npm / binary installs) — `Shell completion isn't set up — run "releases completion install <shell>"`. It disappears automatically once completions are detected (user- or package-manager-installed), is TTY-gated so it never pollutes piped output, and respects `RELEASES_NO_COMPLETION_HINT`.
  - Updated the product tagline from "Changelog indexer and registry for AI agents and developers" to "The changelog & release-notes registry for developers and AI agents" across the CLI landing, `--help`, package descriptions, the Homebrew formula, and the README.

## 0.41.0

### Minor Changes

- a49b105: Auto-capture for the `~/.releases/work/` maintenance workspace (two independent mechanisms):
  - **Admin-mutation log.** When `RELEASES_RUN_DIR` is set, every `releases admin …` write appends one JSONL line (`{timestamp, command, target, result}`) to `$RELEASES_RUN_DIR/mutations.jsonl`. Logged at the api-client chokepoint; telemetry/heartbeat endpoints are excluded. Unset → no-op, and fully fail-open (a logging failure never breaks the write).
  - **Managed-session traces.** `--trace-dir <dir>` on `onboard`, `source fetch --wait`, and `overview batch --wait` writes the terminal session/workflow as `<dir>/<id>/{trace.json,summary.md}`; `admin discovery task get <id> --save [dir]` snapshots an existing session retroactively. Trace dir precedence: explicit flag > `RELEASES_RUN_DIR` > `~/.releases/work/runs`. `summary.md` mirrors the run-summary template in the monorepo's `docs/architecture/maintenance-workspace.md`.

## 0.40.1

### Patch Changes

- c33f97f: Better unknown-command suggestions, `--help` examples, and a `sources` alias for `list`.
  - **Unknown-command suggestions:** `releases serch foo` now prints `(Did you mean search?)` instead of the misleading "too many arguments" error. Root cause was the root `.action()` swallowing unrecognised tokens before Commander's suggestion engine could fire; fixed by allowing excess args on the root and delegating to `unknownCommand()`.
  - **`releases sources` alias:** `releases list` now accepts `sources` as an alias, so `releases sources --kind sdk` works. The alias is top-level only — `releases admin source` is unchanged.
  - **`--help` examples:** Added `Examples:` blocks to `list`, `search`, `admin source update`, `admin product create`, and `admin product update`.

## 0.40.0

### Minor Changes

- fbd856f: Add `releases auth` commands (`login`, `logout`, `status`, `token`) to store a verified API token in `~/.releases/credentials` (0600). `whoami` now aliases `auth status`. Tokens are verified against `GET /v1/tokens/me` before saving; the env var `RELEASED_API_KEY` still takes precedence.

### Patch Changes

- 69a38dc: Strip null/undefined fields from the `POST /v1/sources` request body in `createSource()`. The API's Zod schema treats `z.string().optional()` as "string or absent" — an explicit `"productId": null` in the JSON body trips the validator and 400s. Sending `--org <slug>` without `--product` previously triggered this. The fix filters null/undefined values before serialization so optional fields drop out cleanly.

## 0.39.0

### Minor Changes

- 7a2307c: Add `--metadata-set <key=value>` and `--metadata-unset <key>` flags to `releases admin source update`. Both are repeatable and thread through the existing `updateSourceMeta` client-side merge, so one-off source metadata patches (e.g. `--metadata-set crawlEnabled=true --metadata-set githubUrl=https://github.com/docker/compose`) no longer require custom scripts. Value coercion follows standard CLI conventions: `true`/`false`/`null` become JSON literals, finite number strings become numbers, values starting with `{` or `[` are parsed as JSON, and everything else is kept as a string.
- 1af16a3: Add `--kind <value>` support for the new source/product taxonomy (`platform | sdk | mobile | desktop | docs | integration | tool`). Write paths (`releases admin source update`, `releases admin product update`, `releases admin product create`) accept the flag and validate locally via `isValidKind` before hitting the API. Read paths (`releases list`, `releases admin source list`, `releases admin product list`, `releases search`) accept `--kind` as a filter and pass it through as a query string. The API applies inheritance (`COALESCE(source.kind, product.kind)`) on content-oriented surfaces and direct equality on metadata-oriented surfaces; see the help text for the per-command behavior. Bumps the pinned `@buildinternet/releases-core` and `@buildinternet/releases-api-types` to `^0.22.0`.

## 0.38.1

### Patch Changes

- d92295c: Set +x on the cross-compiled platform binaries before they're gzipped for distribution. Bun's `--compile` produces 0644 outputs for cross-targets on Linux runners, so the Homebrew formula's `bin.install` (which preserves source mode) landed a non-executable binary. v0.38.0 added a completion-generation step that exec'd the binary during install and failed with EACCES; the formula template now also chmods the binary defensively before install.

## 0.38.0

### Minor Changes

- df7dcae: feat(cli): add `--paused` / `--no-paused` flags to `admin org update` for the org-level ingest pause flag landed in [buildinternet/releases#1064](https://github.com/buildinternet/releases/pull/1064). Mirrors the existing `--enable` / `--disable` shape on `admin source update`; lands on the deprecated `edit` alias too. Pins `@buildinternet/releases-api-types` to `^0.20.0` so the typed `fetchPaused` field on `UpdateOrgBody` is in scope downstream. (#178)
- 21d41b2: MCP `list_organizations` now mirrors the remote MCP default of hiding orgs
  with zero indexed releases. Pass `include_empty: true` to see them.
  CLI `releases org list` gains `--include-empty` for the same opt-in.
  See buildinternet/releases#746.
- a4729e3: feat(cli): add shell completion support for bash, zsh, and fish. `releases completion <bash|zsh|fish>` prints the script to stdout; `releases completion install` detects the user's shell and writes the script to the conventional location, mirroring how `gh` ships completions. Once the matching tap formula update in buildinternet/buildinternet-homebrew-tap lands, Homebrew will install all three shells automatically — until then, `brew` users should run `releases completion install`. On interactive TTYs, a one-time stderr hint nudges users who haven't installed completions yet — silence with `RELEASES_NO_COMPLETION_HINT=1`.
- 5b1c5ae: feat(cli): add `releases skills install` for cross-agent skill installation (#187). Thin wrapper around `npx skills add buildinternet/releases-cli` from the open agent-skills ecosystem (`vercel-labs/skills`), which auto-detects ~50 supported coding agents (Claude Code, Cursor, Codex, Gemini CLI, Windsurf, GitHub Copilot, …) and writes the 8 bundled skill files to the right per-agent directory. Forwards `--global`, `--agent <name>`, `--copy`, `--list`, and `--no-yes` to the underlying `skills add` invocation. Skills are symlinked by default, so re-running the command refreshes everything atomically.
- 05f08be: feat(cli): nag when installed agent skills are behind the repo's `main` HEAD (#188). After a successful `releases skills install`, the CLI records the current `skills/` tree SHA as a baseline. Subsequent invocations poll GitHub (24h cache, 2s timeout, best-effort) and print a single dim stderr line — "Your installed releases skills are behind. Run `releases skills install` to refresh." — when the baseline diverges. Also reads the `skills` CLI's lock file (`$XDG_STATE_HOME/skills/.skill-lock.json` or `~/.agents/.skill-lock.json`) to suppress the nag when the user has clearly uninstalled via `skills` (lock present, zero `buildinternet/releases-cli` entries); manual installers and users without a lock file fall through to the existing baseline check, unchanged. Mirrors the existing CLI update-check pattern, with the same skip conditions (`--help`/`--version`, non-TTY, no baseline recorded) plus a fresh `RELEASES_DISABLE_SKILL_UPDATE_CHECK=1` opt-out.
- 839ab72: Remove deprecated `--notes` and `--parse-instructions` inline flags (Phase 2 of #103).

  Both flags were deprecated in Phase 1 (#118) with file-based replacements. They are now removed; passing either flag exits non-zero with `unknown option`. Use `--notes-file` and `--parse-instructions-file` (or `-` for stdin) instead.

### Patch Changes

- 5aad6aa: chore(cli): bump `@buildinternet/releases-api-types` to `^0.21.0` and align `sourceToMarkdown` with the cursor-paginated `SourceDetail` shape. The helper had no callers in production code; this is a types-alignment fix with zero runtime impact.
- 3b4b2a9: fix(cli): allow 0 for --min-new-releases and --min-overview-age-days in `admin overview batch` to match API contract (#174)
- ac18409: fix(cli): reject partial integers in parsePositiveIntFlag — "1.5" and "10abc" no longer silently truncate to 1 and 10 (#177)

## 0.37.0

### Minor Changes

- fe9ce0b: `releases admin overview batch` wraps the new `BatchOverviewWorkflow` (`POST /v1/workflows/batch-overview`). Flags map 1:1 to the workflow body: `--orgs <slug,slug>`, `--min-new-releases`, `--min-overview-age-days`, `--max-candidates`, `--max-cost-usd`. Pass `--wait` to poll the status endpoint every 30s until the workflow reaches a terminal state; without it the command prints `instanceId` + `statusUrl` and returns immediately.

  Sits next to the agent-driven `admin overview inputs` / `admin overview update` so the batch path is discoverable alongside the single-org regen flow. Closes #1005.

### Patch Changes

- ba51bdb: `releases org update --avatar <url>` now works end-to-end. The flag was already wired (it set `avatarUrl` in the PATCH body) but the API silently dropped the field via Zod's default unknown-key stripping. The matching API change landed in `buildinternet/releases#979`; once that ships in the published `releases-api-types` rev, the CLI's `--avatar` and `--no-avatar` flags affect the server state for real.

  Forward-compatible: existing scripts that already use `--avatar` start working without any CLI change — the wire shape didn't move, only the server-side acceptance did.

## 0.36.0

### Minor Changes

- d6c54fb: Improve the default `releases get` output for all entity kinds so the response is useful on its own without flag discovery, while staying token-efficient via progressive disclosure to the dedicated drill-in commands.

  - **Release**: the summary is now labeled `Summary · AI-generated, abbreviated` (it was unlabeled before, so callers couldn't tell it wasn't the full body). Every response ends with a `Next steps` footer that points at `releases release get <id>` for the full content — phrasing flips when no summary is on file yet.
  - **Organization**: now surfaces description, tags, a source breakdown (active / erroring / hidden), and the product list with names + slugs. Latest-releases preview trimmed from 10 to 5. Footer hints at `org get` (overview / accounts / aliases), `org overview`, and the org-scoped release feed.
  - **Product**: previously showed only static metadata. Now adds description, tags, and the product's source list, with footer hints to the org-scoped release feed and to drilling into a specific source.
  - **Source**: previously showed only static metadata. Now adds org/product binding, fetch status (active / erroring / hidden), `lastFetchedAt`, and the latest 5 releases for the source. Footer hints at `list --source`, `fetch-log`, and `release get`.

  Also fixes a latent bug in `getProductsByOrg`: `/v1/products` returns a paginated envelope but the client typed the response as a bare array, so every downstream `for/find/filter/map` was silently no-op'ing. That's why the previous `releases org get` Products section never rendered for orgs that had products (e.g. Supabase's Auth / CLI / Client SDK). The client now unwraps the envelope and tolerates the legacy bare-array shape.

  JSON output gains a few additive fields (`sources`, `products`, `sourceCount`, `tags`) on the org/product responses; existing fields are unchanged.

- 0fba348: Surface collections in `releases search` output. Direct LIKE matches on the collection's name/slug/description appear in a new "Collections" section, alongside member rollups for collections containing one of the matched orgs (with an `↳ includes …` hint). Use `--type collections` to narrow to that section. JSON output includes a new `collections` array on the response shell.

  Forward-compatible: the field is read as optional, so older API deployments mid-rollout still work — they just return `undefined` and the section stays empty until the API ships the matching change (`buildinternet/releases#955`).

### Patch Changes

- bf5e20d: Surface release body size on the latest-releases table (`releases get <org>`, `releases get <src_…>`, `releases tail`). Each row picks up a dim "~1.5K tokens" hint next to the title when the cached `contentTokens` field is available, so agents browsing a feed can decide whether to pull the full body before spending the round-trip. Compact mode only shows the hint for releases ≥1K tokens; `--with-summary` shows it on every row.

  Forward-compatible: the field is read as optional. API deployments mid-rollout return `undefined` and the hint is silently dropped. Lights up once `@buildinternet/releases-api-types` ships the matching wire-shape change (`buildinternet/releases#958`).

## 0.35.3

### Patch Changes

- 508fceb: Bump `@buildinternet/releases-core` to `^0.21.0` and `@buildinternet/releases-api-types` to `^0.16.0` so the bundled `CATEGORIES` constant picks up the `commerce`, `crm`, `finance`, and `productivity` slugs added in buildinternet/releases#889 and buildinternet/releases#891. Without this, `releases admin org update --category crm` (and the three other new slugs) rejects locally even though the API accepts them.

## 0.35.2

### Patch Changes

- f8f4654: Update the reader skill reference to mention the editable categories overlay (`PATCH /v1/categories/:slug`) and alias resolution behavior introduced in buildinternet/releases#889.

## 0.35.1

### Patch Changes

- 4998290: Drop deprecated `contentSummary`, `contentTitle`, and `contentTitleShort` aliases from all read paths. The CLI now reads only the canonical `summary`, `titleGenerated`, and `titleShort` fields introduced in buildinternet/releases#860. This is the consumer-side preflight gate for the alias removal tracked in buildinternet/releases#866.

## 0.35.0

### Minor Changes

- 14fa12d: Add `--title-generated`, `--title-short`, and `--summary` flags to `releases release update`. They write through to the API's PATCH /v1/sources/:slug/releases/:id endpoint, which exposes the renamed AI-generated release fields introduced in buildinternet/releases#860.

  Pass an empty string to clear a field (e.g. `releases release update rel_xxx --summary=""` writes NULL).

  The new fields are accepted by registries running api-types 0.13.0 or later; older registries silently ignore the unknown body keys.

## 0.34.0

### Minor Changes

- cb4c1bf: `admin overview update` accepts an optional `--citations-file <path>` pointing
  at a JSON array of inline citations (`{startIndex, endIndex, sourceUrl, title?,
citedText}[]`). The CLI validates the shape locally and forwards the array to
  `POST /v1/orgs/:slug/overview`, which persists them to `knowledge_page_citations`
  with replace-all semantics. Pairs with the regenerating-overviews skill, which
  now passes the file produced by the agent's response walk.

## 0.33.0

### Minor Changes

- 913fdd2: Collections are now first-class browsable from the CLI.

  - `releases collection list` and `releases collection get <slug>` are public — no API key needed. The same commands also stay under `admin` for back-compat.
  - New `releases collection releases <slug>` shows the cross-org release feed with cursor pagination (`--limit`, `--cursor`, `--include-prereleases`).
  - `releases get <orgslug>` now lists the collections an org belongs to. Failures degrade silently with a logger warning so an unrelated bug in the collections endpoint never breaks the canonical org card.

  The wire shape for `CollectionReleaseItem` isn't published in `@buildinternet/releases-api-types` yet, so the CLI declares it inline. When api-types ships its next minor, the inline type can drop.

- d2053e3: Tabular reader commands (`get`, `org list`, `product list`, `list sources`, `collection list`, `stats`, `check`, `fetch-log`, `admin overview list`, `admin overview plan`) now fit themselves to the terminal width instead of relying on bordered tables that broke when the window was narrow.

  - TTY: borderless, two-space delimited columns; uppercase cyan headers; per-column truncation with `…`; per-column right-alignment for counts. Width is read from `process.stdout.columns` (override with `COLUMNS=<n>`).
  - Non-TTY (piped): bare TSV — no headers, no color, no truncation — so `releases org list | cut -f2` works without parsing ANSI. For complete parseable output, prefer `--json`.

  Replaces `cli-table3` with a small in-tree renderer in `src/cli/render/table.ts` that uses `string-width` for accurate width measurement on ANSI-colored and wide-character cells. Per-column `noTruncate: true` locks a column to its natural width (e.g. release IDs, dates).

## 0.32.0

### Minor Changes

- 49873f1: Add `--category-allow <list>` and `--no-category-allow` flags to `releases admin source update` for setting per-source `metadata.categoryAllow` directly. Drops feed items whose `<category>` doesn't intersect the allowlist (case-insensitive); items with no category are dropped too. Useful on mixed-topic feeds where the upstream tags every entry — `openai.com/news/rss.xml` is the motivating case. Worker-side filter ships in buildinternet/releases#821.

  Also adds `scripts/bulk-suppress.ts`, an operator utility that reads `{id, reason}` NDJSON on stdin and runs `releases.suppress` with bounded concurrency (default 8). Used to clean up the existing noise on a source after enabling `categoryAllow`.

- 2cb93bb: Add `--changelog-paths` and `--no-changelog-paths` flags to `releases admin source update` for setting per-source `metadata.changelogPaths` overrides directly. Replaces the previous workflow of dropping to a raw `curl` against `/v1/sources/.../metadata`. Caps at 20 paths client-side to match the API worker's `CHANGELOG_MAX_FILES`.

## 0.31.0

### Minor Changes

- 052e167: Add `releases admin collection` command tree for managing curated cross-org collections (the playlists rendered at `/collections/<slug>` on the registry web app). Subcommands: `list`, `get <slug>`, `create <name>`, `update <slug>`, `delete <slug>`, plus `members add | set | remove` for membership management. Wraps the new admin write endpoints introduced in the registry API (#813); requires `@buildinternet/releases-api-types@^0.9.0`.

### Patch Changes

- 37b7bac: Drop the local `SessionDetail` shim in `task get` now that `@buildinternet/releases-api-types@0.8.1` exposes `agent`, `runner`, `correlationId`, `anthropicSessionId`, `usage`, `warnings`, and `result` natively on `Session`.

## 0.30.0

### Minor Changes

- a3e7980: Add `releases lookup domain <domain>` for resolving any URL-shaped input to its registry org/products, and `--domain <domain>` on `releases search` for scoping a search to a single org by domain. Mirrors the new `GET /v1/lookups/by-domain` API endpoint and `lookup_domain` MCP tool.
- 79cf3af: Add `releases admin discovery task get <session-id>` for full session detail (timing, usage, errors, agent state). Add `releases admin product adopt --merge-into <product>` to fold a source org into an existing product instead of creating a new one. Both close out items in buildinternet/releases#794.

## 0.29.0

### Minor Changes

- 41cb6d4: Extend `--dry-run` coverage to the remaining mutating `admin` commands.

  Previously only delete-shaped commands and a few specials (`source import`, `product adopt`, `release suppress`, `policy ignore/block`, `embed`) could preview their effects. Create/update/link verbs went straight to the API, which made scripted onboarding flows hard to validate before running them.

  Now also supports `--dry-run`:

  - `admin org create` (+ deprecated `org add`)
  - `admin org update` (+ deprecated `org edit`)
  - `admin org link`, `admin org unlink`
  - `admin product create` (+ deprecated `product add`)
  - `admin product update` (+ deprecated `product edit`)
  - `admin source create` (+ deprecated `source add`)
  - `admin source update` (+ deprecated `source edit`)
  - `admin release update` (+ deprecated `release edit`)
  - `admin release unsuppress`

  For `source create`, the dry-run still resolves the org (creating it would normally happen here, so the preview reports "would create" instead) and runs the existing-URL and exclusion checks before reporting the planned write — operators get the same rejection signal they would on a real run, without writes. Same idea for `source update`'s auto-create-org branch.

  Tag and alias add/remove on org/product still don't take `--dry-run`; those are trivially reversible joins where the preview adds little.

- f1f3fdb: Add `--into-org` / `--into-product` flags to `releases admin discovery onboard` and exit non-zero when `releases admin source create` finds a URL collision with mismatched org/product attribution. Both surfaced during the multi-product Google onboarding (#794).

  `--into-org <slug>` (and optionally `--into-product <slug>`) pin the discovery agent to attach every source it adds to that existing org/product, instead of the default behavior of letting the agent auto-create new ones. Eliminates the manual cleanup of orphan orgs that used to follow multi-product onboarding under an existing org. Server-side scope plumbing lands in the monorepo PR; the API surface is `intoOrgSlug` / `intoProductSlug` on `POST /v1/workflows/discover`.

  `source create` previously soft-warned and returned `existed: true` when the URL was already attached to a different org/product than the one passed via `--org` / `--product`. It now exits non-zero with the current attribution and a `releases admin source update` hint. `--strict` continues to reject any URL collision regardless of attribution.

### Patch Changes

- 9801893: Fix `releases admin overview inputs <org> --json` ignoring the flag and printing the chalk-formatted summary instead of JSON.

  Root cause was a commander parsing quirk: the deprecated bare `overview <org>` form is registered with `.argument("[org]")` on the same `overview` command that hosts subcommands like `inputs`, `get`, `update`. Without positional option scoping, options that follow a subcommand's positional arg (`overview inputs google --json`) were being swallowed before the subcommand could see them. The same bug affected `--check --json` and silently dropped any subcommand option that appeared after the org slug.

  Fixed by enabling `.enablePositionalOptions()` at the program level so each command's options are scoped to their own position. The deprecated `overview <org>` bare form still works.

## 0.28.1

### Patch Changes

- 1e617b8: Soften the not-found UX for read-only lookups (`releases get`, `releases release get`) and parallelize `releases get` fallback resolution.

  A miss on `releases get <thing>` is a normal answer for a lookup, not a software fault. The output now reads `[releases] No <kind> matching: <input>` (info-level, no red `ERROR:` framing). In `--json` mode the command also writes `null` to stdout before the stderr line, so JSON consumers get parseable output instead of nothing. Exit code stays `1` — the contract for "scripts can detect a miss" doesn't change.

  When the identifier doesn't carry a typed-ID prefix, `releases get` previously made up to three sequential API round-trips (`findOrg` → `findProduct` → `findSource`) before giving up. Those now run in parallel via `Promise.all`, so a miss takes ~one round-trip instead of three. Hits behave the same — the first matching kind wins.

  Mutating commands (`release delete/update/suppress/unsuppress`, `delete`, `update`, `ignore add/remove`, `product alias`, etc.) keep the louder error treatment; for those, "thing doesn't exist" really is an error.

## 0.28.0

### Minor Changes

- 724020c: Restructure `admin overview` as a subcommand group and add the planning manifest commands (closes [buildinternet/releases#715](https://github.com/buildinternet/releases/issues/715)).

  Canonical surface mirrors the verb-rename pattern (PR #113) — `admin overview list/get/update/inputs/plan` are subcommands under `admin overview`. The legacy kebab-case names (`overview-list`, `overview-write`, `overview-inputs`, and the bare `overview <slug>` read form) are wired as deprecated aliases that warn-and-delegate to the same handler.

  New planning surface:

  - `admin overview list --stale-days <n> --missing --has-activity --json` — drives `GET /v1/admin/overviews`, returning a planning-ready manifest in one call instead of `org list` + per-org `overview` round-trips. Each row includes `releasesSinceOverview` (the freshness signal that actually matters), `staleness` (`missing | behind | fresh`), `orgLastActivity`, etc. The legacy `--stale / --stale-min-releases / --stale-grace-days` flags still work and trigger the older client-side scan.
  - `admin overview plan --json` — same manifest with `format=plan`, adding per-row `action` (`missing | refresh | skip`) and `needsFetch` (true when active sources exist but ingest is lagging ≥ 7 days).
  - `admin overview inputs <org> --check` — pre-flight payload (`{orgSlug, selected, totalAvailable, hasExistingContent, wouldRegenerate, windowDays}`) so an orchestrator can decide whether to dispatch a regen sub-agent without paying for the full release-content + media payload.

  Requires `@buildinternet/releases-api-types` 0.6.0 on the server side.

### Patch Changes

- 7404ab5: Drop the local `EvaluationResult` and `OrgDependentsResponse` declarations from `src/api/types.ts` and pull both from `@buildinternet/releases-api-types` 0.7.0 instead. The carve-outs were only there because the canonical types lived in private monorepo packages; both have been upstreamed (`OrgDependentsResponse` since api-types 0.5.0, `EvaluationResult` in 0.7.0 — buildinternet/releases#569). No surface change for CLI consumers — the same shapes are now imported via `export * from "@buildinternet/releases-api-types"`.

## 0.27.0

### Minor Changes

- 0bc1f59: Accept typed IDs (`org_…`, `prod_…`, `src_…`, `rel_…`) anywhere a slug works.

  Help text and argument descriptions across `delete`, `fetch-log`, `tail`,
  `check`, `release`, `add`, `update`, `product`, `org`, `ignore`, `list`, and
  `fetch` now read "ID or slug" — no command rejects a typed ID anymore. The API
  accepted both shapes already; this aligns the CLI surface and docs with that
  contract. The `releases-cli` and `releases-mcp` skills are updated to recommend
  typed IDs in agent prompts where stability matters more than readability.

  Internally, `findOrg`, `removeOrg`, `getOrgDependents`, `updateOrg`,
  `getRecentReleases`, `getOverview`, `getPlaybook`, `getAliases`, and
  `setAliases` rename their `slug` parameter to `identifier` and gain
  `encodeURIComponent` wrappers (the path-building was previously unencoded —
  fine for current slug shapes but a lurking bug). `getFetchLogs({ sourceSlug })`
  becomes `getFetchLogs({ source })` and `getLatestReleases({ slug, orgSlug })`
  becomes `getLatestReleases({ source, org })` — both still accept whatever
  identifier shape the user types.

## 0.26.0

### Minor Changes

- 74297a5: Add `--notes-file` and `--parse-instructions-file` flags for AI-generated multi-paragraph content (#103 workstream 3). The inline `--notes` and `--parse-instructions` forms are quote-hostile and silently truncate at unescaped newlines, which is exactly the shape of content these flags get fed.

  - `releases admin playbook <org> --notes-file <path>` (use `-` for stdin) replaces inline notes.
  - `releases admin source update <id> --parse-instructions-file <path>` (use `-` for stdin) replaces inline parse instructions. The deprecated `edit` alias gets the same flag.
  - An empty file clears, matching the existing inline empty-string semantics.
  - Passing both forms together errors: `--notes and --notes-file are mutually exclusive` / `--parse-instructions and --parse-instructions-file are mutually exclusive`.

  The inline forms still work in this release but emit a stderr deprecation warning per invocation pointing at the file form. They will be removed in a future minor release.

  Skill manifests (`skills/managing-sources`, `skills/seeding-playbooks`) and bundled agent docs are updated to use the file form. While in there, the agent docs' stale `releases admin content playbook` path is corrected to the canonical `releases admin playbook`.

### Patch Changes

- 57e8a68: Apply `--tags` on idempotent `org create` retry (#116). When `releases admin org create acme --tags react` is followed by `releases admin org create acme --tags typescript`, the second call now adds `typescript` to the existing org instead of silently dropping the flag. Tag merging is additive (no removal), and `--strict` continues to bail on duplicate detection before reconciliation runs.

## 0.25.0

### Minor Changes

- b2938c0: Add `releases agent-context` command that emits a versioned JSON document describing every command, argument, option, and exit code in the CLI.

  This is the L2 introspection layer described in the [10-principle agent-native CLI guide](https://trevinsays.com/p/10-principles-for-agent-native-clis): agents driving the CLI can answer questions like "does this flag accept stdin?" or "what commands are deprecated?" without spawning `--help` per command and parsing prose.

  The schema is generated at runtime by walking Commander's program tree — it stays automatically in sync with the implementation. `schemaVersion` is a string that bumps only on breaking field renames or removals; additive changes (new commands, new options, new fields) are silent.

- b94319a: Make `org create` and `source create` idempotent on retry. When a duplicate slug (org) or duplicate URL (source) is detected, the existing record is returned instead of erroring — exit code 0, JSON output gains an `existed: true` field. Pass `--strict` to restore the previous exit-1 behavior for callers that require hard failure on conflict.
- 3971251: Add `--limit <n>` / `--page <n>` pagination to four list commands and consume the
  `{ items, pagination }` envelope the API now returns for `/v1/orgs`,
  `/v1/admin/blocklist`, `/v1/orgs/:slug/ignored-urls`, and `/v1/sessions`
  (monorepo PR #723):

  - `releases org list`
  - `releases admin discovery task list`
  - `releases admin policy block list`
  - `releases admin policy ignore list`

  All four pass `?limit=&page=` through to the API and read the server's
  pagination metadata directly — no more client-side `Array.slice()`. Each prints
  a `warning: results may be truncated` message to stderr when more pages are
  available and no explicit `--limit` was supplied, mirroring `releases list`.
  Closes #105.

- a27f459: Adopt the `-` stdin convention in two more commands and tighten `--json` output safety on alias listings.

  - `releases import <file>` now accepts `-` for stdin (`cat manifest.json | releases import -`). Removes the temp-file dance for callers that generate manifests from another command.
  - `releases admin webhook verify --body-file <path>` now accepts `-` for stdin (`curl ... | releases admin webhook verify --secret ... --signature ... --body-file -`). Mirrors the convention already in `add --batch -` and `admin overview-write --content-file -`.
  - `org alias list --json` and `product alias list --json` now route through the drain-safe `writeJson()` helper instead of `console.log(JSON.stringify(...))`. Closes the small remaining surface area of the 96 KB pipe-truncation class first fixed in #33.

  Shared internal helper `readContentArg(pathOrDash)` lives in `src/lib/input.ts` for use by future file-or-stdin commands. No breaking changes — existing `--content-file <path>` / positional `<file>` invocations continue to work unchanged.

- 1821835: Rename CRUD verbs to standard create/get/update/delete equivalents. The old verb names (add, show, edit, remove) are retained as deprecated aliases that continue to work but print a deprecation warning to stderr. This affects top-level commands and all `org`, `product`, `source`, and `release` subcommands.

### Patch Changes

- f9eb1e2: Documents the exit-code taxonomy in README and root help output.

## 0.24.0

### Minor Changes

- 0c244f3: Adopt the org-scoped API path shape so the CLI keeps working after the monorepo rejects bare-slug source/product paths with 400 (#698).

  - `findSource(identifier)` and `findProduct(identifier)` now branch on the input shape: typed `src_…`/`prod_…` IDs hit the legacy bare path (still safe — IDs are globally unique), `org/slug` coordinates split into the org-scoped form, and bare slugs round-trip through the new `GET /v1/lookups/{source,product}-by-slug` resolver to pick a canonical home before fetching.
  - Mutation helpers (`updateSource`, `deleteSource`, `deleteSources`, `deleteReleasesForSource`, `insertReleasesBatch`, `checkContentHash`, `updateSourceMeta`, `updateProduct`) now take a typed-ID-bearing entity object instead of a slug string and target the bare path with `id`, which the API still accepts.
  - `getKnownReleasesForSource(identifier, …)` accepts the same identifier shapes as `findSource`.

  No CLI command surface changes — operators continue to type slugs, IDs, or `org/slug` coordinates wherever an identifier is accepted. The slug branch costs one extra round-trip to the lookup endpoint per command (cached aggressively at the network layer), which is the price for unambiguous resolution after #690 made slugs per-org.

- 2a775fb: `admin org delete --hard` now shows a cascade-scope preview and requires the user to type the org slug back to confirm. Backs the post-#690 Phase C schema, where hard-deleting an org now cascades into every source, release, fetch_log, changelog file/chunk, release summary, media asset, and webhook subscription tied to it (vs. orphaning sources via SET NULL pre-flip).

  - `releases admin org delete <slug> --hard` lists exact dependent counts, then waits for slug typeback. Wrong slug aborts with exit 1 and no API call to the destructive endpoint.
  - `--yes` / `-y` skips the prompt for scripted ops.
  - A piped (non-TTY) stdin without `--yes` exits 1 with a clear "no interactive TTY" message instead of silently auto-confirming.
  - Soft-delete (default, no `--hard`) is unchanged — still tombstones via `deleted_at`, no prompt.
  - `admin org remove` continues to work as an alias of `admin org delete`.

  Counts are pulled from the new `GET /v1/admin/orgs/:slug/dependents` endpoint, so the preview matches whatever the API would actually cascade-delete. Requires `@buildinternet/releases-api-types` ≥ 0.5.0 on the server side.

### Patch Changes

- 57cad43: Bump `@buildinternet/releases-api-types` to `^0.4.0`. Adds the optional `type: "feature" | "rollup"` field to release-shaped wire types (`ReleaseItem`, `ReleaseDetail`, `SearchReleaseHit`) so consumers can render rollup posts (Brex Fall Release, Ramp quarterly editions, etc.) differently from feature releases. Optional on the wire — older API responses degrade gracefully.

## 0.23.0

### Minor Changes

- c80aacb: feat(cli): publish a Windows x64 binary. `npm install -g @buildinternet/releases` now works on Windows; the dispatcher resolves `releases.exe` from the new `@buildinternet/releases-windows-x64` platform package. Homebrew remains macOS/Linux-only. `windows-arm64` is intentionally not shipped — open an issue if you need it.

## 0.22.1

### Patch Changes

- d61db7e: fix(cli): show full release IDs in `search`, `tail`, and the releases table. The previous 12-char prefix wasn't usable for any follow-up call (the API only resolves full IDs, not short forms), so the truncation was misleading without saving real horizontal space.

## 0.22.0

### Minor Changes

- 1901903: `webhook verify` now enforces a ±5 minute timestamp window by default to prevent replay-attack acceptance. Pass `--allow-stale` to skip the window check when verifying old captured payloads.

## 0.21.0

### Minor Changes

- de74c5f: Add on-demand lookup rendering to `releases search`. When the API returns a `lookup` payload (coordinate-shaped queries like `org/repo` that miss every curated entity), a new **Lookup** section prints before the regular results — covering all five outcomes (`indexed`, `existing`, `empty`, `not_found`, `deferred`) plus an inline release preview (up to 5) and a "Did you mean" rail when the org segment matches a curated org. The payload is also included in `--json` output. Bumps the `@buildinternet/releases-api-types` pin to `^0.3.0`.

## 0.20.2

### Patch Changes

- 4178044: Adopt the `catalog` rename in unified search responses (monorepo issue #539 follow-up). `releases search` now reads `response.catalog` and renders the section as **Catalog** in human and markdown output (it covered products + standalone sources already; the header now matches the wire field). `--type catalog` is the canonical filter; `--type products` is accepted as a deprecated alias. The deprecated `response.products` field is still read as a fallback so older API deploys keep working — that fallback can be dropped once the alias is removed from the wire. Plugin docs and the `releases-mcp` skill updated to point at the new `search` / `list_catalog` / `get_catalog_entry` MCP tools.
- ac4a443: Disable oxlint's `no-underscore-dangle` rule, surfaced by the 1.62 upgrade. The codebase deliberately uses leading-underscore identifiers for module-private state (`_dataDir`, `_apiUrl`, `_apiKey`, `_admin`); the rule's complaints aren't actionable. Keeps lint output clean and matches the same change in the monorepo for cross-repo consistency. CI-only; no runtime change.

## 0.20.1

### Patch Changes

- 24316b1: Move admin blocklist calls to `/v1/admin/blocklist` (was `/v1/blocked-urls`). The registry renamed the route to align with the `/v1/admin/...` convention; the old path is going away. Affects `releases admin block` / `unblock` and the `releases whoami` admin probe.

  Closes [registry #524](https://github.com/buildinternet/releases/issues/524).

- c0935e7: Add the `bun` ecosystem to the Dependabot config so npm dependency bumps land as weekly grouped PRs (production and dev separated). Pairs with the SHA-pinned GitHub Actions config — bun.lock already pins every package by sha512 integrity hash and CI runs with `--frozen-lockfile`, so this closes the loop on surfacing upstream drift. CI-only; no runtime behavior change.

## 0.20.0

### Minor Changes

- cb55e62: `releases admin source fetch` now accepts `--wait [seconds]`, blocking until the managed-agent session reaches a terminal state. Without `--wait` the command stays fire-and-forget. Default wait is 900s; pass an explicit value to shorten it (e.g. `--wait 60`).

  Exit codes:

  - `0` — session completed successfully
  - `1` — our-side error (no tools called, parser failure, timeout)
  - `2` — managed-agents/provider error (e.g. `unknown_error`, `model_overloaded_error`, retries exhausted) — the message is tagged `(managed-agents · <type>)` and includes retry count when the session ended in `retries_exhausted`
  - `130` — session cancelled

  Closes the silent-failure gap surfaced in [registry #590](https://github.com/buildinternet/releases/issues/590) where backend incidents bubbled up as `exit 0` even though no work happened.

- f0eab05: `releases admin overview-list` lists organizations with their overview status. Pass `--stale` to filter to orgs whose overviews need regeneration:

  ```
  releases admin overview-list --stale
  releases admin overview-list --stale --stale-min-releases 3 --stale-grace-days 14
  releases admin overview-list --stale --json
  ```

  An org is considered stale when `recentReleaseCount > minReleases` AND the overview is either missing or `lastActivity > overview.updatedAt + graceDays`. Defaults: `minReleases=5`, `graceDays=7`.

  The `--json` output carries `slug`, `name`, `recentReleaseCount`, `lastActivity`, `overviewUpdatedAt`, and `overviewMissing` — suitable for piping into the weekly regen routine (registry trigger `trig_012B14fpLS1inAkEuJTZBbnd`) which currently encodes this filter in its prompt.

  Closes [registry #590](https://github.com/buildinternet/releases/issues/590) item 6.

### Patch Changes

- ec6a649: Bump `@buildinternet/releases-api-types` to `^0.2.0`. The classification fields (`errorSource`, `errorType`, `stopReason`, `retryCount`) added by the registry to the `Session` shape now come straight from the published types, so the CLI's local `SessionWithClassification` extension is gone. No behavior change.
- 41b7a95: `releases admin overview-write` now accepts `--unescape-html`, which runs a small pre-upload pass to decode `&amp;`, `&lt;`, `&gt;`, `&quot;`, and `&#39;`. Useful when the markdown was generated by a sub-agent that escaped entities reflexively.

## 0.19.5

### Patch Changes

- 487ea5b: Replace the handwritten `src/api/types.ts` with a re-export from the newly-published `@buildinternet/releases-api-types` package. Eliminates drift between the CLI's wire-protocol types and the monorepo source.

  Additive fields now surfaced on `--json` output:

  - Source shapes gain `lastPolledAt`, `medianGapDays`, `lastRetieredAt`
  - New `ReleaseCoverageResponse` / `ReleaseCoverageRow` types for release coverage consumers
  - `SearchCatalogHit` is now the canonical name for catalog/product search hits (`SearchProductHit` remains as a deprecated alias)

## 0.19.4

### Patch Changes

- 31c2a64: Admin log routes moved under `/v1/admin/logs/*` on the API per issue #504 tier 3. The `releases admin source fetch-log` command and `getUsageStats` / `postUsageLog` / `postFetchLog` helpers are unchanged from the user's perspective, only the underlying URLs shift:
  - `GET /v1/fetch-log` → `GET /v1/admin/logs/fetch`
  - `POST /v1/fetch-log` → `POST /v1/admin/logs/fetch`
  - `GET /v1/usage-log/stats` → `GET /v1/admin/logs/usage/stats`
  - `POST /v1/usage-log` → `POST /v1/admin/logs/usage`

## 0.19.3

### Patch Changes

- 4f9ed94: Discovery triggers moved under `/v1/workflows/*` on the API per issue #504 tier 2. The `releases admin discovery onboard` and `releases admin fetch` commands are unchanged from the user's perspective, but the underlying URLs now follow the convention:

  - `POST /v1/discover` → `POST /v1/workflows/discover`
  - `POST /v1/update` → `POST /v1/workflows/update`
  - `GET /v1/discover/:sessionId` is gone — the CLI polls `GET /v1/sessions/:sessionId` instead, which reads from the same DO with a richer shape (progress fields live at the top level, not nested under `progress`).

- 1ef271f: Follow-up to the overview nesting: three more API surfaces moved under their parent resource.

  - Playbook: `getPlaybook(slug)` and `updatePlaybookNotes(slug, notes)` now call `/v1/orgs/:slug/playbook` and `/v1/orgs/:slug/playbook/notes`.
  - Summaries: `getSummariesForSource`, `upsertSummary`, and `getMonthlySummary` now call `/v1/sources/:slug/summaries`. `upsertSummary`'s signature changed from `(data)` (with `sourceId` in the body) to `(sourceSlugOrId, data)`.
  - Aliases: the `/v1/aliases` endpoints are gone. Domain aliases are now a `string[]` field on the parent — read via `/v1/orgs/:slug` or `/v1/products/:slug`, written via `PATCH { aliases: [...] }` on the parent. The CLI replaces `addDomainAlias`/`removeDomainAlias`/`listDomainAliases` with `getAliases(scope, slug)` and `setAliases(scope, slug, aliases)`. `releases org alias add|remove|list` and `releases product alias add|remove|list` commands are unchanged from the user's perspective.

  `/v1/knowledge` is also gone from the API. No CLI helper referenced it.

- 049528f: Overview admin commands now call the nested API routes (`/v1/orgs/:slug/overview`, `/v1/orgs/:slug/overview/inputs`, `/v1/products/:slug/overview`). The `releases admin overview-read`, `overview-write`, and `overview-inputs` commands are unchanged — only the URLs the CLI hits have moved.

  `OverviewInputs.selected` entries now carry pre-hydrated `content` (absolute CDN URLs) and a typed `media` array with `r2Url` resolved, so the overview agent can paste image URLs directly into generated markdown.

## 0.19.2

### Patch Changes

- fae0396: Send a distinctive `User-Agent` header (`releases-cli/<version> (+https://releases.sh)`) on every outbound HTTP request — registry API calls, `releases check` feed probes, update checks, telemetry. Replaces the previous fall-through to Bun/undici's default `node` UA so api.releases.sh analytics and third-party site operators can identify CLI traffic.

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

### Minor Changes

- 254599f: feat(admin): add `overview`, `overview-inputs`, `overview-write` commands

  Restores the operator-side surface for AI overview regeneration after
  `@buildinternet/releases` deleted the local generator in #385. Pairs with the
  new server route `GET /v1/overview-inputs` and the existing dumb upsert at
  `POST /v1/overview`. Generation itself runs in Claude Code via the
  `regenerating-overviews` skill — no Anthropic client returns to the CLI.

  - `releases admin overview <slug>` — read the current overview
  - `releases admin overview-inputs <slug> --json [--window N]` — input-builder
  - `releases admin overview-write <slug> --content-file <path>` — upload result

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

### Minor Changes

- 08b7297: Add `releases tail` as the canonical "latest releases" command (with `latest` retained as an alias), plus `-f/--follow` streaming mode:

  - `releases tail -f` polls the cached `/v1/releases/latest` endpoint on a 60-second interval (configurable with `--interval <seconds>`) and streams new releases as they arrive. Novelty detection is client-side via a bounded seen-id set, so every follow-poller collapses onto the shared KV cache entry rather than forking it with a per-client `since`.
  - `getLatestReleases` now calls the unified `/v1/releases/latest` endpoint in a single request. Replaces the previous scatter-gather (fetch `/sources`, call `/sources/:slug` for the first 10, sort locally), which sampled rather than enumerated and meant the CLI's "latest across all sources" was incomplete for indexes larger than 10 sources.
  - Extracted `renderLatestReleasesTable` into `src/cli/render/` so `tail` and `show` share one formatter.

  Requires the API worker to expose `GET /v1/releases/latest` (shipped in the monorepo alongside this change).

## 0.14.0

### Minor Changes

- 972ff89: Surface AI-generated org overviews more readily in the CLI:
  - `releases org show <slug>` now prints a short preview (first ~80 words) of the AI overview with a generated-at hint and a "⚠ older than 30 days" stale warning where appropriate.
  - New `releases org overview <slug>` command (public read, no auth) prints the full overview body with the same staleness signal.
  - `@buildinternet/releases-core/overview` exports shared helpers — `OVERVIEW_STALE_DAYS`, `overviewAgeDays`, `isOverviewStale`, `overviewPreview` — used by both the CLI and the upstream MCP server.

### Patch Changes

- f864aea: Include README in the published npm tarball so the package page on npmjs.com renders install + usage docs. A `prepack` script copies the repo-root README into the package directory at publish time.

## 0.13.2

### Patch Changes

- 3d4df61: Pin CI to bun canary to pick up oven-sh/bun#29272 — fixes `bun build --compile` producing Mach-O binaries that Apple Silicon SIGKILLs on exec due to a broken LC_CODE_SIGNATURE size in bun 1.3.12. Also leapfrogs the npm version timeline past the orphaned `@buildinternet/releases@0.13.0` left behind during the monorepo → OSS repo extraction.

## 0.12.1

### Patch Changes

- ef08acb: Bootstrap public tap distribution — first release cut from the extracted OSS repo. Publishes binaries to `buildinternet/releases-cli` GitHub Releases and regenerates the Homebrew formula at `buildinternet/homebrew-tap`.
