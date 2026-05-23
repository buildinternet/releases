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
```

Also available as `releases admin source list` for discoverability within admin workflows.

### Filters

| Flag                 | Description                             |
| -------------------- | --------------------------------------- |
| `--org <slug>`       | Filter by organization                  |
| `--product <slug>`   | Filter by product                       |
| `--has-feed`         | Only sources with a discovered feed URL |
| `--query <text>`     | Substring match on name, slug, or URL   |
| `--category <cat>`   | Filter by org or product category       |
| `--include-disabled` | Include disabled sources                |
| `--compact`          | Lightweight fields only (with `--json`) |
| `--limit <n>`        | Limit results (with `--json`)           |
| `--page <n>`         | Page number (with `--limit`)            |

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
