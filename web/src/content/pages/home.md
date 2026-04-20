---
title: "releases.sh"
description: "An agent-friendly API for product changelogs."
canonical: "https://releases.sh/"
---

# releases.sh

An agent-friendly API for product changelogs. A unified registry of product releases, available via CLI, API, or MCP.

## By the numbers

- **Organizations tracked:** {{stats.orgs}}
- **Sources indexed:** {{stats.sources}}
- **Releases cataloged:** {{stats.releases}}

## Top organizations

{{orgs}}

## Independent projects

{{independentSources}}

## Get started

- **CLI:** `brew install buildinternet/tap/releases`
- **Remote MCP:** add `https://mcp.releases.sh` to your agent's MCP config
- **REST API:** `curl https://api.releases.sh/v1/orgs`

See [/docs](https://releases.sh/docs) for the full reference.
