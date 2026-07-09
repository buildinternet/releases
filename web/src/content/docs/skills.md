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

### creating-releases-json

Triggers when you want to **list your own product** — "add a releases.json", "get indexed on releases.sh", "make us a manifest for our website." Discovers real publish locations, models products without over-fragmenting, writes a valid v2 manifest, and guides publishing to `/.well-known/releases.json`.

Install just this skill (or grab the copy buttons on the [submit page](/submit)):

```bash
npx skills add https://github.com/buildinternet/releases --skill creating-releases-json
```

See [Listing your product](/docs/listing) for the format and the paste-ready agent prompt.

## Operator skills

Skills for people running or maintaining the registry itself — onboarding sources (`finding-changelogs`, `managing-sources`), the parse pipeline (`parsing-changelogs`, `classify-media-relevance`), and bulk maintenance (`seeding-playbooks` and friends) — live with the backend in the [releases monorepo](https://github.com/buildinternet/releases) under `.claude/skills/`. They're picked up automatically by Claude Code in a checkout, or installable anywhere:

```bash
npx skills add buildinternet/releases
```

Most need an admin API key to do anything.

## Source

- **Reader skills** (search, MCP, analysis): [github.com/buildinternet/releases-cli](https://github.com/buildinternet/releases-cli) under `skills/`.
- **Operator skills**: [github.com/buildinternet/releases](https://github.com/buildinternet/releases) under `.claude/skills/`.
- **Owner manifest skill** (`creating-releases-json`): [github.com/buildinternet/releases](https://github.com/buildinternet/releases) under `skills/creating-releases-json/`. Repo page grouping lives in root [`skills.sh.json`](https://github.com/buildinternet/releases/blob/main/skills.sh.json) ([skills.sh customize](https://www.skills.sh/docs/customize)).
