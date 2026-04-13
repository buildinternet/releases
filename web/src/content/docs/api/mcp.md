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

## Local server

Run a local MCP server over stdio with the full tool set, including admin tools for adding sources, fetching releases, and managing organizations:

```bash
releases serve
```

```json
{
  "mcpServers": {
    "releases": {
      "command": "releases",
      "args": ["serve"]
    }
  }
}
```

## Available tools

### Read tools

Available on both the remote and local servers.

| Tool | Description |
| --- | --- |
| `search_releases` | Full-text search across all indexed release notes. Supports filtering by product slug or organization. |
| `get_latest_releases` | Get the most recent releases, optionally filtered by product or organization. |
| `list_products` | List all changelog sources (products) in the index. |
| `list_organizations` | List all organizations, searchable by name, slug, domain, or account handle. |
| `get_organization` | Detailed view of a single organization including accounts, tags, sources, products, and domain aliases. |

### Analysis tools

Available on both the remote and local servers. AI-generated summaries and comparisons.

| Tool | Description |
| --- | --- |
| `summarize_changes` | AI-generated summary of recent releases for a product. Supports custom lookback window and additional instructions. |
| `compare_products` | Head-to-head AI comparison of releases between two products. |

### Source management tools

Only available on the local server.

| Tool | Description |
| --- | --- |
| `add_source` | Add a new changelog source from a URL. |
| `remove_source` | Remove a source from the index. |
| `fetch_source` | Fetch new releases from a source. |
| `add_organization` | Create a new organization. |
| `link_account` | Link a platform account to an organization. |

### Curation tools

Only available on the local server.

| Tool | Description |
| --- | --- |
| `suppress_release` | Hide a release from queries and search. |
| `unsuppress_release` | Restore a suppressed release. |
| `ignore_url` | Add a URL to an org's ignore list. |
| `unignore_url` | Remove a URL from the ignore list. |
| `list_ignored_urls` | List ignored URLs for an organization. |
| `block_url` | Globally block a URL pattern. |
| `unblock_url` | Remove a global URL block. |
| `list_blocked_urls` | List all globally blocked URLs. |

## Example usage with Claude

Once configured, you can ask Claude to interact with the release index directly:

- "What did Vercel ship last week?"
- "Search for breaking changes in the Prisma changelog"
- "Compare Next.js and Remix releases from the last 30 days"
- "Summarize Cloudflare's recent releases, focusing on Workers"
