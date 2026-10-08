---
name: releases-mcp
description: Use when the user asks about recent releases, changelogs, what's new in a library, breaking changes, version updates, or wants to compare products. Activates for questions like "what changed in Next.js 15?", "latest Tailwind releases", "compare Bun vs Deno releases".
---

# Release Notes Index — Changelog Lookup

When the user asks about releases, changelogs, or version updates, use the Releases Index MCP tools to fetch current data instead of relying on training data. Training data is stale for fast-moving libraries; these tools read the live registry.

## When to Use This Skill

Activate when the user:

- Asks what's new or changed in a library/product ("What changed in Next.js 15?")
- Wants recent releases or changelogs ("Show me the latest Tailwind releases")
- Asks about breaking changes or migration ("Were there breaking changes in Prisma 6?")
- Wants to compare release activity between products ("Compare Bun vs Deno releases")
- Mentions version updates, release notes, or changelogs for a specific product
- Asks about a curated topic feed ("what's new across the AI labs?")

## The Tools

The hosted server exposes these tools. There is no AI summarization or comparison tool — you synthesize those yourself from the data below.

- `search` — unified search across four sections: orgs, catalog (products + standalone sources), collections, and releases. Your default entry point.
- `get_latest_releases` — recent releases, optionally scoped by `organization` or `product`. Use `since` / `until` for time windows.
- `list_organizations` / `get_organization` — browse and inspect orgs.
- `list_catalog` / `get_catalog_entry` — browse and inspect catalog entries. Each entry carries `entryType: "product" | "source"`. `get_catalog_entry` also serves CHANGELOG slices (see below).
- `get_release` — fetch one release in full by its `rel_` id (ids come from `search` / `get_latest_releases`).
- `list_collections` / `get_collection` / `get_collection_releases` — curated cross-org "playlists" (e.g. "Frontier AI Labs", "Coding Agents") independent of the category taxonomy.
- `lookup_domain` — resolve a URL/domain to the org that owns it. Use when you have a URL-shaped input rather than a name.
- `whats_changed` (**beta**) — the changelog entries between two versions of a package: `whats_changed(package, from, to)` returns the releases in `(from, to]` with summaries, breaking-change verdicts, and migration notes. Use it to plan an upgrade instead of reading many changelog pages. `package` is a tracked source slug or a GitHub `owner/repo`. No sign-in needed.

The server also exposes **signed-in account tools**. They act on the user's own account, need an authenticated connection (a "Sign in with Releases" OAuth token or a `relu_` user API key), and return an error for anonymous clients. The reader tools above need no auth.

- `follow` / `unfollow` / `list_follows` and `get_personalized_feed` — the user's follows and their feed. Reach for these only when the user asks about *their* follows or feed. For general "what's new in X" questions, the reader tools answer without sign-in.
- `list_webhooks` (read-only) and `manage_webhook` (`create` / `update` / `delete` / `test` / `rotate_secret`) — the user's release webhooks. Pass `workspace` (an id or slug) to work on a shared workspace's webhooks instead; `list_webhooks` with no `workspace` also lists the user's workspaces. Workspace owners and admins can change workspace webhooks; members can list and test them. Workspace webhooks target one org (no follows scope). `create` needs `format` (`json`, `slack`, or `discord`). A `json` webhook's signing key is shown only once, on create or rotate — tell the user to store it right away. Slack and Discord webhooks have no signing key. Only create, change, or delete a webhook when the user asks for it.

## How to Look Up Releases

### Step 1: Resolve the entity

Start with `search` and the product or company name — it returns orgs, catalog, collections, and releases in one call, so you usually don't need a separate lookup. Narrow with `type` (e.g. `type: ["catalog"]` for a fast registry-only lookup, `type: ["releases"]` for pure release content).

If a name doesn't resolve, try variations:

- The company instead of the product ("Vercel" rather than "Next.js")
- The GitHub org ("supabase")
- A domain — or use `lookup_domain` directly (e.g. "tailwindcss.com")
- A `{org}/{repo}` GitHub coordinate ("vercel/next.js"). When nothing matches a coordinate-shaped query, the registry probes GitHub on demand and the response carries a `lookup` field with status `indexed` / `existing` / `empty` / `not_found` / `deferred`. Coordinate matching is case-insensitive.

### Step 2: Pick the right follow-up

- **"What's new?" / "Latest releases"** → `get_latest_releases` with `organization` or `product`. Add `since` (e.g. `"30d"`, `"6m"`, or an ISO date) for "last month" / "since v4" style asks.
- **Keyword across the whole registry** → `search` with a descriptive query; narrow with `type`.
- **One release in full** (to quote a note verbatim) → `get_release` with the `rel_` id from search results.
- **Entity metadata** → `get_catalog_entry` (products/sources) or `get_organization` (orgs, with an AI overview preview; `include_overview: true` for the full briefing).
- **Full maintained CHANGELOG.md** → `get_catalog_entry` with `include_changelog: true`. This only applies to **source** entries that track a checked-in CHANGELOG.md — products and tag-only repos (e.g. Next.js, which ships GitHub releases but no CHANGELOG file) return none. For large files, pass `changelog_tokens` (recommended brackets: 2000 / 5000 / 10000 / 20000) to get a heading-aligned slice, then chain via the returned `nextOffset`. Every response reports `totalTokens` so you can budget calls upfront.
- **A curated topic feed** → `list_collections` to discover, `get_collection_releases` for the interleaved cross-org feed.

### Step 3: Compare products (no built-in tool)

There is no `compare_products` or `summarize_changes` tool on the hosted server. To compare, fetch each product separately (`get_catalog_entry` for metadata, `get_latest_releases` for recent activity) and synthesize the comparison yourself. Both products must be indexed — if one isn't found, say which is missing rather than guessing.

### Step 4: Present results

- Lead with what answers the user's question.
- Include version numbers and dates when available.
- Quote key changes from the release notes (keep quotes short).
- If results are sparse, say the product may not be fully indexed yet — don't fabricate release info.

## Guidelines

- Pass the user's full question into query parameters for better relevance.
- For time windows, use `since` / `until` on `get_latest_releases` and `search` (relative shorthand like `"90d"` or ISO dates).
- The `kind` filter (`platform|sdk|mobile|desktop|docs|integration|tool`) behaves differently by surface: on **release** results a source inherits its parent product's kind, so `kind: "sdk"` returns content under any SDK product; on **catalog** results it matches the row's own kind only. Reach for it when a query is explicitly scoped to one kind ("which SDKs shipped this week").
- If a product isn't found, say so clearly — don't invent releases.
