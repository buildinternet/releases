---
title: "Documentation"
description: "Overview of Releases — a changelog index with a CLI, REST API, MCP server, and agent skills."
adminOnly: false
---

# Releases

Changelog index for AI agents and developers.

Releases tracks release notes, changelogs, and version updates across hundreds of developer tools, frameworks, and services. You can query it four ways: a CLI, a REST API, an MCP server, and agent skills that trigger on their own.

For the motivations behind the project, see [Why](/docs/why).

New here? [Install the CLI](/docs/installation), [add the skills](/docs/skills) to your agent, or jump to [Examples](/docs/examples).

## What you can do

- **Browse and search** — find releases across organizations and sources by keyword, category, or date
- **Track changes** — follow the latest releases from GitHub repos, RSS feeds, and changelog pages
- **Integrate** — query the [REST API](/docs/api/rest) directly, plug the [MCP server](/docs/api/mcp) into your agent, or install the [skills](/docs/skills) so Claude Code, Codex, Cursor, and OpenCode know how to use it

## Concepts

Releases organizes data in a simple hierarchy:

- **Organizations** — companies or teams (e.g., Vercel, Cloudflare)
- **Products** — optional grouping within an org (e.g., Vercel → Next.js, Turborepo)
- **Sources** — individual changelog feeds (e.g., a GitHub repo, an RSS feed, a changelog page)
- **Releases** — individual entries with a title, version, date, and content

Each source has a `slug`, a short unique name. Most CLI commands and API endpoints take that slug as their main argument.

## Interfaces

| Interface                       | Best for                                                           |
| ------------------------------- | ------------------------------------------------------------------ |
| **[CLI](/docs/cli/browsing)**   | Interactive exploration, fetching, analysis                        |
| **[REST API](/docs/api/rest)**  | Programmatic access, web integrations                              |
| **[MCP Server](/docs/api/mcp)** | AI agent tool use (Claude, Cursor, etc.)                           |
| **[Skills](/docs/skills)**      | Auto-triggering playbooks for Claude Code, Codex, Cursor, OpenCode |
| **Web UI**                      | Browsing the catalog at [releases.sh](https://releases.sh)         |

The CLI is open source — see [github.com/buildinternet/releases-cli](https://github.com/buildinternet/releases-cli).

Maintained by [Zach Dunn](https://zachdunn.com) / [Build Internet](https://buildinternet.com).
