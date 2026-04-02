---
name: finding-changelogs
description: How to find, evaluate, and recommend the best ingestion method for changelog URLs — covers feed discovery, provider detection, GitHub API, markdown sources, and scraping fallback
---

# Finding Changelogs

Determine the best way to get structured release data from a changelog or release notes page.

Many pages have better-structured data sources behind them — RSS feeds, raw markdown files, or API endpoints. Finding those avoids the complexity of parsing rendered HTML.

## Content Verification

After discovering a feed or structured source, always spot-check the entries before accepting it. Sample a few entries and verify they are actual changelog or release content — not blog posts, marketing articles, tutorials, or unrelated editorial content.

Red flags that a feed is wrong:
- Entry URLs point to `/blog/` paths rather than `/changelog/` or `/releases/` paths
- Titles read like articles or tutorials (e.g., "Choosing a logging library: The definitive guide")
- No version numbers, semver patterns, or feature/fix language anywhere in the entries
- The feed URL is site-wide (e.g., `/feed.xml`) rather than section-specific (e.g., `/changelog/feed.xml`)
- Entry content discusses opinions, comparisons, or industry trends rather than product changes

If the entries don't look like releases, the feed is likely the wrong one. Look for a more specific feed, or fall back to a different ingestion method.

**Watch for redirects.** A URL like `blog.example.com/changelog/` may redirect to `example.com/changelog/`, but feed discovery may have already found the blog's site-wide feed before the redirect. Always check whether the discovered feed is scoped to the changelog section, not the entire site.

## Priority Order

Well-known files > Link relations > Feeds > GitHub Releases API > raw markdown > page scraping.

## Well-Known Files & Link Relations

The discovery pipeline checks for standardized changelog metadata before falling back to heuristic methods.

### Well-known files (highest priority)

Checked in cascade — stops as soon as a tier produces results:
1. `/.well-known/changelog.json` — JSON manifest (primary)
2. `/.well-known/releases.json` — JSON manifest (alias)
3. `/.well-known/changelog.txt` — text format (security.txt-style fallback)
4. `/AGENTS.md`, `/AGENTS.txt` — AI agent instruction files with changelog references
5. `/changelog.md`, `/changelog.txt`, `/releases.md`, `/releases.txt` (and uppercase variants) — root-level files

**JSON manifest format** (`/.well-known/changelog.json`):

Single product:
```json
{
  "version": 1,
  "url": "https://example.com/changelog",
  "feed": "https://example.com/changelog/feed.xml"
}
```

Multi-product:
```json
{
  "version": 1,
  "changelogs": [
    { "name": "Platform", "url": "https://example.com/changelog", "feed": "https://example.com/changelog.rss" },
    { "name": "API", "url": "https://example.com/api/changelog" }
  ]
}
```

**Text manifest format** (`/.well-known/changelog.txt`):
```
# Changelog discovery — see https://releases.sh/well-known
Changelog: https://example.com/changelog
Feed: https://example.com/changelog/feed.xml
```

Lines starting with `#` are comments. Keys are `Changelog:` and `Feed:`, one per line.

**AGENTS.md / AGENTS.txt** — AI agent instruction files may reference changelogs. The parser detects:
- Key-value lines: `Changelog: https://example.com/changelog`
- Markdown links: `[Our Changelog](https://example.com/changelog)`
- Bare URLs on lines mentioning "changelog", "release notes", etc.

**Root changelog/releases files** — `/changelog.md`, `/changelog.txt`, `/releases.md`, `/releases.txt` (and uppercase variants) are probed via HEAD request. Only accepted if the server returns text content (not an HTML error page).

### Link relations

The discovery pipeline detects these `<link>` tags in the HTML `<head>`:

```html
<link rel="changelog" href="/changelog">
<link rel="releases" href="/releases">
<link rel="release-notes" href="/docs/release-notes">
```

If the tag includes a feed `type` attribute, the URL is treated as a feed source:
```html
<link rel="changelog" type="application/atom+xml" href="/changelog.atom">
```

These are distinct from standard feed autodiscovery (`rel="alternate"`) — they point directly to changelog pages or feeds, not generic site feeds.

### Discovery method labels

Sources found via these mechanisms are tagged:
- `method: "well-known"` — from `/.well-known/` manifest files
- `method: "link-rel"` — from HTML `<link rel="changelog|releases|release-notes">`

Both carry `confidence: "high"` since they represent explicit publisher intent.

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

## Primary Changelogs

When evaluating multiple changelog sources for an org, identify which one is the company's **primary changelog** — the top-level, platform-wide changelog that covers the product as a whole. This is typically a website changelog page (e.g., `example.com/changelog`) rather than individual GitHub repos or product-specific pages.

After adding sources, mark the primary one with `released edit <slug> --primary`. Only one source per org should be primary. If there's no clear top-level changelog, don't mark any as primary.

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
