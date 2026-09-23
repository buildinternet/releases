# apps

Deployable applications.

| Directory   | Package               | What it is                                        | Deploy target                              | Wiring                     |
| ----------- | --------------------- | ------------------------------------------------- | ------------------------------------------ | -------------------------- |
| `web/`      | `releases-web`        | Next.js frontend — public registry UI + account   | `releases.sh` (Vercel)                     | Root workspace             |
| `api/`      | `releases-api`        | REST API, Hono + D1, cron/Workflow ingest         | `api.releases.sh` (Cloudflare Worker)      | Root workspace             |
| `mcp/`      | `releases-mcp-worker` | Remote MCP server, scope-enforced AI tool surface | `agents.releases.sh` (Cloudflare Worker)   | Carved out, own `bun.lock` |
| `webhooks/` | `releases-webhooks`   | Queue consumer for webhook + Slack/email fan-out  | Internal Cloudflare Worker, no public host | Root workspace             |

`mcp/` is excluded from the root workspace on purpose — see [AGENTS.md → Workspaces and carved-out
packages](../AGENTS.md#workspaces-and-carved-out-packages).

## Dev commands

From the repo root (see `package.json` for the full list):

```bash
bun run dev:web         # Next.js dev server (portless)
bun run dev:api         # wrangler dev for the API worker (portless)
bun run dev:mcp         # wrangler dev for the MCP worker (portless)
```

Shared code lives in [`packages/`](../packages/README.md).
