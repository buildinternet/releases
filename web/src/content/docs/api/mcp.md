---
title: "MCP Server"
description: "Use Releases as an MCP tool server from Claude, Cursor, and other agents."
adminOnly: false
---

# MCP Server

Use Releases as an AI agent tool server via the Model Context Protocol.

## Pair with agent skills

One-line setup so your agent reaches for these tools on its own. See the [skills page](/docs/skills) for the full list.

<!-- slot:skills-install -->

## Remote server (recommended)

Connect to the hosted MCP server at `https://mcp.releases.sh/mcp`. No installation or API keys required — all tools are read-only and public.

## Setup instructions

### General

The hosted MCP server supports Streamable HTTP at:

```text
https://mcp.releases.sh/mcp
```

Use that URL directly in clients with native remote MCP support. For clients that only support stdio MCP servers, use `mcp-remote` as a compatibility bridge.

### One-click install

Click to install in a supported editor. The deeplink opens the app and prompts you to confirm before adding the server.

<!-- slot:mcp-install-buttons -->

### Claude Code

```bash
claude mcp add --transport http releases https://mcp.releases.sh/mcp
```

### Codex

```bash
codex mcp add releases --url https://mcp.releases.sh/mcp
```

### VS Code, Windsurf, Zed, and others

For clients without native remote MCP support, use `mcp-remote`:

```json
{
  "mcpServers": {
    "releases": {
      "command": "npx",
      "args": ["-y", "mcp-remote", "https://mcp.releases.sh/mcp"]
    }
  }
}
```

<!-- admin:start -->

## Local server

Run a local MCP server over stdio with the full tool set, including admin tools for adding sources, fetching releases, and managing organizations:

```bash
releases admin mcp serve
```

```json
{
  "mcpServers": {
    "releases": {
      "command": "releases",
      "args": ["admin", "mcp", "serve"]
    }
  }
}
```

<!-- admin:end -->

## Available tools

### Read tools

Read-only tools available on the remote server with no authentication.

> **Identifiers:** every tool that takes an org / product / source identifier accepts the typed ID (`org_…`, `prod_…`, `src_…`) interchangeably with the slug. Source and product params also accept an `org/slug` coordinate (e.g. `vercel/nextjs`). Releases are addressed by id only — `get_release` takes a `rel_…` id or a bare 21-char nanoid, with no slug form. Each tool's `inputSchema.description` lists the concrete shapes it accepts.

| Tool                       | Description                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| -------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `search`                   | Unified search across orgs, catalog (products + standalone sources), and release content. Accepts `type: ("orgs" \| "catalog" \| "releases")[]` to skip sections; `mode: "lexical" \| "semantic" \| "hybrid"` (default `hybrid`) for release retrieval; `entity` to scope releases; `since` / `until` to bound release hits by publish date (ISO or `90d`/`4w`/`6m`/`2y`). Release hits carry a `kind: "release" \| "changelog_chunk"` discriminator; chunk hits include `chunkOffset` and `chunkLength` so you can chain into `get_catalog_entry` with changelog slicing params for surrounding context. |
| `list_catalog`             | Products and standalone sources folded into one list, each row tagged with an `entryType: "product" \| "source"` discriminator.                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| `get_catalog_entry`        | Detail for a single catalog entry — product or source. Accepts slug or `prod_` / `src_` id. Source entries list tracked CHANGELOG files (path + byte size) by default. Pass `include_changelog: true` to inline the root CHANGELOG, or `changelog_path` / `changelog_offset` / `changelog_limit` / `changelog_tokens` to target a specific file or slice. Heading-aligned slicing supports monorepo per-package files; token-mode responses include `totalTokens` and `sliceTokens` for LLM budgeting (brackets: 2000/5000/10000/20000).                                                                  |
| `get_latest_releases`      | Get the most recent releases, optionally filtered by product, organization, release `type`, or a `since` / `until` publish-date window (ISO or `90d`/`4w`/`6m`/`2y`).                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| `get_release`              | Fetch the full content of a single release by id. Accepts a `rel_` prefix or a bare nanoid.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| `list_organizations`       | List all organizations, searchable by name, slug, domain, or account handle.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| `get_organization`         | Detailed view of a single organization including accounts, tags, sources, products, and domain aliases. Shows a preview of the AI-generated overview by default; pass `include_overview: true` to inline the full briefing (with a stale warning if it's older than 30 days).                                                                                                                                                                                                                                                                                                                             |
| `search_releases` _(dep.)_ | Deprecated shim — prefer `search` with `type: ["releases"]`. Same hybrid-retrieval shape kept for one release cycle.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| `search_registry` _(dep.)_ | Deprecated shim — prefer `search` with `type: ["orgs", "catalog"]`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| `list_sources` _(dep.)_    | Deprecated — prefer `list_catalog`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| `list_products` _(dep.)_   | Deprecated — prefer `list_catalog`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| `get_product` _(dep.)_     | Deprecated — prefer `get_catalog_entry`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |

### On-demand GitHub lookup

`search` and `search_releases` fall back to an on-demand GitHub lookup when the query is a `{org}/{repo}` coordinate and the in-index search returns no hits. The result is merged under a `lookup` field in the tool response so the agent can see the repo state without a second tool call.

| Field        | Description                                                                                                                                                                                            |
| ------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `status`     | `indexed` (newly materialized), `existing` (already tracked), `empty` (real repo, no releases or CHANGELOG yet), `not_found` (no public repo), or `deferred` (GitHub rate-limit or 5xx — try shortly). |
| `source`     | Source record for the materialized or existing repo. Present on `indexed`, `existing`, and `empty`.                                                                                                    |
| `releases`   | Inline release preview. Present on `indexed` and `existing`.                                                                                                                                           |
| `relatedOrg` | "Did you mean" rail — set when the org segment matches a known org but the specific repo doesn't. Lists the org and up to 5 sibling sources.                                                           |

`lookup` is `null` when the query is not coordinate-shaped or when existing search hits were found. Materialized rows are hidden (`discovery: "on_demand"`); a second search for the same coordinate resolves through the normal cache path. Embeddings still run for on-demand sources, so semantic search picks them up on the second hit; AI features (overviews, summarization, playbook regen) skip them.

<!-- admin:start -->

### Analysis tools

AI-generated summaries and comparisons. Available on the remote server with no authentication.

| Tool                | Description                                                                                                         |
| ------------------- | ------------------------------------------------------------------------------------------------------------------- |
| `summarize_changes` | AI-generated summary of recent releases for a product. Supports custom lookback window and additional instructions. |
| `compare_products`  | Head-to-head AI comparison of releases between two products.                                                        |

### Source management tools

Only available on the local server.

| Tool               | Description                                 |
| ------------------ | ------------------------------------------- |
| `add_source`       | Add a new changelog source from a URL.      |
| `remove_source`    | Remove a source from the index.             |
| `fetch_source`     | Fetch new releases from a source.           |
| `add_organization` | Create a new organization.                  |
| `link_account`     | Link a platform account to an organization. |

### Curation tools

Only available on the local server.

| Tool                 | Description                             |
| -------------------- | --------------------------------------- |
| `suppress_release`   | Hide a release from queries and search. |
| `unsuppress_release` | Restore a suppressed release.           |
| `ignore_url`         | Add a URL to an org's ignore list.      |
| `unignore_url`       | Remove a URL from the ignore list.      |
| `list_ignored_urls`  | List ignored URLs for an organization.  |
| `block_url`          | Globally block a URL pattern.           |
| `unblock_url`        | Remove a global URL block.              |
| `list_blocked_urls`  | List all globally blocked URLs.         |

<!-- admin:end -->

## Example usage

Once configured, you can ask Claude to interact with the release index directly:

- "What did Vercel ship last week?"
- "Search for breaking changes in the Prisma changelog"
- "Compare Next.js and Remix releases from the last 30 days"
- "Summarize Cloudflare's recent releases, focusing on Workers"
