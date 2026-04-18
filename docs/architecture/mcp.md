# Remote MCP Server

The MCP Worker (`workers/mcp/`) exposes a remote MCP server at `mcp.releases.sh` using Cloudflare's `createMcpHandler` with Streamable HTTP transport. It provides read-only tools across three surfaces — search (`search_releases`, `get_latest_releases`, `get_release`), registry detail (`list_sources`, `get_source`, `get_source_changelog`, `list_organizations`, `get_organization`, `list_products`, `get_product`), and AI analysis (`summarize_changes`, `compare_products`, gated behind `ENABLE_AI_TOOLS=true`). No authentication required — all read tools are public.

The worker binds to the same D1 database as the API and discovery workers. AI tools (`summarize_changes`, `compare_products`) use an `ANTHROPIC_API_KEY` from the secrets store. Like the discovery worker, `workers/mcp/` is excluded from root `workspaces` to avoid import conflicts.

Deploy: `bun run deploy:mcp`. Dev: `bun run dev:mcp`. Connect from Claude Desktop: `npx mcp-remote https://mcp.releases.sh/mcp`.

## Parity with WebMCP

The web app also exposes a browser-side subset of these tools via `navigator.modelContext.registerTool()` — see `web/src/components/webmcp-provider.tsx`. Today that surface mirrors `search_releases`, `list_organizations`, `get_organization`, `get_source`, `get_release` plus an `open_search_page` nav helper, all pointed at the public API. When you add, rename, or change the signature of a read-only tool in `workers/mcp/src/tools.ts` (or the local stdio server in `src/mcp/`), update the WebMCP provider in the same PR so the three surfaces don't drift. Write/admin tools stay out of WebMCP — browser-side callers can't present an API key safely.

## MCP Registry listing

The server is registered as `sh.releases/mcp` in the official MCP Registry via HTTP-domain auth against `releases.sh` (proof file lives at `web/public/.well-known/mcp-registry-auth`). Metadata is in `workers/mcp/server.json` — bump `version` when you want to publish an update. The `Deploy Workers` GitHub Action runs `mcp-publisher publish` automatically on merges that touch `server.json` (gated on the `MCP_REGISTRY_PRIVATE_KEY_PEM` repo secret). Manual publish: `bun run publish:mcp-registry` after `mcp-publisher login http --domain releases.sh --private-key <hex>`.
