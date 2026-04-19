---
title: "MCP Server"
adminOnly: false
---

# MCP Server

Use Releases as an AI agent tool server via the Model Context Protocol.

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

| Tool                   | Description                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| ---------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `search_releases`      | Hybrid search across releases and heading-aligned CHANGELOG chunks. Accepts `mode: "lexical" \| "semantic" \| "hybrid"` (default `hybrid`) and filters by product slug, organization, or release `type`. Every hit carries a `kind: "release" \| "changelog_chunk"` discriminator; chunk hits include `chunkOffset` and `chunkLength` so you can chain into `get_source_changelog` for surrounding context.                                                                                                                            |
| `search_registry`      | Vector-backed search across orgs, products, and sources. Use this for entity lookup instead of `search_releases` when you want organization or product matches.                                                                                                                                                                                                                                                                                                                                                                        |
| `get_latest_releases`  | Get the most recent releases, optionally filtered by product, organization, or release `type`.                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| `get_release`          | Fetch the full content of a single release by id. Accepts a `rel_` prefix or a bare nanoid.                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| `list_sources`         | List all indexed changelog sources, optionally filtered to one organization.                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| `get_source`           | Detail for a single source with org/product linkage, release count, last-fetched timestamp, and whether a CHANGELOG file is stored.                                                                                                                                                                                                                                                                                                                                                                                                    |
| `get_source_changelog` | Read the canonical `CHANGELOG.md` tracked for a GitHub source, refreshed on every fetch. Supports heading-aligned slicing by chars (`offset` + `limit`) or by tokens (`tokens`, cl100k_base). Every response includes `totalTokens` for budget planning; token-mode responses also include `sliceTokens` for the returned chunk. Chain successive calls via `nextOffset` to page through large files (e.g. Apollo Client's 700KB CHANGELOG) without blowing out the context window. Recommended token brackets: 2000/5000/10000/20000. |
| `list_organizations`   | List all organizations, searchable by name, slug, domain, or account handle.                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| `get_organization`     | Detailed view of a single organization including accounts, tags, sources, products, and domain aliases.                                                                                                                                                                                                                                                                                                                                                                                                                                |
| `list_products`        | List products, optionally scoped to one organization.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| `get_product`          | Detail for a single product with its organization, category, tags, and the sources grouped under it.                                                                                                                                                                                                                                                                                                                                                                                                                                   |

### Analysis tools

AI-generated summaries and comparisons. Available on the remote server with no authentication.

| Tool                | Description                                                                                                         |
| ------------------- | ------------------------------------------------------------------------------------------------------------------- |
| `summarize_changes` | AI-generated summary of recent releases for a product. Supports custom lookback window and additional instructions. |
| `compare_products`  | Head-to-head AI comparison of releases between two products.                                                        |

<!-- admin:start -->

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

## Example usage with Claude

Once configured, you can ask Claude to interact with the release index directly:

- "What did Vercel ship last week?"
- "Search for breaking changes in the Prisma changelog"
- "Compare Next.js and Remix releases from the last 30 days"
- "Summarize Cloudflare's recent releases, focusing on Workers"
