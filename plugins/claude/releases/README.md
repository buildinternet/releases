# Releases Plugin for Claude Code

Search changelogs, track releases, and manage changelog sources with the [Releases.sh](https://releases.sh) registry.

## What's Included

- **MCP Server** — Connects Claude Code to the Releases.sh changelog registry
- **Skills** — Auto-triggers changelog lookups when you ask about releases or what's new
- **Agents** — `discovery` (finds and onboards sources) and `worker` (executes fetch operations)
- **Commands** — `/releases` for manual changelog queries

## Installation

```bash
claude plugin add /path/to/released/plugins/claude/releases
```

## Available MCP Tools

### search_releases
Full-text search across all indexed release notes.

### get_latest_releases
Get the most recent releases, optionally filtered by product or organization.

### list_sources
List all indexed changelog sources.

### list_organizations
List all indexed organizations, with optional search.

### get_organization
Get detailed information about a single organization.

### summarize_changes
AI-generated summary of recent changes for a product.

### compare_products
Compare recent release activity between two products.

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

Operational skills (finding-changelogs, managing-sources, etc.) are synced from `src/agent/skills/` — do not edit them directly in the plugin directory. Run the sync:

```bash
bun scripts/sync-plugin-skills.ts
```
