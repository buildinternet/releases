---
title: "Skills"
description: "Install Releases skills — auto-triggering playbooks that teach Claude Code, Codex, Cursor, and OpenCode how to use the CLI and MCP tools."
adminOnly: false
---

# Skills

Skills are short, auto-triggering playbooks that teach an AI agent how to use Releases. When you ask a release-shaped question, your agent loads the matching skill and follows it.

They work in Claude Code, Codex, Cursor, OpenCode, and any other agent that supports the [agent skills format](https://agentskills.io/home).

## Install

### Standalone (any agent)

Run this from the root of any project where you want the skills, using the [`skills`](https://skills.sh) CLI:

```bash
npx skills add buildinternet/releases-cli
```

Your agent picks them up on the next session.

### Claude Code plugin

If you're on Claude Code and also want the bundled MCP connection and `/releases` command:

```bash
/plugin marketplace add buildinternet/releases-cli
```

```bash
/plugin install releases@releases
```

## What the skills do

### releases-mcp

Triggers when you ask about a library or product release — "what changed in Next.js 15?", "latest Tailwind releases", "compare Bun vs Deno." Your agent answers from current registry data instead of stale training data.

### releases-cli

Triggers when you mention the `releases` CLI or run a `releases` command. Helps your agent pick the right subcommand and flags.

### analyzing-releases

Triggers on competitive-intelligence asks — "what is X shipping lately", "how does X compare to Y", "what's new in observability." Picks a cohort, fetches recent releases, and summarizes themes.

### finding-changelogs

Triggers when you point an agent at a product URL and ask "where's their changelog?". Looks for feeds, known providers, and common paths before falling back to scraping.

## Operator skills

The bundle also ships skills for people running their own ingest — `managing-sources`, `parsing-changelogs`, `classify-media-relevance`, `seeding-playbooks`. They stay inert unless an operator-shaped task triggers them.

## Source

The skill files live in the open-source CLI repo: [github.com/buildinternet/releases-cli](https://github.com/buildinternet/releases-cli) under `skills/`.
