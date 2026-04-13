---
title: "Browsing & Search"
adminOnly: false
---

# Browsing & Search

Find organizations, sources, and releases in the index.

## List sources

The `list` command shows all configured changelog sources, or details for a single one.

```bash
released list                        # All sources
released list claude-code            # Details for one source
released list --org vercel           # Sources for an org
released list --has-feed             # Only sources with a feed URL
released list --query "tailwind"     # Search by name, slug, or URL
released list --category ai          # Filter by category
released list --json                 # Machine-readable output
```

### Filters

| Flag | Description |
| --- | --- |
| `--org <slug>` | Filter by organization |
| `--product <slug>` | Filter by product |
| `--has-feed` | Only sources with a discovered feed URL |
| `--query <text>` | Substring match on name, slug, or URL |
| `--category <cat>` | Filter by org or product category |
| `--include-disabled` | Include disabled sources |

## Latest releases

The `latest` command shows the most recent releases, optionally filtered by source or org.

```bash
released latest                          # Across all sources
released latest claude-code              # From one source
released latest --org vercel --count 20  # Latest 20 from an org
released latest --json                   # JSON output
```

## Search

Full-text search across organizations, products, sources, and releases.

```bash
released search "breaking change"
released search "authentication" --type releases --limit 5
released search "vercel" --json
```

### Options

| Flag | Description |
| --- | --- |
| `--type <type>` | Limit results to `orgs`, `products`, `sources`, or `releases` |
| `--limit <n>` | Max results per type (default 10) |
| `--json` | Machine-readable output |

## Categories

Organizations and products are tagged with a category. List valid values with:

```bash
released categories
```

## Stats

Get a quick count of organizations, sources, releases, and products in the database:

```bash
released stats
```
