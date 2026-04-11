---
description: Look up changelogs and release notes
argument-hint: <product> [query]
---

# /releases

Search changelogs and release notes from the Releases.sh registry.

## Usage

```
/releases <product> [query]
/releases --compare <product1> <product2>
```

- **product**: A product name, org name, or slug (e.g., "next.js", "tailwind", "vercel")
- **query**: What you're looking for (optional but recommended for targeted results)
- **--compare**: Compare recent release activity between two products

## Examples

```
/releases next.js
/releases tailwind v4 breaking changes
/releases prisma migration guide
/releases --compare bun deno
/releases vercel last 7 days
```

## How It Works

1. Searches `list_organizations` to resolve the product name to a known org or product
2. If a query is provided, uses `search_releases` filtered to that org
3. If no query, uses `get_latest_releases` to show the most recent entries
4. With `--compare`, uses `compare_products` on both product slugs
5. Results include version numbers, dates, and key changes from release notes
