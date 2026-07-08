# Releases MCP worker

Remote MCP server at `mcp.releases.sh` — serves the AI tool surface (search, catalog, follows, whats-changed) with scope-enforced auth (scoped API tokens, user API keys, OAuth JWTs).

## Layout

- `index.ts` — worker entrypoint / routing
- `mcp-agent.ts` — MCP agent definition, tool registration
- `tools.ts` — core tool surface (search, catalog, lookups)
- `follows-tools.ts` — follows/feed tools
- `whats-changed-tool.ts` — `whats_changed` tool
- `auth.ts` — token/JWT verification, scope enforcement
- `rate-limit.ts` — per-tier rate limiting
- `resources.ts` — MCP resources
- `well-known.ts` — `.well-known` handlers
- `slug-completion.ts` — slug autocomplete helper
- `landing.ts` — landing/info page
- `prompts.ts` — MCP prompts
- `ui-bundles.ts` — MCP App UI bundle serving
- `db.ts` — D1 query helpers
- `scope-error.ts` — scope-enforcement error type
- `stubs/` — type stubs for the carved-out workspace

This workspace is intentionally excluded from the root Bun workspace and root oxlint; it type-checks separately via `npx tsc --noEmit` (see repo root `AGENTS.md`).

## Deploy

Deployed as `releases-mcp` (prod) / `releases-mcp-staging` (staging):

```bash
bunx wrangler deploy --config workers/mcp/wrangler.jsonc
bunx wrangler deploy --env staging --config workers/mcp/wrangler.jsonc
```

Local dev: `bun run dev:mcp` (served via portless at `https://mcp.releases.localhost`).

## Docs

- [../../docs/architecture/mcp.md](../../docs/architecture/mcp.md) — remote MCP server, scope enforcement, WebMCP parity, MCP Registry listing
- [../../docs/architecture/remote-mode.md](../../docs/architecture/remote-mode.md) — D1, auth model, rate limiting, OAuth
