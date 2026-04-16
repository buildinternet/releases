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
3. **Fast fetch (static providers)** — for providers known to serve pre-rendered HTML (Docusaurus, VitePress, WordPress, Ghost, Mintlify), fetch without headless browser rendering. Uses Cloudflare crawl API with `render: false`. ~10-30x faster than full rendering. Controlled by provider `staticContent` hint or per-source `renderRequired` metadata.
4. **Cloudflare rendering** — for JS-heavy pages (React SPAs, Notion, etc.), use Cloudflare's browser rendering API to get the fully-rendered HTML. Fallback when fast fetch returns no content.

After fetching content, the pipeline parses it:
- **Incremental parsing** — if the source already has releases in the database, extract only new ones by comparing against known releases. This is the default for subsequent fetches.
- **Bulk parsing** — parse the entire page into releases. Used on first fetch or when `--full` is specified.

## Fetching

Trigger a fetch for a source by ID or slug. CLI: `releases admin source fetch <slug> [--dry-run] [--max <n>]`. Typed tool: `fetch_source` with identifier (ID or slug) param.

Key CLI flags (not available via typed tool — the typed tool always does a full server-side fetch):
- `--dry-run` — parse but don't persist. Essential for validation.
- `--max <n>` — limit releases to extract (default: 200).
- `--full` — bypass incremental parsing, force full re-parse.
- `--crawl` / `--no-crawl` — enable/disable crawl mode.

### Checking results

After fetching, verify releases were persisted. CLI: `releases latest <slug> --json` or `releases admin source fetch-log <slug>`. Typed tool: `get_latest_releases` with source param. Use `get_organization` (or `releases admin org show <slug> --json`) to see the full picture of an org's sources.

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

## Feed Content Depth Assessment

**Automatic detection:** The feed adapter now auto-detects title-only feeds — if every item has fewer than 20 characters of content, the feed is marked `feedContentDepth: "summary-only"` and `fetchViaFeed` returns null, causing the scrape adapter to fall through to crawl or single-page extraction. This handles the worst case (feeds like Notion, Apollo, LangChain, LaunchDarkly that carry only `<title>` + `<link>` with no `<description>` or `<content:encoded>`) without manual intervention. Once marked, the flag persists and subsequent fetches skip the feed entirely.

**Manual assessment is still required for partial-content feeds.** Auto-detection only catches completely empty content. Many feeds provide decent text summaries but the actual pages have significantly richer content — product screenshots, video demos, detailed code examples, and inline media that the feed strips out.

**The anti-pattern to avoid:** fetching the bare changelog index, seeing that content came back, and declaring success without ever checking whether each release has a dedicated article page with more detail. A paragraph of feed text is not evidence that the page is equally thin.

**When to check:** After every feed fetch where `feedContentDepth` is not already set. Do not skip this because feed entries have multiple sentences. The question is not "does the feed have some content?" but "does the actual page have substantially more?"

**How to check:** Dispatch a bulk-worker subagent to sample 2-3 release URLs. Prompt the subagent:

> "Fetch these URLs with WebFetch and compare the page content against these feed summaries. For each URL, report: (1) how much content is on the page vs the feed summary, (2) whether there are images, screenshots, or embedded videos (YouTube, Vimeo, Loom), (3) whether there are code examples or detailed explanations not in the feed. Summarize your findings."

Do NOT fetch release URLs in the parent agent — always delegate to a subagent to keep your context window clean.

**What to do based on the result:**

If pages are richer than feed content (more text, images, videos, or code examples):
1. Record the assessment and enable crawl mode. CLI: `releases admin source edit <identifier> --metadata '{"feedContentDepth":"summary-only","crawlEnabled":true}'`. Typed tool: `edit_source` with the same metadata. Subsequent fetches will follow links to per-release pages and extract full content in one pass.
2. Re-fetch the source once to backfill. CLI: `releases admin source fetch <slug> --full`. Typed tool: `fetch_source`.
3. Verify results. CLI: `releases list <slug> --json` or `releases latest <slug>`. Typed tool: `get_latest_releases` — check content is richer after the re-fetch.

If feed already provides full content with no meaningful additions on the page:
1. Record `feedContentDepth: "full"` so future sessions skip the sampling step.

Once `feedContentDepth` is set, skip the sampling step on future encounters. Crawl mode handles the rest during normal fetches — there is no separate enrichment phase.

**Per-source AI instructions:** If a source has unique content patterns (e.g., videos always embedded, unusual changelog format), note this in the discovery state so parseInstructions can be set later via the CLI.

## Blog-Style Sources

Engineering blogs and news pages mix product announcements with educational content, opinion pieces, and corporate news. They can be useful supplementary sources but require aggressive filtering via `parseInstructions` to avoid noise.

**Before working with blog sources:** Check the org's playbook (`releases admin content playbook <org>`) for notes about how existing blog sources perform, what filtering works, and which products they cover.

**When to add a blog source:**
- The org's primary changelogs don't cover major product announcements (new models, new services)
- The blog has engineering/product content not found elsewhere
- The blog is a secondary signal source — primary coverage should come from dedicated changelogs

**How to configure:**
1. Add as `--type scrape` with `--priority low` (blog pages change infrequently)
2. Set `parseInstructions` that tell the AI what to include and — more importantly — what to skip
3. Always dry-run first: `releases admin source fetch <slug> --dry-run` to check signal-to-noise ratio
4. Iterate on instructions: tighten if too many irrelevant posts, loosen if genuine announcements are being filtered

**Writing effective parseInstructions for blogs:**

- Be explicit about what to SKIP — blogs have more noise categories than changelogs
- Use concrete signals: "titles containing 'Introducing'" is better than "posts about new features"
- Add a default-skip rule: "When in doubt, skip the post"
- Name the noise categories: "best practices guides, benchmark analyses, eval methodology, postmortems, partnership announcements, policy statements"
- For corporate news pages: skip partnerships, MOUs, office openings, funding, acquisitions, research papers, safety reports

**Example parseInstructions for an engineering blog:**
```
ONLY extract posts that announce a NEW product, feature, tool, service, or capability.
Signals: titles containing "Introducing", "launching", or describing something new.
SKIP: best practices guides, benchmark analyses, eval methodology, postmortems,
technical deep-dives, and educational content. When in doubt, skip.
```

**Example parseInstructions for a corporate news page:**
```
ONLY extract posts about: (1) new model launches, (2) major new product features or services,
(3) significant platform capability announcements. Skip all: partnerships, MOUs, policy statements,
office openings, funding, acquisitions, research publications, safety reports, and opinion pieces.
```

**Versioning:** Blog posts don't have traditional version strings. Set `parseInstructions` to tell the AI that dates are not versions (same as for date-headed changelogs like Claude's consumer release notes).

**Content depth:** Blog index pages typically show card summaries, not full post content. The extracted releases will have thin content. Enable crawl mode (`--crawl`) to follow links to full posts if richer content is needed, but this is expensive — only enable for high-value sources.

## Dates

Every release should get a `publishedAt` if one can be recovered from the page, even an approximate one — sources with no dates drop out of the release feed's time-based views entirely.

- **Full dates** ("March 3, 2026", "2026-03-03"): use the exact ISO date — `2026-03-03`.
- **Month-only headings** ("April 2026", "March 2026"): use the **first of the month** — `2026-04-01`. Many API changelogs (e.g. Brex Developer API) group entries by month; this is the right call, not "omit date."
- **Quarter or season** ("Q3 2025", "Fall 2025"): use the first day of the quarter/season (Q3 → `2025-07-01`, Fall → `2025-09-01`).
- **Year only** ("2025"): use `2025-01-01`.
- **Nothing recoverable**: omit `publishedAt`. Only do this if there truly is no date signal anywhere — check adjacent headings, breadcrumbs, and the URL slug before giving up.

Approximation is better than omission. A release with an approximate month-start date still surfaces in sort orders, "last 30 days" windows, and monthly groupings.

## Classifying Rollups

Most releases are **features** — individual version bumps, single product announcements, or tight incremental changelog entries. Some are **rollups** — seasonal, quarterly, or annual catch-all pages that collect many already-shipped features into a single banner post. The parser assigns each release a `type` field so agents and the web UI can treat them differently.

**When to set `type: "rollup"`:**

- The title names a season, quarter, or year range: "Fall Release 2025", "Spring 2026", "Q3 2025", "Summer '25 Edition", "New on Ramp January Edition", "Year in Review 2025", "What Shipped This Summer".
- The page re-announces many shipped features under section headings, rather than describing a single change.
- The post is published once, rarely updates, and anchors a date range (not a single `publishedAt` moment).
- The destination may be a full microsite or editorial landing page (not just a blog post) — rollups often get custom design treatment because they're marketing moments as well as product updates.
- Common examples: Shopify Editions (`shopify.com/editions/summer2025`, twice-yearly microsite with 100+ features), Brex Fall Release, Ramp quarterly blog posts, Vercel Ship recaps, Stripe Sessions roundups, AWS re:Invent summaries.

**When NOT to set rollup:**

- Single version releases (v2.0.0, v15.1), even when they bundle multiple fixes — those are features.
- Dated changelog entries like "March 3, 2026" that cover one day's changes.
- Blog posts announcing a single new product.
- Named platform launches (Next.js 15, Node 22 LTS) — those are version-anchored features, not rollups.

**How to recognize rollup sources:**

Before parsing, **always read the playbook** (CLI: `releases admin content playbook <org>`, typed tool: `get_playbook` with organization param). If a company publishes rollups as its primary cadence — quarterly, seasonal, "every few months" — the playbook notes should say so explicitly. Example notes:

- "Brex publishes quarterly seasonal rollup pages at `/product-announcements/{fall,spring,summer,winter}-release-YYYY`. Treat each as `type: rollup`."
- "Ramp's blog series `/blog/new-on-ramp-*-edition` and `/new-on-ramp-q*-*` are quarterly/monthly rollups. Classify as `type: rollup`; individual features within are not separately indexed."
- "Shopify publishes twice-yearly Editions as standalone microsites at `/editions/{summer,winter}YYYY` — index page at `/editions` lists all of them. Each Edition is a `type: rollup` with 100+ features under themed sections; crawl mode needed to pull the full page."

When you encounter a new rollup source during discovery or fetch, update the playbook notes so future fetches classify correctly without re-deriving the pattern. See the `managing-sources` skill for how to update notes.

**Leave `type` unset or `"feature"` by default.** Only mark rollup when the signals are clear.

## Validation Workflow

When adding a new source, always validate before committing:

1. **Fetch** — CLI: `releases admin source fetch <slug> --dry-run` then `releases admin source fetch <slug>`. Typed tool: `fetch_source` with identifier (ID or slug).
2. **Verify** — CLI: `releases latest <slug> --json` or `releases admin source fetch-log <slug>`. Typed tool: `get_latest_releases` with source identifier.
3. **If poor results** — try a different URL or type. CLI: `releases admin source edit <identifier> --type feed`. Typed tool: `edit_source` with identifier.
4. **If no usable releases** — remove the source. CLI: `releases admin source remove <slug> --ignore --reason "..."`. Typed tool: `remove_source` with identifier, then `exclude_url`.
