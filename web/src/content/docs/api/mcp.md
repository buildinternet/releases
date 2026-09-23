---
title: "MCP Server"
description: "Use Releases Index as an MCP tool server from Claude, Cursor, and other agents."
adminOnly: false
---

# MCP Server

Use Releases Index as an AI agent tool server via the Model Context Protocol.

## Pair with agent skills

One-line setup so your agent reaches for these tools on its own. See the [skills page](/docs/skills) for the full list.

<!-- slot:skills-install -->

## Remote server (recommended)

Connect to the hosted MCP server at `https://agents.releases.sh/mcp`. No installation or API keys required — all tools are read-only and public. `https://mcp.releases.sh/mcp` continues to work as an alias.

## Setup instructions

### General

The hosted MCP server supports Streamable HTTP at:

```text
https://agents.releases.sh/mcp
```

Use that URL directly in clients with native remote MCP support. For clients that only support stdio MCP servers, use `mcp-remote` as a compatibility bridge.

### One-click install

Click to install in a supported editor. The deeplink opens the app and prompts you to confirm before adding the server.

<!-- slot:mcp-install-buttons -->

### Claude Code

```bash
claude mcp add --transport http releases https://agents.releases.sh/mcp
```

### Codex

```bash
codex mcp add releases --url https://agents.releases.sh/mcp
```

### VS Code, Windsurf, Zed, and others

For clients without native remote MCP support, use `mcp-remote`:

```json
{
  "mcpServers": {
    "releases": {
      "command": "npx",
      "args": ["-y", "mcp-remote", "https://agents.releases.sh/mcp"]
    }
  }
}
```

<!-- admin:start -->

## Local server

Run a local MCP server over stdio, proxying the same registry data as the hosted server through your own `releases` CLI install:

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

The local server’s tool set is a smaller, read-only subset of the hosted one (see the table below for exactly which tools it carries) plus one tool the hosted server doesn’t have: `changelog`, which reads releases.sh’s own product updates. It does not add source-management, curation, or other admin/write tools — those don’t exist as MCP tools on either server today. Manage sources and curation from the `releases` CLI directly (`releases admin source …`, `releases admin org …`) instead.

<!-- admin:end -->

## Available tools

> **Identifiers:** every tool that takes an org / product / source identifier accepts the typed ID (`org_…`, `prod_…`, `src_…`) interchangeably with the slug. Source and product params also accept an `org/slug` coordinate (e.g. `vercel/nextjs`). Releases are addressed by id only — `get_release` takes a `rel_…` id or a bare 21-char nanoid, with no slug form. Each tool's `inputSchema.description` lists the concrete shapes it accepts.

### Read tools

Public — no authentication needed on the remote server. “Server” says where each tool lives: **remote** is the hosted server at `agents.releases.sh`; **local** is `releases admin mcp serve`; **both** means the same tool name exists on each, though the local version is a smaller proxy (see each row for what it drops).

| Tool                      | Server | Description                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| ------------------------- | ------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `search`                  | both   | Unified search across orgs, catalog (products + standalone sources), curated collections (cross-org playlists), and release content. Accepts `type: ("orgs" \| "catalog" \| "releases" \| "collections")[]` to skip sections; `mode: "lexical" \| "semantic" \| "hybrid"` (default `hybrid`) for release retrieval; `entity` to scope releases; `since` / `until` to bound release hits by publish date (ISO or `90d`/`4w`/`6m`/`2y`). Collection hits surface via a direct name/description match or a member rollup (carrying the result-set org slugs that triggered it). Release hits carry a `kind: "release" \| "changelog_chunk"` discriminator; chunk hits include `chunkOffset` and `chunkLength` so you can chain into `get_catalog_entry` with changelog slicing params for surrounding context. The local server's version is the same idea, proxied through the REST API, but its `type` filter only covers `orgs`/`catalog`/`releases` (no `collections`), and it has no `domain`/`entity`/`kind`/`since`/`until`/`minImportance` params. |
| `list_catalog`            | both   | Products and standalone sources folded into one list, each row tagged with an `entryType: "product" \| "source"` discriminator.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| `get_catalog_entry`       | both   | Detail for a single catalog entry — product or source. Accepts slug or `prod_` / `src_` id. Source entries list tracked CHANGELOG files (path + byte size) by default. Pass `include_changelog: true` to inline the root CHANGELOG, or `changelog_path` / `changelog_offset` / `changelog_limit` / `changelog_tokens` to target a specific file or slice. Heading-aligned slicing supports monorepo per-package files; token-mode responses include `totalTokens` and `sliceTokens` for LLM budgeting (brackets: 2000/5000/10000/20000). Both servers support this the same way.                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| `get_latest_releases`     | both   | Get the most recent releases, optionally filtered by product, organization, release `type`, source/product `kind`, a `since` / `until` publish-date window (ISO or `90d`/`4w`/`6m`/`2y`), or a `minImportance` (1–5 AI-scored) floor. Excludes prereleases by default. Cursor-paginated (`limit`, `cursor`). The local server's version only takes `product` and `organization`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| `list_organizations`      | both   | List all organizations, searchable by name, slug, domain, or account handle. Orgs with zero indexed releases are hidden by default; the local server adds `include_empty: true` to show them.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| `get_organization`        | both   | Detailed view of a single organization including accounts, tags, sources, products, and domain aliases. On the remote server this shows a preview of the AI-generated overview by default; pass `include_overview: true` to inline the full briefing (with a stale warning if it's older than 30 days). The local server always renders a plain summary and has no overview option.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| `lookup_domain`           | remote | Resolve a URL-shaped domain to the org or product that owns it. Normalizes scheme/`www.`/path first, so `https://vercel.com/about` and `vercel.com` match the same row. Pure lookup — never probes or materializes anything.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| `list_collections`        | remote | List curated collections — named cross-org playlists (e.g. "Frontier AI Labs") independent of the category taxonomy. Paginated, 50 per page.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| `get_collection`          | remote | Detail for one collection — name, description, and its ordered member organizations. Hidden/on-demand orgs never appear in the list.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| `get_collection_releases` | remote | Interleaved cross-org release feed for a collection — same shape as `get_latest_releases`, scoped to the collection's member orgs. Cursor-paginated.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| `get_release`             | remote | Fetch the full content of a single release by id. Accepts a `rel_` prefix or a bare nanoid.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| `whats_changed`           | remote | **Beta — subject to change.** Changelog entries between two versions of a package: `whats_changed(package, from, to, ecosystem?)` returns the releases in the range `(from, to]` (`from` exclusive, `to` inclusive) with summaries, breaking-change verdicts, and migration notes — one call instead of reading many changelog pages to plan an upgrade. `package` is a tracked source slug or a GitHub `owner/repo` coordinate (set `ecosystem: "github"` for a bare coordinate). An untracked package returns a clear "not tracked" answer (npm/PyPI names aren't all mapped to a source yet). Public — no sign-in needed, despite living next to the account tools below.                                                                                                                                                                                                                                                                                                                                                                            |
| `get_source`              | local  | Local-only. Detail for a single changelog source by slug or id — a narrower, source-only precursor to `get_catalog_entry`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| `changelog`               | local  | Local-only. Reads releases.sh's own product changelog (platform and CLI updates) — unrelated to any indexed org's releases. Same content as `releases changelog`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |

### Your account tools

These act on **your own account** — following, your personalized feed, and your outbound webhooks — not the shared registry. Remote server only (`agents.releases.sh`); the local server doesn't have them. They need a signed-in identity: a user API key (`relu_…`, from `releases login` or Account → API Keys) or a "Sign in with Releases" OAuth access token, sent as a Bearer credential. An anonymous, machine (`relk_…`), or root credential gets a clear error instead of a call — there's no catalog `write` scope requirement, so a read-only `relu_` key can still manage its own follows and webhooks.

| Tool                    | Description                                                                                                                                                                                                                                                                                                          |
| ----------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `follow`                | Follow an org or product so it appears in `get_personalized_feed`. Following an org implicitly includes all of its products. Takes an `org_…` / `prod_…` id (from `search` or `get_*` results). Idempotent.                                                                                                          |
| `unfollow`              | Stop following an org or product. Same id shape as `follow`. Idempotent.                                                                                                                                                                                                                                             |
| `list_follows`          | List the orgs and products you follow, newest first.                                                                                                                                                                                                                                                                 |
| `get_personalized_feed` | Your personalized release feed — recent releases from everything you follow, newest first. Same item shape as `get_latest_releases`. Cursor-paginated.                                                                                                                                                               |
| `list_webhooks`         | List your outbound `release.created` webhooks. Pass an optional `workspace` (id or slug) to list a workspace's webhooks instead of your personal ones; omitting it also appends a short list of your workspaces so you can find an id to pass next. Pass `id` to see one webhook plus its 10 most recent deliveries. |
| `manage_webhook`        | Create, update, delete, test, or rotate the signing key of a webhook, personal or workspace, behind one `action` enum (`create` / `update` / `delete` / `test` / `rotate_secret`). `create` needs `url` and `format` (`json`, `slack`, or `discord`).                                                                |

**Webhooks in more detail:**

- **Personal vs. workspace:** omit `workspace` for your own webhooks (`scope: "follows"` — everything you follow — or org-scoped). Pass a workspace id or slug to manage that workspace's webhooks instead; workspace webhooks are always org-scoped (`scope: "follows"` is personal-only and is rejected if you pass `workspace` with it).
- **Who can do what in a workspace:** owners and admins can create, update, delete, and rotate a workspace's webhooks. Any member can list them and run `test` on one, even without manage rights.
- **`format` is required on `create`** — pick `json`, `slack`, or `discord` up front; there's no default.
- **Signing keys are shown once.** A `json`-format webhook's signing key only ever appears in the `create` or `rotate_secret` response — save it immediately, since it isn't shown again.
- **Slack and Discord aren't signed.** Those two formats skip HMAC signing entirely, so `manage_webhook` never returns a signing key for them.

See the [Webhooks API docs](/docs/api/webhooks) for the underlying REST contract, retry behavior, and payload shape.

### On-demand GitHub lookup

`search` falls back to an on-demand GitHub lookup when the query is a `{org}/{repo}` coordinate and the in-index search returns no hits. The result is merged under a `lookup` field in the tool response so the agent can see the repo state without a second tool call.

| Field        | Description                                                                                                                                                                                            |
| ------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `status`     | `indexed` (newly materialized), `existing` (already tracked), `empty` (real repo, no releases or CHANGELOG yet), `not_found` (no public repo), or `deferred` (GitHub rate-limit or 5xx — try shortly). |
| `source`     | Source record for the materialized or existing repo. Present on `indexed`, `existing`, and `empty`.                                                                                                    |
| `releases`   | Inline release preview. Present on `indexed` and `existing`.                                                                                                                                           |
| `relatedOrg` | "Did you mean" rail — set when the org segment matches a known org but the specific repo doesn't. Lists the org and up to 5 sibling sources.                                                           |

`lookup` is `null` when the query is not coordinate-shaped or when existing search hits were found. Materialized rows are hidden (`discovery: "on_demand"`); a second search for the same coordinate resolves through the normal cache path. Embeddings still run for on-demand sources, so semantic search picks them up on the second hit; AI features (overviews, summarization, playbook regen) skip them.

## Example usage

Once configured, you can ask Claude to interact with the release index directly:

- "What did Vercel ship last week?"
- "Search for breaking changes in the Prisma changelog"
- "Compare Next.js and Remix releases from the last 30 days"
- "Summarize Cloudflare's recent releases, focusing on Workers"
