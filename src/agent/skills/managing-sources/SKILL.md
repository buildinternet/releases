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
| List sources | `releases list [slug] --json [--org <org>] [--query <text>] [--has-feed] [--category <c>]` | `list_sources` with query, organization, category, has_feed params |
| Add source | `releases add <name> --url <url> [--type <type>] [--org <org>] [--feed-url <url>]` | `add_source` with name, url, type, organization, feed_url params |
| Edit source | `releases edit <slug> [--primary] [--priority <p>]` | `edit_source` with slug, is_primary, fetch_priority params |
| Remove source | `releases remove <slug> [--ignore --reason <reason>]` | `remove_source` with slug param |
| Fetch releases | `releases fetch <slug> [--dry-run] [--max <n>]` | `fetch_source` with slug param |
| Get latest releases | `releases latest [slug] --json [--org <org>]` | `get_latest_releases` with source, organization, limit params |
| Search releases | `releases search <query> --json` | `search_releases` with query, limit params |
| Evaluate URL | `releases evaluate <url> --json` | `evaluate_url` with url param |
| Add org | `releases org add <name> [--domain <d>] [--description <t>] [--category <c>] [--tags <t1,t2>]` | `manage_org` action "add" with name, domain, description, category, tags |
| Edit org | `releases org edit <slug> [--category <c>]` | `manage_org` action "edit" with identifier, category |
| Show org | `releases org show <slug> --json` | `get_organization` with identifier |
| Add tags to org | `releases org tag add <slug> <tags...>` | `manage_org` action "tag_add" with identifier, tags |
| Link account | `releases org link <slug> --platform <p> --handle <h>` | `manage_org` action "link_account" with identifier, platform, handle |
| Add product | `releases product add <name> --org <org> [--category <c>] [--tags <t>]` | `manage_product` action "add" with name, organization, category, tags |
| Ignore URL | `releases ignore add --org <org> <url>` | `exclude_url` action "ignore" with url, organization |
| Block URL | `releases block add <url>` | `exclude_url` action "block" with url |
| List categories | `releases categories --json` | `list_categories` |

## Listing Sources

Search for existing sources with optional filters:
- **query** — filter by name, slug, or URL
- **organization** — filter by org slug
- **product** — filter by product slug
- **category** — filter by category
- **has_feed** — only sources with a discovered feed URL

Use `--json` (CLI) for structured output. Typed tools always return JSON.

## Adding Sources

Required: **name** and **url**. Optional: **type** (github, scrape, feed, agent — auto-detected from URL if omitted), **organization** (org slug to associate with), **feed_url** (direct feed URL if known).

### Organization descriptions

When creating an org, include a brief one-sentence product description. This grounds AI summaries for lesser-known products.

## Removing Sources

When removing discovery results, also ignore the URL to prevent re-discovery. In CLI: `releases remove <slug> --ignore --reason "..."`. With typed tools: call `remove_source` then `exclude_url` with action "ignore".

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

## Duplicate Detection

Before adding sources, search for overlapping URLs.

Common duplicates:
- Same repo via GitHub URL vs changelog page (the GitHub source is usually better)
- RSS feed URL vs the page it feeds from (keep the feed)
- With and without trailing slash or `www.` prefix
