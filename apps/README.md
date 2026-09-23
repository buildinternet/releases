# apps

Deployable applications.

| Directory    | Package                     | What it is                                          | Deploy target                              | Wiring                     |
| ------------ | --------------------------- | --------------------------------------------------- | ------------------------------------------ | -------------------------- |
| `web/`       | `releases-web`              | Next.js frontend — public registry UI + account     | `releases.sh` (Vercel)                     | Root workspace             |
| `api/`       | `releases-api`              | REST API, Hono + D1, cron/Workflow ingest           | `api.releases.sh` (Cloudflare Worker)      | Root workspace             |
| `mcp/`       | `releases-mcp-worker`       | Remote MCP server, scope-enforced AI tool surface   | `agents.releases.sh` (Cloudflare Worker)   | Carved out, own `bun.lock` |
| `discovery/` | `releases-discovery-worker` | Onboarding-only source-discovery harness entrypoint | Internal Cloudflare Worker, no public host | Carved out, own `bun.lock` |
| `webhooks/`  | `releases-webhooks`         | Queue consumer for webhook + Slack/email fan-out    | Internal Cloudflare Worker, no public host | Carved out, own `bun.lock` |

`mcp/`, `discovery/`, and `webhooks/` are excluded from the root workspace on
purpose — see [AGENTS.md → Workspaces and carved-out
packages](../AGENTS.md#workspaces-and-carved-out-packages).

## Dev commands

From the repo root (see `package.json` for the full list):

```bash
bun run dev:web         # Next.js dev server (portless)
bun run dev:api         # wrangler dev for the API worker (portless)
bun run dev:mcp         # wrangler dev for the MCP worker (portless)
bun run dev:discovery   # wrangler dev for the discovery worker (portless)
```

Shared code lives in [`packages/`](../packages/README.md).
