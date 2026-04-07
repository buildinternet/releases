---
name: managing-sources
description: How to add, remove, list, validate, and manage changelog sources using the Released CLI — covers batch operations, ignored/blocked URLs, duplicate detection, and the validation workflow
---

# Managing Sources

Operational guide for managing changelog sources via the Released CLI.

## Listing Sources

```bash
releases list --json                    # All sources with metadata
releases list <slug> --json             # Single source details
releases list --org <org> --json        # Sources for a specific org
releases list --query <text> --json     # Filter by name, slug, or URL
releases list --has-feed --json         # Sources with a discovered feed URL
releases list --enrichable --json       # Sources eligible for content enrichment
releases list --enrichable --org <org> --json  # Combine filters
```

The `--json` output includes source metadata (feed URLs, provider, evaluation results, fetch history).

### Finding enrichable sources

Use `--enrichable` to find sources that have a feed URL but either haven't been assessed for content depth or are known to have sparse (summary-only) content. These are candidates for AI-based content enrichment:

```bash
releases list --enrichable --json | jq '.[].slug'
```

Use `--has-feed` to find all sources with a discovered feed URL, regardless of content depth:

## Adding Sources

### Single source

```bash
releases add <name> --url <url>                    # Auto-detect type
releases add --name <name> --url <url>              # Name as flag (alternative)
releases add <name> --url <url> --type github       # Explicit type
releases add <name> --url <url> --org "Acme Corp"   # Associate with org
releases add <name> --url <url> --feed-url <feed>   # Explicit feed URL
releases add <name> --url <url> --skip-eval         # Skip evaluation
```

### Organization descriptions

When creating an org, include a brief one-sentence product description. This grounds AI summaries for lesser-known products:

```bash
releases org add "Trigger.dev" --domain trigger.dev --description "Open-source background job framework for TypeScript"
```

The description is also supported in import manifests (`"description": "..."`) and the MCP `add_organization` tool.

Types: `github`, `scrape`, `feed`, `agent`.

When no `--type` is given, the CLI runs `evaluateChangelog()` to auto-detect the best method. Use `--skip-eval` for batch operations where you already know the type.

### Batch add

Write a JSON array to a temp file, then pass it:

```bash
cat > /tmp/sources.json << 'EOF'
[
  {"name": "Product A", "url": "https://example.com/changelog", "type": "scrape"},
  {"name": "Product B", "url": "https://github.com/org/repo", "type": "github"}
]
EOF
releases add --batch /tmp/sources.json
```

Batch mode skips evaluation by default (uses basic heuristics).

## Removing Sources

```bash
releases remove <slug> --ignore --reason "duplicate of X"
releases remove <slug1> <slug2> --ignore --reason "no releases found"
```

Always use `--ignore --reason` when removing discovery results. This adds the URL to the org's ignore list so it won't be re-discovered.

## Ignored URLs (org-scoped)

A URL ignored for one org can still be valid for another org.

```bash
releases ignore list --org <org> --json    # Show ignored URLs
releases ignore add --org <org> <url>      # Ignore a URL
releases ignore remove --org <org> <url>   # Un-ignore a URL
```

## Blocked URLs (global)

For spam domains and known-bad URLs that should never be added for any org.

```bash
releases block list --json                 # Show blocked URLs
releases block add <url>                   # Block a URL globally
releases block remove <url>               # Unblock
```

## Validation Workflow

After adding a source, validate it before considering it good:

1. **Add the source:** `releases add <name> --url <url>`
2. **Dry-run fetch:** `releases fetch <slug> --dry-run`
3. **Check results:** Does it find releases? Do they have titles, dates, content?
4. **If bad:** `releases remove <slug> --ignore --reason "no usable releases"`
5. **If good:** The source is ready for production fetches

## Primary Sources

An org can have one source marked as its **primary changelog** — the main, company-wide changelog that covers the entire platform. Other sources (GitHub repos, product-specific changelogs) are secondary. The primary source appears first in the web app and is badged as "Primary".

```bash
releases edit <slug> --primary          # mark as org's primary changelog
releases edit <slug> --no-primary       # unmark as primary
```

When onboarding an org, if you find a single top-level changelog (e.g., `example.com/changelog`) alongside product-specific or GitHub sources, mark the top-level one as primary.

## Duplicate Detection

Before adding sources, check for overlapping URLs:

```bash
releases list --json | jq '.[].url'
```

Common duplicates:
- Same repo via GitHub URL vs changelog page (the GitHub source is usually better)
- RSS feed URL vs the page it feeds from (keep the feed)
- With and without trailing slash or `www.` prefix

## Reading `--json` Output

All data commands support `--json`. Key patterns:

```bash
releases list --json                           # Array of source objects
releases fetch <slug> --dry-run --json         # Fetch result with releases
releases evaluate <url> --json                 # Evaluation recommendation
releases discover <domain> --json              # Discovery candidates
```

Pipe through `jq` for filtering when working with large datasets.

## Task Management

Monitor and control remote fetch sessions:

```bash
releases task list                             # Active remote sessions
releases task cancel <sessionId>               # Cancel a running session
```
