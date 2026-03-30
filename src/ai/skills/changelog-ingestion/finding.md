# Finding Changelogs

Determine the best way to get structured release data from a changelog or release notes page.

Many pages have better-structured data sources behind them — RSS feeds, raw markdown files, or API endpoints. Finding those avoids the complexity of parsing rendered HTML.

## How It Works

An agent evaluates the page, supported by automated pre-checks that run before it. The agent always makes the final call.

### Pre-checks (automated, run before the agent)

These provide context but don't make the decision:

- **Provider fingerprinting** identifies the hosting platform (Mintlify, ReadMe, Docusaurus, Ghost, etc.) via DNS CNAME, HTTP headers, and HTML patterns. Each provider has known capabilities (feed paths, markdown suffix support, crawl patterns).
- **Feed discovery** probes ~15 well-known feed paths and HTML `<link rel="alternate">` tags.
- **Provider-specific probes**: If a provider is detected, tries its known feed paths and capabilities (e.g., Mintlify's `.md` suffix for raw markdown).

The agent receives these results so it doesn't repeat work.

### Agent evaluation

The agent fetches the page and makes the recommendation. When pre-checks already found a feed or markdown source, the agent confirms and adds detail (page structure, alternatives). When pre-checks found nothing, the agent digs deeper:

- Feed URLs in JavaScript (not in HTML `<link>` tags or standard paths)
- GitHub repository links ("View on GitHub", "CHANGELOG.md on GitHub")
- Raw markdown or data file links
- Page structure (single-page changelog vs. index of links)

### Error resilience

If the agent can't run (context overflow on huge pages, API errors), the system falls back to pre-check results. This means the evaluation still produces a useful result even when the page is too large for the model.

## Agent Guidelines

You'll receive pre-check results as context. Use them:

- **Feed already found?** Confirm it and note the page structure as additional context.
- **Provider detected, no feed?** The pre-checks already tried that provider's known paths. Look for feeds the automated checks couldn't find (JS-rendered links, non-standard paths).
- **Nothing found?** Fetch the page and evaluate from scratch.

### What to look for

1. **Feeds** — best option. RSS/Atom/JSON feeds provide structured, dated release entries. Check the page source for feed URLs embedded in JavaScript.
2. **GitHub repos** — great option. If the page links to a GitHub repository, that repo likely has structured releases via the API.
3. **Raw markdown** — good option. Some pages link to their source `.md` files (especially on GitHub).
4. **Page structure** — if no structured source exists, classify what you see so the system knows how to scrape it.

### Priority
Feeds > GitHub Releases API > raw markdown > page scraping.

### Reporting

Call `report_evaluation` with:
- **recommended_method**: `feed`, `github`, `markdown`, `scrape`, or `crawl`
- **recommended_url**: The URL to use (may differ from input)
- **feed_url** / **feed_type**: If found
- **github_repo**: In `owner/repo` format
- **page_structure**: `single-page`, `index`, or `unknown`
- **alternatives**: Other viable sources
- **confidence**: `high` (structured source), `medium` (clear structure), `low` (unclear)
- **notes**: Anything notable

## Known Provider Capabilities

Detected automatically in pre-checks. Listed for reference:

| Provider | Feed Paths | Markdown Suffix | Crawl Pattern |
|----------|-----------|-----------------|---------------|
| Mintlify | `/rss.xml` | Yes (`.md`) | — |
| ReadMe | `/changelog.rss` | — | — |
| Docusaurus | `/blog/rss.xml`, `/blog/atom.xml`, `/blog/feed.json` | — | — |
| Ghost | `/rss/` | — | — |
| WordPress | `/feed/` | — | — |
| Productboard | `/changelog.rss`, `/changelog/feed` | — | — |
| Headway | `/feed` | — | — |
| Beamer | `/feed` | — | — |
| LaunchNotes | `/rss` | — | — |

Providers without feeds (GitBook, Notion, Intercom, Zendesk, Help Scout, Freshdesk, Confluence, Canny) are detected for their crawl patterns and changelog path hints.
