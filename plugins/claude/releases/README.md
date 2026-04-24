# Releases Plugin for Claude Code

Search changelogs, track releases, and manage changelog sources with the [Releases.sh](https://releases.sh) registry.

## What's Included

- **MCP Server** — Connects Claude Code to the Releases.sh changelog registry
- **Skills** — Operator playbooks bundled from `src/agent/skills/`: `finding-changelogs`, `managing-sources`, `parsing-changelogs`, `grouping-releases`, `analyzing-releases`, `maintaining-orgs`, `classify-media-relevance`, and `seeding-playbooks`
- **Agents** — `discovery` (finds and onboards sources) and `worker` (executes fetch operations)
- **Commands** — `/releases` for manual changelog queries

## Installation

```bash
claude plugin add /path/to/releases/plugins/claude/releases
```

### Skills only (no plugin)

To use just the auto-triggering skills in another agent (Claude Code, Codex, Cursor, OpenCode), install the standalone skills package via the [`skills`](https://github.com/vercel-labs/skills) CLI:

```bash
npx skills add buildinternet/releases-cli
```

This skips the MCP connection, agents, and `/releases` command that the full plugin registers.

## Available MCP Tools

### search

Unified search across organizations, the catalog (products + standalone sources), and release content. Pass `type: ("orgs"|"catalog"|"releases")[]` to narrow which sections to return and skip expensive paths; pass `entity` (product slug / `prod_` id or source slug / `src_` id) to scope release results. Hybrid retrieval (FTS5 + semantic vectors via RRF) by default; falls back to lexical and flags `degraded` when Vectorize is unavailable.

### list_catalog

List catalog entries — products and standalone sources folded into one list with a `kind: "product"|"source"` discriminator per row. Scope with an optional `organization` filter.

### get_catalog_entry

Detail for a single catalog entry. Accepts a product identifier (slug or `prod_` id) or a source identifier (slug or `src_` id); dispatches on entity type and returns the appropriate detail shape.

### get_latest_releases

Get the most recent releases, optionally filtered by product, organization, or release `type`.

### get_release

Fetch the full content of a single release by id. Accepts a `rel_` prefix or a bare nanoid.

### get_source_changelog

Return the canonical `CHANGELOG.md` (or `CHANGES`/`HISTORY`/`RELEASES`/`NEWS`) stored for a GitHub source. The file is refreshed on every fetch. Supports heading-aligned slicing by chars (`offset` + `limit`) or tokens (`tokens`, cl100k_base). Every response includes `totalTokens` for budget planning; token-mode calls also return `sliceTokens`. Chain successive calls via the returned `nextOffset` to page through large files without blowing out the context window. Recommended token brackets: 2000 / 5000 / 10000 / 20000.

### list_organizations

List all indexed organizations, with optional search.

### get_organization

Get detailed information about a single organization. Includes a short preview of the AI-generated overview when one exists, with a stale warning if it's older than 30 days.

### get_organization_overview

Read the full AI-generated overview for an organization — a short briefing that distills recent changelog activity into themed sections.

### summarize_changes

AI-generated summary of recent changes for a product.

### compare_products

Compare recent release activity between two products.

### Deprecated shims

One release cycle: `search_releases`, `search_registry`, `list_sources`, `get_source`, `list_products`, `get_product`. Their titles are suffixed `(deprecated)` and descriptions point at the replacement above.

## Usage Examples

The plugin works automatically when you ask about releases:

- "What changed in Next.js 15?"
- "Show me the latest Tailwind releases"
- "Compare Bun vs Deno release activity"

For manual lookups:

```
/releases next.js
/releases tailwind v4 breaking changes
/releases --compare bun deno
```

For source management, spawn the agents:

```
Use the discovery agent to onboard Stripe as a changelog source
Use the worker agent to fetch all Vercel sources
```

## Skill Sync

Plugin skill copies are maintained by hand alongside their source of truth in `src/agent/skills/`. When you edit a skill, update both files in the same PR; there is no sync script (the previous `scripts/sync-plugin-skills.ts` was removed when local mode was killed). See `docs/architecture/agents.md` for the full skill ownership matrix.
