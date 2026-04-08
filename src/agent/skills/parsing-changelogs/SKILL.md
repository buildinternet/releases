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

## CLI Commands

### `releases fetch <slug>`

Fetch and parse releases for a source. Key flags:

- `--dry-run` — parse but don't persist to the database. Essential for validation.
- `--max <n>` — limit the number of releases to extract (default: 200).
- `--full` — bypass incremental parsing, force a full re-parse of the page.
- `--crawl` — enable crawl mode (follow links to individual release pages).
- `--no-crawl` — disable crawl mode even if `crawlEnabled` is set in metadata.
- `--no-summarize` — skip AI summary generation.
- `--all` — remove the max release cap.

### `releases fetch-log <slug>`

Show recent fetch history for a source. Useful for debugging fetch issues — shows timestamps, release counts, errors, and content hashes.

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

Use the `releases enrich <slug>` command to hydrate releases that have sparse content. This uses Haiku to judge which releases need enrichment, then fetches and extracts full page content.

`releases enrich <slug> --dry-run` previews what would be enriched. `releases enrich <slug> --limit 5` caps the batch size.

## Feed Content Depth Assessment

**This is a mandatory step during onboarding for every feed and scrape source.** Always spot-check individual release pages even if the feed content looks adequate. Many feeds provide decent text summaries but the actual pages have significantly richer content — product screenshots, video demos, detailed code examples, and inline media that the feed strips out.

**When to check:** After every feed fetch, regardless of content length. Do not skip this because feed entries have multiple sentences. The question is not "does the feed have some content?" but "does the actual page have substantially more?"

**How to check:** Dispatch a bulk-worker subagent to sample 2-3 release URLs. Prompt the subagent:

> "Fetch these URLs with WebFetch and compare the page content against these feed summaries. For each URL, report: (1) how much content is on the page vs the feed summary, (2) whether there are images, screenshots, or embedded videos (YouTube, Vimeo, Loom), (3) whether there are code examples or detailed explanations not in the feed. Summarize your findings."

Do NOT fetch release URLs in the parent agent — always delegate to a subagent to keep your context window clean.

**What to do based on the result:**

If pages are richer than feed content (more text, images, videos, or code examples):
1. Record and enable auto-enrichment: `releases edit <slug> --metadata '{"feedContentDepth":"summary-only","autoEnrich":true}'`
2. Dispatch a bulk-worker subagent to run: `releases enrich <slug>`
3. Verify a sample: `releases list <slug> --json` — check content is now richer and media array is populated

If feed already provides full content with no meaningful additions on the page:
1. Record: `releases edit <slug> --metadata '{"feedContentDepth":"full"}'`
2. No enrichment needed — skip `releases enrich` for this source

Once `feedContentDepth` is set, skip the sampling step on future encounters. Sources with `autoEnrich: true` will automatically enrich new releases after each feed fetch.

**Per-source AI instructions:** If a source has unique content patterns (e.g., videos always embedded, unusual changelog format), set `parseInstructions` on the source metadata to guide the AI parser:

```bash
releases edit <slug> --metadata '{"parseInstructions":"This source embeds YouTube demo videos in every release — always look for video links."}'
```

**Cost visibility:** The `releases enrich` command reports token usage. Check aggregate costs with `releases usage` filtered to `enrich-judge` and `enrich-extract` operations.

## Validation Workflow

When adding a new source, always validate before committing:

1. `releases fetch <slug> --dry-run` — check if parsing works
2. Look at the output: How many releases? Do they have titles, dates, content?
3. If results are poor, try a different URL, type, or crawl mode
4. If results are good, run `releases fetch <slug>` to persist

## Smart Fetch (`--stale`)

`releases fetch --stale <hours>` fetches sources that haven't been checked recently. It respects:
- **Backoff** — sources with consecutive unchanged fetches are checked less frequently (1h-48h)
- **Error backoff** — sources with consecutive errors back off more aggressively (1h-72h)
- **Priority** — `fetchPriority` field on sources controls ordering

> **Remote mode guardrail:** Bare `releases fetch` (no slug or filter) is blocked in remote mode. Always provide a slug or use `--stale`/`--unfetched`/`--retry-errors`. Use `releases task list` to check for active sessions and `releases task cancel <id>` to stop one.
