---
name: releases-mcp
description: Use when the user asks about recent releases, changelogs, what's new in a library, breaking changes, version updates, or wants to compare products. Activates for questions like "what changed in Next.js 15?", "latest Tailwind releases", "compare Bun vs Deno releases".
---

# Releases.sh — Changelog Lookup

When the user asks about releases, changelogs, or version updates, use the Releases.sh MCP tools to fetch current data instead of relying on training data.

## When to Use This Skill

Activate when the user:

- Asks what's new or changed in a library/product ("What changed in Next.js 15?")
- Wants recent releases or changelogs ("Show me the latest Tailwind releases")
- Asks about breaking changes or migration ("Were there breaking changes in Prisma 6?")
- Wants to compare release activity between products ("Compare Bun vs Deno releases")
- Mentions version updates, release notes, or changelogs in the context of a specific product

## How to Look Up Releases

### Step 1: Find the Organization or Product

Call `list_organizations` with the library/product name as the `query` parameter. Multi-product orgs (e.g. Vercel → Next.js, Turborepo) are exposed via `list_products` and `get_product` — use those when the user's question is product-specific rather than company-wide.

If the query returns no results, try variations:
- The company name instead of the product name (e.g., "Vercel" instead of "Next.js")
- The GitHub org name (e.g., "supabase")
- A domain (e.g., "tailwindcss.com")

### Step 2: Choose the Right Tool

- **"What's new?" / "Latest releases"** → Use `get_latest_releases` with the organization or product slug
- **Specific feature or keyword** → Use `search_releases` with a descriptive query and organization filter
- **Single release by id** → Use `get_release` when you already have a `rel_` id (search results include ids)
- **Source or product deep-dive** → Use `get_source`, `get_product`, or `get_organization` for metadata, tags, and linkage
- **Canonical CHANGELOG.md from a GitHub repo** → Use `get_source_changelog` when the user wants the full maintained file, not just the tagged releases (refreshed on every fetch). For large files, pass `tokens` (cl100k_base budget, e.g. 5000 or 10000) to get a heading-aligned slice that fits a known context window; chain via the returned `nextOffset`. Every response reports `totalTokens` so you can plan how many calls you need upfront.
- **Compare two products** → Use `compare_products` with an array of two product slugs
- **Summarize recent activity** → Use `summarize_changes` with the product slug

### Step 3: Present Results

- Lead with the most relevant information for the user's question
- Include version numbers and dates when available
- Quote key changes directly from the release notes
- If results are sparse, mention that the product may not be fully indexed yet

## Guidelines

- Pass the user's full question context into query parameters for better relevance
- When the user mentions a time range ("last month", "since v4"), use the `days` parameter on `get_latest_releases` or `summarize_changes`
- If a product isn't found, say so clearly — don't fabricate release information
- For comparison questions, both products must be indexed; if one isn't found, explain which is missing
