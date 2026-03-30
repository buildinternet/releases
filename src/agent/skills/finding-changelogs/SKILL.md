---
name: finding-changelogs
description: How to find, evaluate, and recommend the best ingestion method for changelog URLs — covers feed discovery, provider detection, GitHub API, markdown sources, and scraping fallback
---

# Finding Changelogs

Determine the best way to get structured release data from a changelog or release notes page.

Many pages have better-structured data sources behind them — RSS feeds, raw markdown files, or API endpoints. Finding those avoids the complexity of parsing rendered HTML.

## Priority Order

Feeds > GitHub Releases API > raw markdown > page scraping.

## Using the CLI

### `released evaluate <url>`

Runs automated pre-checks (provider detection, feed discovery) and returns a recommendation. Use `--json` for structured output.

Key fields in JSON output:
- `recommendedMethod`: `feed`, `github`, `markdown`, `scrape`, or `crawl`
- `recommendedUrl`: The URL to use (may differ from the input URL)
- `feedUrl` / `feedType`: If a feed was found
- `githubRepo`: In `owner/repo` format, if applicable
- `pageStructure`: `single-page`, `index`, or `unknown`
- `confidence`: `high` (structured source found), `medium` (clear page structure), `low` (unclear)
- `alternatives`: Other viable sources found

### `released discover <domain>`

Probes a domain for changelog URLs, feeds, and GitHub repos. Returns candidate URLs to evaluate. Use this as a starting point when you don't know where a company's changelogs live.

## Pre-checks (automated)

The `evaluate` command runs these before returning:

- **Provider fingerprinting** — identifies the hosting platform (Mintlify, ReadMe, Docusaurus, Ghost, etc.) via DNS CNAME, HTTP headers, and HTML patterns. Each provider has known capabilities.
- **Feed discovery** — probes ~15 well-known feed paths and HTML `<link rel="alternate">` tags.
- **Provider-specific probes** — if a provider is detected, tries its known feed paths and markdown suffix.

## When to Evaluate Manually

If `released evaluate` returns `confidence: low` or `recommendedMethod: scrape`, you may want to investigate the page yourself:

1. **Fetch the page** with `WebFetch` and look at the HTML source.
2. **Look for feeds** — feed URLs embedded in JavaScript, non-standard paths, or links to RSS/Atom.
3. **Look for GitHub repos** — "View on GitHub", "CHANGELOG.md on GitHub", or repository links.
4. **Look for raw markdown** — links to source `.md` files.
5. **Classify the page structure** — is it a single-page changelog or an index of links to individual release pages?

## When to Use Crawl

Use `--crawl` (or set `crawlEnabled` in source metadata) when:
- The page is an **index** linking to individual release pages (e.g., `/changelog/2024-03-15`)
- Single-page scraping only gets titles/dates but not full content
- The provider is known to use per-release pages (Intercom, Notion, some custom sites)

Do NOT use crawl for single-page changelogs or feeds.

## Known Provider Capabilities

Detected automatically in pre-checks. Listed for reference:

| Provider | Feed Paths | Markdown Suffix | Notes |
|----------|-----------|-----------------|-------|
| Mintlify | `/rss.xml` | Yes (`.md`) | — |
| ReadMe | `/changelog.rss` | — | — |
| Docusaurus | `/blog/rss.xml`, `/blog/atom.xml`, `/blog/feed.json` | — | — |
| Ghost | `/rss/` | — | — |
| WordPress | `/feed/` | — | — |
| Productboard | `/changelog.rss`, `/changelog/feed` | — | — |
| Headway | `/feed` | — | — |
| Beamer | `/feed` | — | — |
| LaunchNotes | `/rss` | — | — |
| GitBook, Notion, Intercom, Zendesk, etc. | — | — | No feeds; use crawl or scrape |
