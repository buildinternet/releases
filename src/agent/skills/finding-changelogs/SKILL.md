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

For `github` sources, the fetch pipeline ingests tagged releases **and** the repo's canonical `CHANGELOG.md` (or `CHANGES.md` / `HISTORY.md` / `RELEASES.md` / `NEWS.md` at the repo root) on every fetch pass — the file is surfaced in the web UI as a separate tab, exposed via the `get_source_changelog` MCP tool, and is often the richer source when a project ships entries that never became tagged releases. The refresh piggybacks on each GitHub fetch with a content-hash short-circuit, so stored files stay in sync with tagged releases. You don't need to add a second source for the CHANGELOG file; the github adapter handles both.

### Reading a tracked CHANGELOG

Once a github source is tracked, its CHANGELOG is readable via `GET /v1/sources/:slug/changelog` (REST), the `get_source_changelog` MCP tool, or `releases admin source changelog <slug>` (CLI). All three support heading-aligned slicing in two modes:

- **Token mode** (preferred for agent context budgeting) — pass `tokens` / `--tokens` with a cl100k_base budget. The response carries `sliceTokens` (actual count of the returned chunk) and `totalTokens` (whole file) so you can plan context precisely. Recommended brackets: 2000 / 5000 / 10000 / 20000.
- **Char mode** — pass `limit` / `--limit` for character budgets. Same snap/overshoot rules.

`tokens` wins when both are passed. Chain successive calls via the returned `nextOffset` to page through big files (e.g. Apollo Client's 700KB CHANGELOG) without pulling the whole thing at once. Every response includes `totalTokens` upfront, so you can budget the number of calls before you start reading.

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

## Evaluation

Evaluate a URL to determine the best ingestion method. CLI: `releases admin discovery evaluate <url> --json`. Typed tool: `evaluate_url` with url param.

Key fields in output:
- `recommendedMethod`: `feed`, `github`, `markdown`, `scrape`, or `crawl`
- `recommendedUrl`: The URL to use (may differ from the input URL)
- `feedUrl` / `feedType`: If a feed was found
- `githubRepo`: In `owner/repo` format, if applicable
- `pageStructure`: `single-page`, `index`, or `unknown`
- `confidence`: `high` (structured source found), `medium` (clear page structure), `low` (unclear)
- `alternatives`: Other viable sources found

## Checking Existing Sources

Search with a domain or company name query to check what sources already exist. CLI: `releases list --query <text> --json`. Typed tool: `list_sources` with query param. Use as a starting point when you don't know where a company's changelogs live.

## Pre-checks (automated)

The evaluate operation runs these before returning:

- **Provider fingerprinting** — identifies the hosting platform (Mintlify, ReadMe, Docusaurus, Ghost, etc.) via DNS CNAME, HTTP headers, and HTML patterns. Each provider has known capabilities.
- **Feed discovery** — probes ~15 well-known feed paths and HTML `<link rel="alternate">` tags.
- **Provider-specific probes** — if a provider is detected, tries its known feed paths and markdown suffix.

## When to Evaluate Manually

If evaluation returns `confidence: low` or `recommendedMethod: scrape`, you may want to investigate the page yourself:

1. **Fetch the page** with `WebFetch` and look at the HTML source.
2. **Look for feeds** — feed URLs embedded in JavaScript, non-standard paths, or links to RSS/Atom.
3. **Look for GitHub repos** — "View on GitHub", "CHANGELOG.md on GitHub", or repository links.
4. **Look for raw markdown** — links to source `.md` files.
5. **Classify the page structure** — is it a single-page changelog or an index of links to individual release pages?

## Primary Changelogs

When evaluating multiple changelog sources for an org, identify which one is the company's **primary changelog** — the top-level, platform-wide changelog that covers the product as a whole. This is typically a website changelog page (e.g., `example.com/changelog`) rather than individual GitHub repos or product-specific pages.

After adding sources, mark the primary one. CLI: `releases admin source edit <identifier> --primary`. Typed tool: `edit_source` with identifier (ID or slug) and is_primary: true. Only one source per org should be primary. If there's no clear top-level changelog, don't mark any as primary.

## When to Use Crawl

Use `--crawl` (or set `crawlEnabled` in source metadata) when:
- The page is an **index** linking to individual release pages (e.g., `/changelog/2024-03-15`)
- Single-page scraping only gets titles/dates but not full content
- The provider is known to use per-release pages (Intercom, Notion, some custom sites)

Do NOT use crawl for single-page changelogs or feeds.

## Known Provider Capabilities

Detected automatically in pre-checks. Listed for reference:

| Provider | Feed Paths | Markdown Suffix | Static | Notes |
|----------|-----------|-----------------|--------|-------|
| Mintlify | `/rss.xml` | Yes (`.md`) | Yes | — |
| Fern | `/changelog.rss`, `/docs/changelog.rss` | — | No | RSS contains `fve-mdx-b64` attributes (noise, stripped automatically). `<generator>` tag = `buildwithfern.com`. |
| ReadMe | `/changelog.rss` | — | No | — |
| Docusaurus | `/blog/rss.xml`, `/blog/atom.xml`, `/blog/feed.json` | — | Yes | — |
| Ghost | `/rss/` | — | Yes | — |
| WordPress | `/feed/` | — | Yes | — |
| Productboard | `/changelog.rss`, `/changelog/feed` | — | No | — |
| Headway | `/feed` | — | No | — |
| Beamer | `/feed` | — | No | — |
| LaunchNotes | `/rss` | — | No | — |
| GitBook, Notion, Intercom, Zendesk, etc. | — | — | No | No feeds; use crawl or scrape. Some may expose a title-only RSS feed (no content body) — these are auto-detected as `summary-only` and fall through to scrape |

## Rendering Optimization

When a source uses the `scrape` type and falls through to the single-page Cloudflare path, the adapter checks whether the provider serves pre-rendered HTML. Static providers (Docusaurus, VitePress, WordPress, Ghost, Mintlify, etc.) don't need a headless browser — the content is already in the HTML response.

For static providers, the adapter automatically uses Cloudflare's crawl API with `render: false`, which is ~10-30x faster than headless browser rendering and currently free.

**When evaluating a new scrape source**, note the provider in the playbook. If the provider isn't in the table above but you can see from the page source that content is in the initial HTML (no loading spinners, no `<div id="root"></div>` shells), set `--no-render` on the source to enable the fast path.

**If a fast fetch returns incomplete content**, the adapter falls back to full rendering automatically. If you notice this happening repeatedly for a source, set `--render` to force headless rendering and note the reason in the playbook.

The agent's role is to evaluate content completeness after the first fetch — check that releases have titles, dates, and content. If they do, the fast path is working. If releases are empty or missing, the page likely needs JS rendering.

## Source Selection and Scope

Prefer **3–5 high-signal sources per org** over exhaustive coverage. More sources means more noise, more maintenance, and diminishing returns. Every source you add should justify itself — if you wouldn't want to read its releases, don't add it.

### Core products vs ecosystem

Only index an org's **own products**, not their ecosystem or community plugins. For example:

- **Terraform** (core product) — yes
- `terraform-provider-aws` (ecosystem plugin maintained by a different team) — no
- **Next.js** (Vercel's own framework) — yes
- `next-auth` (community library) — no

Signs that a repo is ecosystem, not core:
- Maintained by a different team or community contributors
- One of hundreds of similar repos (providers, plugins, extensions, adapters)
- Ships independently of the org's main release cycle
- The org wouldn't mention it in their own changelog

### Staleness signals — when to skip

Skip sources that show signs of being inactive or low-value:
- **Maintenance mode:** No meaningful releases in 6+ months, or only dependency bumps
- **Pre-release only:** Recent "releases" are all dev/alpha/RC builds with no stable versions
- **Superseded:** The product has been replaced by a successor (e.g., Vagrant → dev containers)
- **Winding down:** The org has announced deprecation or deprioritization
- **Low adoption:** The product exists but has minimal real-world usage

When in doubt, add and pause rather than skip entirely. A focused index with 3 core sources is more useful than 11 sources where half are noise.

### Add and pause, don't omit

When you find a source that matches the staleness or ecosystem criteria above, **still add it to the database** but immediately set it to `--priority paused`. This prevents future onboard runs from rediscovering the same source and re-evaluating it. The source record serves as documentation that "we know about this, and we decided not to track it."

Add the source and immediately set it to paused priority. CLI: `releases admin source add <name> --url <url> --org <org> --type github` then `releases admin source edit <identifier> --priority paused`. Typed tools: `add_source` then `edit_source` with identifier (ID or slug) and fetch_priority: "paused".

Do the same for ecosystem plugins, deprecated products, and low-value repos. The goal is to capture the discovery decision, not to lose the knowledge.

## Products, Categories, and Tags

Organizations can have multiple distinct products (e.g., Vercel → Next.js, Turborepo, v0). When discovering sources for an org, consider whether they belong to separate products.

Use product and org management operations to organize what you find. CLI: `releases admin product add`, `releases admin org tag add`, `releases categories`. Typed tools: `manage_product`, `manage_org`, `list_categories`. The full list of valid categories is provided in your system prompt.

Don't force product groupings when sources are ambiguous — leave them at the org level and note suggestions in the state file.
