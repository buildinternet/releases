---
title: "Browsing & Search"
description: "CLI commands for listing, searching, and inspecting orgs, sources, and releases."
adminOnly: false
---

# Browsing & Search

Find organizations, sources, and releases in the index.

## Pair with agent skills

One-line setup so your agent picks the right `releases` subcommand and flags on its own. See the [skills page](/docs/skills) for the full list.

<!-- slot:skills-install -->

## List sources

The `list` command shows all configured changelog sources, or details for a single one.

```bash
releases list                        # All sources
releases list claude-code            # Details for one source
releases list --org vercel           # Sources for an org
releases list --has-feed             # Only sources with a feed URL
releases list --query "tailwind"     # Search by name, slug, or URL
releases list --category ai          # Filter by category
releases list --json                 # Machine-readable output
releases list --json --compact       # Lightweight JSON (id, slug, name, type, org, date)
releases list --json --limit 20      # First 20 results as JSON
releases list --json --limit 20 --page 2  # Paginated JSON
releases list --json --page-all      # Stream every page as NDJSON (one source per line)
```

Also available as `releases admin source list` for discoverability within admin workflows.

### Filters

| Flag                 | Description                                                                                              |
| -------------------- | -------------------------------------------------------------------------------------------------------- |
| `--org <slug>`       | Filter by organization                                                                                   |
| `--product <slug>`   | Filter by product                                                                                        |
| `--has-feed`         | Only sources with a discovered feed URL                                                                  |
| `--query <text>`     | Substring match on name, slug, or URL                                                                    |
| `--category <cat>`   | Filter by org or product category                                                                        |
| `--include-disabled` | Include disabled sources                                                                                 |
| `--compact`          | Lightweight fields only (with `--json`)                                                                  |
| `--limit <n>`        | Limit results (with `--json`)                                                                            |
| `--page <n>`         | Page number (with `--limit`)                                                                             |
| `--page-all`         | Stream every page as NDJSON (with `--json`; see [Stream every page](#stream-every-page-with---page-all)) |
| `--fields <list>`    | Project `--json` output to named fields (see [Project fields](#project-fields-with---fields))            |

## Latest releases

The `tail` command shows the most recent releases and can optionally poll for new ones as they arrive. `latest` is retained as an alias for the one-shot listing.

```bash
releases tail                            # Across all sources
releases tail claude-code                # From one source
releases tail --org vercel --count 20    # Latest 20 from an org
releases tail --since 30d                # Only releases from the last 30 days
releases tail --since 2026-01-01 --until 2026-03-31  # A specific window
releases tail -f                         # Follow new releases (polls every 60s)
releases tail -f --interval 30           # Follow with a 30s poll interval
releases tail --json                     # Slim JSON output
releases tail --json --full              # Complete unprojected payload
releases tail --json --fields id,version,source.slug  # Project to just these fields
```

`--since` and `--until` bound results by publish date and compose with the other filters. Each accepts an ISO date (`2026-01-01`) or relative shorthand (`90d`, `4w`, `6m`, `2y`). `latest` is an alias for `tail`; an unparseable value exits with code `2`.

The human view is a single aligned row per release — identity (a package-qualified version like `@scope/pkg@1.2.3`, otherwise the source name) · a one-line description · relative age · a dimmed `rel_…` handle. `--json` returns a [slim release shape](#slim-release-json) by default; add `--full` for everything.

## Search

Full-text search across organizations, products, sources, and releases.

```bash
releases search "breaking change"
releases search "authentication" --type releases --limit 5
releases search "vercel" --json
releases search "vercel/next.js"          # GitHub coordinate — falls back to on-demand lookup
releases search "github:Shopify/toxiproxy" # Same coordinate with explicit provider prefix
releases search "slack integration" --since 90d  # Only release hits from the last 90 days
```

### On-demand GitHub lookup

When the query is a `{org}/{repo}` coordinate (optionally prefixed `github:`) **and** no entity (org or catalog source) matched, the CLI prints a `Lookup` rail above the regular results. The lookup fires even when tangential release hits surfaced — a coordinate is treated as a precise question about one repo. Org and repo segments match case-insensitively, so `shopify/toxiproxy` and `Shopify/Toxiproxy` resolve to the same source row.

Possible statuses:

| Status      | Meaning                                                                               |
| ----------- | ------------------------------------------------------------------------------------- |
| `INDEXED`   | We just pulled this repo from GitHub on demand. Inline release preview follows.       |
| `EXISTING`  | Repo was already tracked. Inline release preview follows.                             |
| `EMPTY`     | Real repo, but no tagged releases or CHANGELOG yet.                                   |
| `NOT_FOUND` | No public repo at `github.com/{org}/{repo}` (private, archived, renamed, or missing). |
| `DEFERRED`  | GitHub rate-limit or 5xx — try again in a moment.                                     |

If the org segment matches a known org but the specific repo doesn't, the CLI shows a "Did you mean" rail listing the top sibling sources for that org. The lookup also surfaces in `--json` output under the `lookup` key.

### Options

| Flag                | Description                                                                                                                                                                                                                                                                |
| ------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `--type <type>`     | Limit to one result type: `orgs`, `catalog`, `releases`, or `collections`                                                                                                                                                                                                  |
| `--limit <n>`       | Max results per type (default 10)                                                                                                                                                                                                                                          |
| `--mode <mode>`     | Release-retrieval strategy: `lexical`, `semantic`, or `hybrid` (default)                                                                                                                                                                                                   |
| `--domain <domain>` | Scope results to the org owning this domain (URL-shaped input is normalized)                                                                                                                                                                                               |
| `--kind <kind>`     | Filter by taxonomy: `platform`, `sdk`, `mobile`, `desktop`, `docs`, `integration`, `tool`. For release hits the effective kind resolves from the source, falling back to its product (`COALESCE(source.kind, product.kind)`); catalog hits match the row's own `kind` only |
| `--since <when>`    | Keep only release hits published on/after this date (ISO or `90d`/`4w`/`6m`/`2y`)                                                                                                                                                                                          |
| `--until <when>`    | Keep only release hits published on/before this date (same formats as `--since`)                                                                                                                                                                                           |
| `--json`            | Machine-readable output ([slim release hits](#slim-release-json) by default)                                                                                                                                                                                               |
| `--full`            | With `--json`, return complete unprojected release hits                                                                                                                                                                                                                    |
| `--fields <list>`   | With `--json`, project each entity array down to named fields (see [Project fields](#project-fields-with---fields))                                                                                                                                                        |

`--mode`, `--domain`, and `--kind` shape retrieval and scoping; `--since` / `--until` filter the release hits only — org, product, and source matches are unaffected.

In the human view, each release hit is one aligned row (`Org/Source` · title · relative age · dimmed `rel_…`) with a cleaned, markdown-stripped excerpt underneath — never raw `## heading`/`**bold**` markup. The identity leads with the owning org so cross-vendor results make clear who ships each release (the prefix is dropped when the source name already starts with the org name, e.g. `Railway Changelog`).

### Slim release JSON

The release reader commands — `search`, `tail`/`latest`, and `get <rel_…>` — return a **slim** release shape under `--json` by default, so agents aren't billed tokens for storage internals:

```jsonc
{
  "id": "rel_…",
  "version": "@scope/pkg@1.2.3",
  "title": "…",
  "summary": null, // AI summary; often null
  "excerpt": "…", // markdown-stripped, ~280 chars
  "url": "https://…",
  "publishedAt": "2026-05-22T20:25:54.000Z",
  "source": { "slug": "…", "name": "…" },
  "org": { "slug": "…", "name": "…" },
  "contentChars": 51,
  "contentTokens": 24,
}
```

Pass `--full` to recover the complete payload (`content`, `contentHash`, `composition`, `titleGenerated`/`titleShort`, and other internals). This is the inverse of `list`, which is verbose by default and opts _into_ a lightweight shape with `--compact`.

### Project fields with `--fields`

When you only need a few leaves of the JSON, `--fields` post-filters the output down to a comma-separated mask. It works on the readers (`get` across release/source/org/product, `search`, and `tail`/`latest`):

```bash
releases tail --json --fields id,version,source.slug
releases get vercel --json --fields id,name,domain
releases search "auth" --json --fields id,title,url
```

- Use **dot-notation** for nested keys (`source.slug`, `org.name`). It walks plain objects only — request an array-valued field like `media` whole.
- It's a **post-projection** over whatever shape the reader produced, so it composes with `--full` (mask the full payload) and otherwise reuses the slim vocabulary — no new field names to learn.
- A field that resolves to nothing is dropped with a single stderr warning (so a typo is visible without corrupting the JSON on stdout). `--fields` without `--json` warns and is ignored, the same as `--full`.

### Stream every page with `--page-all`

The page-based list readers — `list`, `org list`, and `admin product list` — accept `--page-all`. Instead of returning one `{ items, pagination }` page that you have to walk with `--page`/`--limit`, the CLI walks every page itself and streams the result as newline-delimited JSON (NDJSON), one item per line:

```bash
releases list --json --page-all | jq -c 'select(.type == "github")'
releases org list --json --page-all
```

- NDJSON keeps memory flat and lets a consumer (`jq -c`, a stream parser) process rows as they arrive instead of buffering one giant array.
- It's `--json`-only (without `--json` it warns and falls through to the table) and can't be combined with `--page`. `--limit` still sets the per-request page size as a round-trip tuning knob.

## JSON output, errors, and input validation

Every reader command supports `--json`, and machine-readable output is stable enough to script against:

- **Structured errors.** When a command run with `--json` fails, it prints a parseable error envelope to **stdout** (not an unstructured stderr dump) and exits non-zero, so you can branch on `kind` instead of string-matching:

  ```jsonc
  { "error": { "kind": "api", "message": "…", "status": 404, "method": "GET", "path": "/v1/..." } }
  ```

  `kind` is `"api"` (carries `status`/`method`/`path`), `"invalid_input"` (carries the offending `field`), or `"error"`. Without `--json`, the two known error kinds print a clean one-line stderr message instead of a stack trace.

- **List envelopes.** `--json` list responses return `{ items, pagination }`; `pagination` carries `{ page, pageSize, returned, hasMore }` (plus `totalItems`/`totalPages` once the tail is seen). When a default call fills a page and more rows exist, a stderr truncation warning fires so scripts don't silently miss rows — raise `--limit`, walk `--page`, or stream everything with `--page-all`.

- **Input validation.** Identifiers are validated before any network call: control characters, whitespace, `..` traversal, `%` percent-encoding, and embedded `?`/`#` are rejected with an `invalid_input` error. This keeps a hallucinated or malformed identifier from being sent to the API.

## Categories

Organizations and products are tagged with a category. List valid values with:

```bash
releases categories
```

Each category accepts a configurable byline (display name + description) and optional aliases that redirect to the canonical slug. For example, `releases.sh/categories/e-commerce` 301s to `/categories/commerce`. Alias resolution is also applied on write paths, so `--category e-commerce` resolves to `commerce` before it lands in the database.

## Stats

Get a quick count of organizations, sources, releases, and products in the database:

```bash
releases stats
```

## Feedback

Send feedback about the CLI — a bug, an idea, or anything else — straight to the maintainers. No API key or account required.

```bash
releases feedback "tail -f reconnects slowly on flaky wifi"   # one-shot message
releases feedback --type bug                                  # prompts for the text (interactive)
echo "longer write-up…" | releases feedback                   # pipe from stdin
releases feedback "love the tool" --contact you@example.com   # optional reply-to
releases feedback "draft" --dry-run --json                    # preview the payload, send nothing
```

With no message argument in an interactive terminal, `feedback` prompts for the text (and an optional contact); otherwise pass it inline or pipe via stdin. `--type` accepts `bug`, `idea`, or `other`. Submissions are confirmed with an ID you can reference later.
