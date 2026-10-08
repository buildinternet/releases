# Reader Commands

Reader commands are unauthenticated — no API key required. They talk to `api.releases.sh` over HTTPS and all support `--json` for machine-readable output.

**Release JSON is slim by default.** `get`, `search`, and `tail`/`latest` return a lean release shape — `id`, `version`, `title`, `summary`, a markdown-stripped `excerpt`, `url`, `publishedAt`, nested `source`/`org`, and `contentChars`/`contentTokens` size hints. This drops storage internals (`contentHash`, `sourceId`, `versionSort`, `fetchedAt`, …) and the redundant `title*` variants to keep token usage low. Add `--full` when you need the complete payload (including the full `content` body). `summary` may be `null`; lean on `excerpt` / `contentChars` to decide whether to pull more.

Two fields survive into the slim shape because they answer common questions without a `--full` round-trip: **`media[]`** is included when the release carries media (each item keeps the R2-mirrored `r2Url`), so you can verify "did this image mirror to R2?" from the default output; and **`contentTruncated: true`** is stamped whenever a full `content` body exists but was projected to `excerpt`, signalling that `--full` will return more. Both are omitted when not applicable.

> **Piping note:** in the default (non-`--json`) TSV output, release rows repeat the title across several columns (raw title, normalized title, version). Don't assume `cut -f2` lands on a unique field — check the row layout first, or just use `--json` for stable parsing.

## Search

Unified search across organizations, the catalog (products + standalone sources), and releases.

```bash
releases search "authentication"
releases search "vercel" --type releases --limit 5
releases search "react" --type catalog
releases search "stripe" --kind sdk         # taxonomy filter
releases search "breaking change" --json
```

Flags:

- `--type <orgs|catalog|releases>` — narrow to one section (default: all three). `products` is accepted as a deprecated alias for `catalog`.
- `--limit <n>` — max results per section (default: 10).
- `--mode <lexical|semantic|hybrid>` — pick the release-retrieval strategy. Server default is hybrid; pass `lexical` for pure FTS ranking.
- `--kind <platform|sdk|mobile|desktop|docs|integration|tool>` — taxonomy filter. Release hits match `COALESCE(source.kind, product.kind)` (a source with no kind inherits from its product); catalog hits match the row's own kind directly.
- `--json` — machine output (slim release hits by default; `--full` for the complete shape). Release hits include a `kind: "release" | "changelog_chunk"` discriminator. Catalog hits include `entryType: "product" | "source"` (the entity discriminator) plus an optional `kind` field carrying the taxonomy classification.
- `--full` — with `--json`, return complete unprojected release hits (full `content`, `score`, `sourceType`, `title*` variants, …).

Catalog hits also include the response field `catalog`. Older API deploys will still send the deprecated `products` alias instead — the CLI reads either, but new code should consume `catalog`.

### On-demand GitHub lookup

When the query is a `{org}/{repo}` coordinate (optionally prefixed `github:`) and no entity (org or catalog source) matched, the registry probes GitHub on demand and the CLI prints a **Lookup** section above the regular results. Coordinate matching is case-insensitive — `Shopify/toxiproxy` and `shopify/toxiproxy` resolve to the same source row. The lookup fires even when tangential release hits surface on a single segment token, so a coordinate is treated as a precise question about one repo.

```bash
releases search "vercel/next.js"             # bare coordinate
releases search "github:Shopify/toxiproxy"   # explicit provider prefix
```

Statuses on the Lookup section: `INDEXED` (just materialized), `EXISTING` (already tracked), `EMPTY` (real repo, no releases or CHANGELOG yet), `NOT_FOUND` (private/archived/missing), `DEFERRED` (rate-limited or 5xx — retry shortly).

## Latest releases

```bash
releases tail                          # across all sources
releases tail next-js                  # one source (slug)
releases tail src_abc123               # one source (typed id)
releases tail --org vercel --count 20  # whole org (org_…, slug, domain, name, or handle)
releases tail --org vercel --limit 100 # --limit is an alias for --count (both clamp to 1–100)
releases tail --product nextjs --cursor <token>  # page the product feed (see below)
releases tail --product nextjs         # one product (prod_… or slug)
releases tail --type feature           # filter by release type
releases tail --json                   # slim shape
releases tail --json --full            # complete payload
```

`--count` (alias `--limit`) caps the rows returned and is clamped to `1–100`; a positive integer is required (anything else errors). When a one-shot listing fills the requested window, a truncation hint is printed to **stderr** so `--json` stdout stays clean.

Pagination differs by feed: only the **product** feed (`--product`) is cursor-paginated — pass `--cursor <token>` to fetch the next page, chaining the token from the previous response. The org-wide and global feeds are **count-capped, not cursored**, so `--cursor` without `--product` errors rather than being silently ignored (and `--cursor` can't combine with `--follow`).

## List sources

```bash
releases list                          # all sources
releases list next-js                  # detail for one source (src_… or slug)
releases list --org sentry             # filter by organization (org_…, slug, domain, name, or handle)
releases list --product nextjs         # filter by product (prod_… or slug)
releases list --query shadcn           # name / slug / url substring
releases list --has-feed               # sources with a discovered feed URL
releases list --category ai            # filter by category
releases list --kind sdk               # filter by taxonomy (platform|sdk|mobile|desktop|docs|integration|tool)
releases list --json                   # machine-readable output
releases list --json --compact         # lightweight JSON (id, slug, name, type, org, date)
releases list --json --limit 20 --page 2  # pagination (server-side)
releases list --json --page-all        # stream every page as NDJSON (one source per line)
```

The text table carries a per-source **`Releases`** count column (a dim `—` when unknown), so you can answer "how many releases does this source have?" without a follow-up call; the `--json` rows expose the same value as `releaseCount`.

`--page-all` walks every page for you and streams the result as newline-delimited JSON — one source per line — so you can grab the full list in one command instead of looping `--page`. It's `--json`-only (warns and falls through to the table otherwise) and can't be combined with `--page`; `--limit` still tunes the per-request page size. The same flag is on `releases org list` and `releases admin product list`. Pipe it straight to `jq -c` or any stream parser.

Aliased as `releases admin source list` for discoverability within admin workflows.

## Get any entity

Top-level `get` dispatches by ID prefix, and falls back to slug lookup:

```bash
releases get rel_XqbzLaOqBFz7VSAIqx2zs   # release (rel_)
releases get src_abc123                   # source (src_)
releases get org_abc123                   # organization (org_)
releases get prod_abc123                  # product (prod_)
releases get vercel                       # slug fallthrough (org → product → source)
```

Use this when you have an ID from another tool output (search results, MCP tool responses, etc.) and want to inspect it without caring what kind of entity it is.

For a release, `releases get rel_… --json` carries `media[]` (with each item's R2-mirrored `r2Url`) and a `contentTruncated` flag in the slim shape — enough to confirm media mirrored to R2 and whether there's a fuller body behind `--full`, without dropping to the raw API.

## Stats

```bash
releases stats              # index overview, source health, recent fetch activity
releases stats --days 7     # adjust the activity window
releases stats --json
```

## Product changelog

Recent updates to releases.sh itself — the same self-published feed the website renders at [releases.sh/updates](https://releases.sh/updates). Keyless; not the per-source `admin source changelog` wrapper.

```bash
releases changelog              # latest 5 entries, then a link to /updates
releases changelog --limit 10
releases changelog --json
```

`--limit` is 1–50 (default 5). `--json` is `{ url, feed, entries }` where each entry has `id`, `kind` (`platform` | `cli`), `title`, `date`, `url`, `tags`, `summary`, and `body`.

## Categories

```bash
releases categories          # list the canonical category values
releases categories --json
```

The category list is fixed — adding a new category requires a code change in `@buildinternet/releases-core`.

## Reading a tracked changelog

`releases get <source> --json` reports `hasChangelogFile` and `changelogUrl` keyless, so you can detect whether a source maintains a checked-in CHANGELOG.md. This only exists for **sources that track one** — tag-only repos (e.g. Next.js, which ships GitHub releases but no CHANGELOG file) and products report `hasChangelogFile: false`.

To read the **sliced content** without a key, use one of:

- The MCP tool `get_catalog_entry` with `changelog_tokens` (heading-aligned; recommended brackets 2000 / 5000 / 10000 / 20000) and chain via the returned `nextOffset`. Every response reports `totalTokens` so you can budget calls upfront.
- Fetch the `changelogUrl` directly (it points at the raw file on GitHub).

> The CLI also has a `releases admin source changelog <slug>` wrapper, but it lives under `admin` and is **key-gated** — it fails with `"admin" requires an API key` for keyless users. Prefer the two keyless paths above unless you already hold an admin key.

## Collections

Curated cross-org "playlists" (e.g. Frontier AI Labs, Coding Agents), keyless:

```bash
releases collection list                       # all collections
releases collection get frontier-ai-labs       # members of one collection
releases collection releases frontier-ai-labs  # interleaved cross-org release feed (--limit <n>, --json)
```

## Domain lookup

Resolve a domain or URL to the org/product that owns it (keyless):

```bash
releases lookup domain vercel.com
releases lookup domain https://tailwindcss.com/blog
```

## Submit a source

Suggest a changelog or release-notes URL for the registry (keyless — no account or key). This feeds the same review queue as the [web submit form](https://releases.sh/submit); maintainers triage it under the key-gated `releases admin recommendations …`.

```bash
releases submit https://acme.dev/changelog                  # one-shot
releases submit acme.dev/changelog                          # scheme optional — https:// is assumed
releases submit                                             # prompt for the URL (interactive)
echo "https://acme.dev/releases" | releases submit          # pipe from stdin
releases submit https://acme.dev/changelog --note "GitHub: acme/acme" --contact you@example.com
releases submit https://acme.dev/changelog --dry-run --json # preview the payload, send nothing
```

`--note` carries extra context (product name, GitHub repo, feed quirks); `--contact` is an optional email to notify once it's reviewed. With no URL argument in an interactive terminal, `submit` prompts for the URL (and the optional note/contact); otherwise pass it inline or pipe via stdin. Index pages, changelogs, GitHub releases, and feed URLs are all ideal.

## Signed-in account commands (`releases login`)

These act on **your** account via `/v1/me/*` — sign in first (`releases login` or `RELEASES_API_KEY`):

```bash
releases follow vercel
releases following
releases feed

releases webhook list
releases webhook add --scope follows --url https://your.app/hook
releases webhook add --org vercel --url https://your.app/hook
releases webhook add --org vercel --product next-js --type feature --url https://your.app/hook
releases webhook add --format slack --url https://hooks.slack.com/services/…
releases webhook add --format discord --url https://discord.com/api/webhooks/…
releases webhook edit <id> --type rollup
releases webhook edit <id> --format discord --url https://discord.com/api/webhooks/…
releases webhook test <id>
releases webhook verify --key <hex> --signature … --timestamp … --body-file -

releases workspace list
releases webhook list --workspace acme
releases webhook add --workspace acme --org vercel --url https://your.app/hook

releases publish-token create --source src_… --name "GitHub Actions"
releases publish-token list
releases publish-token revoke <id>
```

`--format slack` and `--format discord` post an unsigned chat card; the webhook URL is the secret (no signing key). `webhook verify` is local (no auth). `--workspace <id-or-slug>` on `list`/`add`/`show`/`edit`/`remove`/`test`/`rotate-secret` targets a shared workspace webhook (org-scoped only) instead of your own; `releases workspace list` finds the id/slug. Only workspace owners/admins can write; members can list/view/test. Admin webhooks (`releases admin webhook …`) are a separate root-key operator surface.

`publish-token create` requires a verified domain ownership claim on the source's org (see the [GitHub Actions integration doc](https://releases.sh/docs/integrations/github-actions)); it mints a `relk_` token scoped to ONE source, printing only the token to stdout (so it pipes straight into `gh secret set`) with setup guidance on stderr. Like every `publish-token`/`keys` verb, it opens its own one-time browser approval and signs the session back out once the command finishes — there's no persisted login session to reuse. Pass `--no-browser` (same as `releases login`) in a headless/agent context to print the URL + code instead of trying to launch a browser.

### Publish a changelog from CI

`releases publish` posts changed changelog entries to `POST /v1/sources/…/releases/batch` (`mode: upsert-content`). It is the GitLab CI / Buildkite / local equivalent of the publish-changelog GitHub Action. Auth is `RELEASES_API_TOKEN` from `publish-token create` — a read-only `RELEASES_API_KEY` is not accepted, and a real publish fails if the token is missing. `--dry-run` prints the batch body with no token and no request.

```bash
releases publish --source src_… --dry-run
releases publish --source acme/docs --since "$CI_COMMIT_BEFORE_SHA" \
  --url-template "https://gitlab.com/acme/app/-/blob/main/CHANGELOG.md#{key}"
releases publish --source src_… --glob "changelog/**/*.mdx" --cwd docs
```

Single-file mode (default `--changelog CHANGELOG.md`) parses versioned `##` headings and `## Month D, YYYY` sections. `--glob` is directory mode: one MDX/Markdown file per release, metadata in YAML frontmatter (`draft: true` skipped). `--glob` cannot be combined with a non-default `--changelog`. Omit `--since` to publish every parsed entry; an all-zero SHA (GitLab's first pipeline) does the same. Deleted directory files are reported and left in the index.

## Agent self-discovery

```bash
releases agent-context        # versioned JSON: every command, argument, and option
```

When unsure of exact flags or subcommands, call `agent-context` rather than guessing — it's the CLI's own machine-readable contract, versioned via `schemaVersion`.
