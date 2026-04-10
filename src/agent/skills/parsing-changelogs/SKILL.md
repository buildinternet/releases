---
name: parsing-changelogs
description: How the Released fetch and parse pipeline works — covers feed vs scrape adapters, incremental vs bulk parsing, dry-run testing, crawl mode, content hashing, and enrichment
---

# Parsing Changelogs

How the Released fetch pipeline converts changelog pages into structured release data.

## Pipeline Overview

The fetch pipeline follows this priority order:

1. **Feed adapter** — if the source has a known feed URL (in `metadata.feedUrl`), fetch and parse the feed directly. Fastest and most reliable.
2. **Markdown fetch** — if `metadata.markdownUrl` is set, fetch raw markdown instead of rendered HTML.
3. **Cloudflare rendering** — for JS-heavy pages, use Cloudflare's browser rendering API to get the fully-rendered HTML.
4. **Direct fetch** — fetch the page HTML directly as a fallback.

After fetching content, the pipeline parses it:
- **Incremental parsing** — if the source already has releases in the database, extract only new ones by comparing against known releases. This is the default for subsequent fetches.
- **Bulk parsing** — parse the entire page into releases. Used on first fetch or when `--full` is specified.

## Tools

### `fetch_source`

Trigger a fetch for a source by slug. For feed/GitHub sources, the fetch runs server-side. For scrape/agent sources, the source is flagged for CLI pickup.

### Checking results

Use `get_latest_releases` with the source slug after fetching to verify releases were persisted. Use `get_organization` to see the full picture of an org's sources and their fetch status.

## Incremental vs Bulk Parsing

- **Incremental** (default for sources with existing releases): The parser receives a list of known release titles/versions and extracts only releases that don't match any known ones. Much faster and cheaper for sources that add releases incrementally.
- **Bulk** (first fetch or `--full`): Parses the entire page content into releases. Used when no releases exist yet or when you suspect the incremental parser missed something.

## Content Hashing

Each fetch computes a SHA-256 hash of the page content. If the hash matches the previous fetch, parsing is skipped entirely (no AI calls). This prevents redundant processing when a page hasn't changed.

## Crawl Mode

For index-style pages that link to individual release pages:

1. The crawler follows links matching the crawl pattern (auto-detected or from provider hints).
2. Each linked page is fetched and parsed individually.
3. Results are aggregated into releases.

Enable with `--crawl` flag or by setting `metadata.crawlEnabled: true` on the source.

## Enrichment

Enrichment hydrates releases that have sparse content by fetching full page content and extracting richer data. Enrichment runs server-side and is not available as a managed agent tool — it is triggered automatically for sources with `autoEnrich: true` in their metadata, or run via the CLI.

## Feed Content Depth Assessment

**This is a mandatory step during onboarding for every feed and scrape source.** Always spot-check individual release pages even if the feed content looks adequate. Many feeds provide decent text summaries but the actual pages have significantly richer content — product screenshots, video demos, detailed code examples, and inline media that the feed strips out.

**When to check:** After every feed fetch, regardless of content length. Do not skip this because feed entries have multiple sentences. The question is not "does the feed have some content?" but "does the actual page have substantially more?"

**How to check:** Dispatch a bulk-worker subagent to sample 2-3 release URLs. Prompt the subagent:

> "Fetch these URLs with WebFetch and compare the page content against these feed summaries. For each URL, report: (1) how much content is on the page vs the feed summary, (2) whether there are images, screenshots, or embedded videos (YouTube, Vimeo, Loom), (3) whether there are code examples or detailed explanations not in the feed. Summarize your findings."

Do NOT fetch release URLs in the parent agent — always delegate to a subagent to keep your context window clean.

**What to do based on the result:**

If pages are richer than feed content (more text, images, videos, or code examples):
1. Record and enable auto-enrichment via `edit_source` — set metadata to indicate summary-only content depth and auto-enrichment
2. Enrichment will run automatically on future fetches
3. Verify with `get_latest_releases` — check content is richer after enrichment

If feed already provides full content with no meaningful additions on the page:
1. No enrichment needed for this source

Once `feedContentDepth` is set, skip the sampling step on future encounters. Sources with `autoEnrich: true` will automatically enrich new releases after each feed fetch.

**Per-source AI instructions:** If a source has unique content patterns (e.g., videos always embedded, unusual changelog format), note this in the discovery state so parseInstructions can be set later via the CLI.

## Validation Workflow

When adding a new source, always validate before committing:

1. Use `fetch_source` with the slug — check the results
2. Use `get_latest_releases` with the source slug to verify releases were persisted
3. If results are poor, try a different URL or type via `edit_source`
4. If no usable releases, `remove_source` the slug
