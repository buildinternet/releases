---
name: managing-sources
description: How to add, remove, list, validate, and manage changelog sources — covers ignored/blocked URLs, duplicate detection, and the validation workflow
---

# Managing Sources

Operational guide for managing changelog sources.

## Listing Sources

Use `list_sources` with optional filters:
- `query` — filter by name, slug, or URL
- `organization` — filter by org slug
- `product` — filter by product slug
- `category` — filter by category
- `has_feed` — only sources with a discovered feed URL

All tool responses return structured JSON data.

## Adding Sources

Use `add_source` with:
- `name` (required) — display name
- `url` (required) — changelog URL
- `type` (optional) — github, scrape, feed, or agent (auto-detected from URL if omitted)
- `organization` (optional) — org slug to associate with
- `feed_url` (optional) — direct feed URL if known

### Organization descriptions

When creating an org with `manage_org` action "add", include a description with a brief one-sentence product description. This grounds AI summaries for lesser-known products.

## Removing Sources

Use `remove_source` with the slug. When removing discovery results, also use `exclude_url` with action "ignore" to prevent re-discovery.

## Ignored URLs (org-scoped)

A URL ignored for one org can still be valid for another org. Use `exclude_url` with action "ignore", the URL, and the organization slug.

## Blocked URLs (global)

For spam domains and known-bad URLs. Use `exclude_url` with action "block" and the URL. Set `block_type` to "domain" to block an entire domain.

## Validation Workflow

After adding a source, validate it:

1. **Add the source** with `add_source`
2. **Fetch** with `fetch_source` to trigger a fetch
3. **Check results** with `get_latest_releases` — do they have titles, dates, content?
4. **If bad:** `remove_source` the slug and `exclude_url` to ignore it
5. **If good:** The source is ready for production fetches

## Primary Sources

An org can have one source marked as its **primary changelog** — the main, company-wide changelog. Use `edit_source` with `is_primary: true` to mark it.

When onboarding an org, if you find a single top-level changelog alongside product-specific or GitHub sources, mark the top-level one as primary.

## Duplicate Detection

Before adding sources, use `list_sources` with a query to check for overlapping URLs.

Common duplicates:
- Same repo via GitHub URL vs changelog page (the GitHub source is usually better)
- RSS feed URL vs the page it feeds from (keep the feed)
- With and without trailing slash or `www.` prefix
