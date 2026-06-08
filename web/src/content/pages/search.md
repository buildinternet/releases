---
title: "Search releases.sh"
description: "How to search the releases.sh registry programmatically via WebMCP, MCP, CLI, and the REST API."
---

# Search

The [/search](https://releases.sh/search) page is a browser form — fine for humans, but agents should query the index directly. Every search surface returns the same underlying data.

## WebMCP (browser agents)

When a user loads any releases.sh page, the site registers a `search` tool on `navigator.modelContext`. Browser-resident agents can call it without any authentication:

```js
const result = await navigator.modelContext.callTool("search", {
  query: "streaming",
  limit: 10,
});
```

Other read-only tools are exposed the same way: `list_organizations`, `get_organization`, `get_catalog_entry`, `get_release`, and `open_search_page` (navigates the current tab to the HTML results).

## Remote MCP server

Add `https://mcp.releases.sh` to your agent's MCP configuration and call `search` (or any other tool) through the MCP transport. See [/docs/api/mcp](/docs/api/mcp) for the full tool catalog.

## REST API

```sh
curl "https://api.releases.sh/v1/search?q=streaming&limit=10"
```

Supports `q`, `limit`, `type` (`feature` or `rollup`), and `mode` (`lexical`, `semantic`, `hybrid`). Hybrid is the default. See [/docs/api/rest](/docs/api/rest) for parameters and response shape.

## CLI

```sh
releases search "streaming"
releases search "streaming" --json   # machine-readable output
```

Install the CLI with `brew install buildinternet/tap/releases` or see [/docs/installation](/docs/installation).

## Tips

- Queries are case-insensitive and tokenized; phrase quoting is respected.
- `mode=semantic` uses embeddings and is best for conceptual queries ("image optimization", "auth flow changes").
- `mode=lexical` is best for exact model names, versions, or feature flags.
- Results include a `kind` discriminator: `release` (a full release) or `changelog_chunk` (a semantic slice from a longer changelog).
