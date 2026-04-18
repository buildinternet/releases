---
name: managing-sources
description: How to add, remove, list, validate, and manage changelog sources — covers ignored/blocked URLs, duplicate detection, and the validation workflow
---

# Managing Sources

Operational guide for managing changelog sources.

## Tool Reference

Operations can be performed via CLI commands or typed MCP/agent tools. Use whichever interface is available in your context.

| Operation | CLI | Typed tool |
|-----------|-----|------------|
| List sources | `releases list [slug] --json [--org <org>] [--query <text>] [--has-feed] [--category <c>] [--compact] [--limit <n>] [--page <n>]` | `list_sources` with query, organization, category, has_feed params |
| Add source | `releases admin source add <name> --url <url> [--type <type>] [--org <org>] [--feed-url <url>]` | `add_source` with name, url, type, organization, feed_url params |
| Edit source | `releases admin source edit <identifier> [--primary] [--priority <p>]` | `edit_source` with identifier (ID or slug), is_primary, fetch_priority params |
| Remove source | `releases admin source remove <slug> [--ignore --reason <reason>]` | `remove_source` with identifier (ID or slug) param |
| Fetch releases | `releases admin source fetch <slug> [--dry-run] [--max <n>]` | `fetch_source` with identifier (ID or slug) param |
| Get latest releases | `releases tail [slug] --json [--org <org>]` | `get_latest_releases` with source, organization, limit params |
| Search releases | `releases search <query> --json` | `search_releases` with query, limit params |
| Evaluate URL | `releases admin discovery evaluate <url> --json` | `evaluate_url` with url param |
| Add org | `releases admin org add <name> [--domain <d>] [--description <t>] [--category <c>] [--tags <t1,t2>]` | `manage_org` action "add" with name, domain, description, category, tags |
| Edit org | `releases admin org edit <slug> [--category <c>]` | `manage_org` action "edit" with identifier, category |
| Show org | `releases admin org show <slug> --json` | `get_organization` with identifier |
| Add tags to org | `releases admin org tag add <slug> <tags...>` | `manage_org` action "tag_add" with identifier, tags |
| Link account | `releases admin org link <slug> --platform <p> --handle <h>` | `manage_org` action "link_account" with identifier, platform, handle |
| Add product | `releases admin product add <name> --org <org> [--category <c>] [--tags <t>]` | `manage_product` action "add" with name, organization, category, tags |
| Ignore URL | `releases admin policy ignore add --org <org> <url>` | `exclude_url` action "ignore" with url, organization |
| Block URL | `releases admin policy block add <url>` | `exclude_url` action "block" with url |
| List categories | `releases categories --json` | `list_categories` |
| Get playbook | `releases admin content playbook <org>` | `get_playbook` with organization param |
| Update playbook notes | `releases admin content playbook <org> --notes "..."` | `update_playbook_notes` with organization, notes params |

## Listing Sources

Search for existing sources with optional filters:
- **query** — filter by name, slug, or URL
- **organization** — filter by org ID or slug
- **product** — filter by product ID or slug
- **category** — filter by category
- **has_feed** — only sources with a discovered feed URL

Use `--json` (CLI) for structured output. Typed tools always return JSON.

## Adding Sources

Required: **name** and **url**. Optional: **type** (github, scrape, feed, agent — auto-detected from URL if omitted), **organization** (org ID or slug to associate with), **feed_url** (direct feed URL if known).

### Naming sources and products

**Don't prefix names with the org name.** The org is already shown as context on every page — repeating it in each child source produces noise like "Datadog › Datadog dd-trace-py". Pick the bare, recognizable name instead.

Rules, in priority order:

1. **GitHub sources → use the repo name.** `DataDog/dd-trace-py` → `dd-trace-py`, `vercel/next.js` → `next.js`. That's the name devs already recognize; the `owner/repo` byline underneath disambiguates.
2. **Website/feed sources → strip the org name if present.** `Datadog Browser SDK` → `Browser SDK`, `Stripe API Changelog` → `API Changelog`.
3. **Keep the org prefix only when it's part of the canonical product name.** `Claude Code`, `GitHub Actions`, `Google Cloud Run`, `Amazon S3` — people say them that way. If you strip the prefix and what's left is the actual name people use, strip. If stripping produces something nobody would recognize on its own, keep the prefix.
4. **Org-level content sources keep the prefix.** `Datadog Blog`, `Vercel Engineering Blog` — "Blog" alone is meaningless, and org-prefix is the standard convention. Same for "Newsroom", "Announcements".
5. **Products follow the same rules.** A product under Vercel should be `Next.js`, not `Vercel Next.js`. A product under Datadog whose actual name is `Agent` stays `Agent` — the org context above it already says Datadog.

When in doubt: would a developer reading this name on its own (with the org already shown above) recognize what it is? If yes, strip. If no, keep the prefix.

### Organization descriptions

When creating an org, include a brief one-sentence product description. This grounds AI summaries for lesser-known products, and it's also the primary signal for the entity vector index — `search_registry` and the registry side of hybrid search match on description + category, not just name. A good description noticeably improves recall.

### Embedding side effects

Adding or editing an org, product, or source triggers an entity embedding into the registry vector index in the background (fire-and-forget on the worker, never blocks the write). PATCHes are gated on the embed-relevant fields (name, description, category, domain, url) actually changing, so cosmetic edits and poll-driven metadata bumps don't re-embed. There's no manual step — if a write succeeds, treat the embedding as in-flight. If you ever need to verify or backfill, run `releases admin embed status` and then `releases admin embed entities` (remote mode only).

## Removing Sources

When removing discovery results, also ignore the URL to prevent re-discovery. In CLI: `releases admin source remove <slug> --ignore --reason "..."`. With typed tools: call `remove_source` then `exclude_url` with action "ignore".

## Ignored URLs (org-scoped)

A URL ignored for one org can still be valid for another org. Always scope ignores to the relevant organization.

## Blocked URLs (global)

For spam domains and known-bad URLs that should never be added for any org. Use block_type "domain" to block an entire domain.

## Validation Workflow

After adding a source, validate it:

1. **Add the source** — provide name and URL
2. **Fetch** — trigger a fetch (CLI: `--dry-run` for preview, then real fetch; typed tools: `fetch_source`)
3. **Check results** — get latest releases and verify they have titles, dates, content
4. **If bad:** remove the source and ignore the URL
5. **If good:** the source is ready for production fetches

## Primary Sources

An org can have one source marked as its **primary changelog** — the main, company-wide changelog. Mark it with `--primary` (CLI) or `is_primary: true` (typed tool).

When onboarding an org, if you find a single top-level changelog alongside product-specific or GitHub sources, mark the top-level one as primary.

## Playbooks

Each org has a **playbook** — a README that tells any agent how to efficiently work with that org's changelog sources. The playbook has two layers:

- **Header** — auto-generated from source metadata. Shows source types, URLs, priorities, parseInstructions, and product groupings. Regenerates automatically on every source mutation. You never edit this directly.
- **Agent notes** — free-form markdown that you fully control. This is the most important part of the playbook. Write it like a README for a teammate who needs to fetch releases from this org without asking questions.

**Always read the playbook before fetching or working with an org's sources.** Typed tool: `get_playbook` with organization param. CLI: `releases admin content playbook <org>`. If no playbook exists yet, one will be auto-generated on the next source mutation (add/edit/remove).

### Writing good agent notes

Write notes like a **skill for the agent that will fetch from this org** — imperative, action-oriented, concise. The reader is an agent about to do work; tell it what to do and what to watch for, not what things are.

Organize notes under these headings:

**`### Fetch instructions`** — One paragraph per source. Use imperative voice:
- What to do: "Set version=null", "Parse `<h2>` elements as version boundaries", "No filtering needed"
- What to expect: cadence, content quality, whether rendering is needed
- When to skip or deprioritize: "Only fetch when looking for launch announcements specifically"
- Cite version format examples where useful (e.g., "semver like 2.1.98")

**`### Traps`** — Concise warnings with **bolded trigger labels**:
- Each trap is a bullet with a bold label and a one-sentence explanation
- Example: `**Doubled paths on Platform**: Relative doc links get prefixed with the source URL, producing doubled paths.`
- Include disabled sources with "Don't re-discover" warnings so agents don't re-evaluate them
- Only include traps that would cause wasted work or bad data — skip informational notes

**`### Coverage`** — Two or three sentences max:
- Which sources are canonical vs supplementary
- Whether active sources cover the org's full release surface
- Any known gaps worth noting

**`### Release cadence`** — Call out rollup publishers explicitly. Some orgs don't ship incremental changelog entries at all — they publish seasonal, quarterly, or annual **rollup** pages that collect many features into one banner post or microsite (e.g. Shopify Editions, Brex Fall Release, Ramp quarterly blog). When this is the case, say so in the notes and tell the parser to classify matching pages as `type: rollup`. Example:

> Ramp publishes quarterly rollups at `/blog/new-on-ramp-q*-*` and monthly editions at `/blog/new-on-ramp-*-edition`. Classify all entries from this source as `type: rollup` — individual features within a rollup are not separately indexed.

The `parsing-changelogs` skill ("Classifying Rollups" section) covers what rollups look like and when to set the `type` field. Your job in the playbook is to capture the org-specific signal so future fetches don't have to re-derive it from the page.

### Levels of playbook quality

**Compilation** (fast, from metadata only): Write notes based on source metadata — URL, type, priority, parseInstructions. Good for bulk coverage but claims about page structure, cadence, and version format are inferred, not verified. Suitable for initial scaffolding or low-priority orgs.

**Verified** (thorough, from actual data): Before writing, query release data and fetch logs to ground every claim in observation:

1. `releases list <slug> --json` — Check actual version formats, titles, content length, publishedAt patterns
2. `releases admin source fetch-log <slug> --json` — Check for errors, success rates, stale data
3. Analyze: calculate real cadence from dates, identify empty content or null fields, spot date drift
4. Write notes citing specific data points, not general assumptions

Use the verified approach for high-value orgs, when onboarding new orgs with scrape sources, or when refreshing stale compilation-only playbooks. The difference: "this source likely needs JS rendering" (compilation) vs "all 50 releases have empty content — the RSS feed delivers summaries only, needs crawl mode on per-release pages" (verified).

Write notes during onboarding after you've fetched and validated sources. Update them when you discover new quirks or when source behavior changes. If notes are empty or stale, write them before doing fetch work — future agents (including yourself in later sessions) will benefit.

**Updating notes:** Use `update_playbook_notes` with the complete notes content — it replaces the entire notes section. You can rewrite, reorganize, or clear notes at any time.

**Changing source configuration:** The header reflects current source metadata. To change things like `parseInstructions`, `fetchPriority`, or `crawlEnabled`, use `edit_source` with metadata — the header updates automatically.

**Product context:** Playbooks group sources by product when products are configured. Some sources (like an org's engineering blog) aren't tied to a specific product but may contain content relevant to any product under that org — the playbook calls these out as "Organization-Level Sources" with a note about which products they may cover.

## Rendering Control

The scrape adapter can fetch pages with or without a headless browser. Static-site providers (Docusaurus, VitePress, WordPress, Ghost, Mintlify) are fetched without rendering by default — this is ~10-30x faster.

To override the default for a specific source:
- `releases admin source edit <identifier> --no-render` — force fast fetch (no headless browser)
- `releases admin source edit <identifier> --render` — force headless browser rendering

Use `--render` when you know a source needs JavaScript execution. Use `--no-render` when you've verified the content is in the initial HTML for a provider not yet in the static list.

After adding a new scrape source with an unknown provider, check the first fetch results. If content is complete, consider setting `--no-render` and noting the provider behavior in the playbook.

## Duplicate Detection

Before adding sources, search for overlapping URLs.

Common duplicates:
- Same repo via GitHub URL vs changelog page (the GitHub source is usually better)
- RSS feed URL vs the page it feeds from (keep the feed)
- With and without trailing slash or `www.` prefix
