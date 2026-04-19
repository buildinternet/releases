---
title: "Fetching Releases"
adminOnly: true
---

# Fetching Releases

Pull new releases from configured sources into the index. Fetching is an operator workflow, so it lives under `releases admin source ...`.

## Basic usage

```bash
releases admin source fetch --stale 24      # Fetch stale sources
releases admin source fetch claude-code     # Fetch a single source
releases admin source fetch --source next-js
```

## Smart fetching

Rather than fetching everything, Releases offers several targeted modes that respect backoff timers and change detection:

```bash
releases admin source fetch --stale 6
releases admin source fetch --unfetched
releases admin source fetch --changed
releases admin source fetch --retry-errors
```

### How backoff works

Sources track `consecutiveNoChange` and `consecutiveErrors` counters. These drive exponential backoff:

- **No change**: 1h → 2h → 4h → … → 48h max
- **Errors**: 1h → 2h → 4h → … → 72h max

The `--stale` flag respects these timers via the `nextFetchAfter` column.

## Limiting results

```bash
releases admin source fetch my-source --max 50
releases admin source fetch --all
```

The default limit is 200 releases per source, which prevents hitting API pagination limits on platforms like GitHub (10K cap).

## Dry run

Preview what would be fetched without writing to the database:

```bash
releases admin source fetch my-source --dry-run
```

## Force re-fetch

Delete existing releases and fetch fresh data:

```bash
releases admin source fetch my-source --force
```

## Crawl mode

For multi-page changelogs (scrape sources only), crawl mode follows pagination links to capture all entries:

```bash
releases admin source fetch my-source --crawl
releases admin source fetch my-source --crawl --crawl-pattern "https://example.com/changelog/*"
```

Once enabled, crawl mode persists in the source metadata. Use `--no-crawl` for a one-off override.

## Concurrency

Fetch multiple sources in parallel:

```bash
releases admin source fetch --stale 6 --concurrency 5
```

Default is 1. Remote mode caps at 5.

## Polling for changes

The `poll` command uses HTTP HEAD requests to detect upstream changes without fetching content. It sets the `changeDetectedAt` flag for use with `releases admin source fetch --changed`.

```bash
releases admin source poll                # Check all feed sources
releases admin source poll --changed      # Show only sources with changes
releases admin source poll --json         # Machine-readable output
```

## Options reference

| Flag                | Description                                 |
| ------------------- | ------------------------------------------- |
| `--source <slug>`   | Source slug (alternative to positional arg) |
| `--max <n>`         | Max releases per source (default 200)       |
| `--all`             | No limit on releases                        |
| `--since <date>`    | Only fetch after this ISO date              |
| `--stale <hours>`   | Only sources older than N hours             |
| `--unfetched`       | Only never-fetched sources                  |
| `--changed`         | Only sources with detected changes          |
| `--retry-errors`    | Only sources that errored                   |
| `--crawl`           | Enable multi-page crawl                     |
| `--dry-run`         | Preview without writing                     |
| `--force`           | Delete and re-fetch                         |
| `--full`            | Force full re-parse                         |
| `--no-summarize`    | Skip post-fetch summary                     |
| `--concurrency <n>` | Parallel sources (default 1, max 5)         |
| `--json`            | Machine-readable output                     |
