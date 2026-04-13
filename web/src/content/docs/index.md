---
title: "Documentation"
adminOnly: false
---

# Releases

Changelog index for AI agents and developers.

Releases tracks release notes, changelogs, and version updates across hundreds of developer tools, frameworks, and services. It provides a CLI, REST API, and MCP server for querying structured release data.

## What you can do

- **Browse and search** — find releases across organizations and sources by keyword, category, or date
- **Track changes** — fetch the latest releases from GitHub repos, RSS feeds, and changelog pages
- **AI summaries** — generate natural-language summaries and comparisons of release activity
- **Integrate** — use the REST API for programmatic access or the MCP server for AI agent workflows

## Concepts

Releases organizes data in a simple hierarchy:

- **Organizations** — companies or teams (e.g., Vercel, Cloudflare)
- **Products** — optional grouping within an org (e.g., Vercel → Next.js, Turborepo)
- **Sources** — individual changelog feeds (e.g., a GitHub repo, an RSS feed, a changelog page)
- **Releases** — individual entries with a title, version, date, and content

Each source has a `slug` that uniquely identifies it and is used as the primary argument across CLI commands and API endpoints.

## Interfaces

| Interface | Best for |
| --- | --- |
| **CLI** | Interactive exploration, fetching, analysis |
| **REST API** | Programmatic access, web integrations |
| **MCP Server** | AI agent tool use (Claude, Cursor, etc.) |
| **Web UI** | Browsing the catalog at [releases.sh](https://releases.sh) |
