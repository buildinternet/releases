---
title: "Browsing & Search"
adminOnly: false
---

# Browsing & Search

Find organizations, sources, and releases in the index.

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
releases tail -f                         # Follow new releases (polls every 60s)
releases tail -f --interval 30           # Follow with a 30s poll interval
releases tail --json                     # JSON output
```

## Search

Full-text search across organizations, products, sources, and releases.

```bash
releases search "breaking change"
releases search "authentication" --type releases --limit 5
releases search "vercel" --json
```

### Options

| Flag            | Description                                                   |
| --------------- | ------------------------------------------------------------- |
| `--type <type>` | Limit results to `orgs`, `products`, `sources`, or `releases` |
| `--limit <n>`   | Max results per type (default 10)                             |
| `--json`        | Machine-readable output                                       |

## Categories

Organizations and products are tagged with a category. List valid values with:

```bash
releases categories
```

## Stats

Get a quick count of organizations, sources, releases, and products in the database:

```bash
releases stats
```
