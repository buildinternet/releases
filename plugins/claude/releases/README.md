# Release Notes Index plugin

Search changelogs and look up releases in the [Release Notes Index](https://releases.sh) from inside your coding agent.

The plugin is one folder (`plugins/claude/releases`) in the common agent-plugin layout: `.claude-plugin/plugin.json` is the manifest, `.mcp.json` declares the hosted MCP server, and `commands/` and `skills/` are discovered by layout. Any agent that reads this layout can install it; the sections below cover the marketplaces it is listed in. Agents without plugin support can still use the hosted MCP server or the standalone skills (see the end of this page).

## Install

Pick your agent. The same folder serves every listing, so skills and commands are identical everywhere.

### Claude Code

Add the marketplace once, then install the plugin:

```bash
/plugin marketplace add buildinternet/releases
/plugin install releases@releases
```

### Updates

The plugin has no pinned version, so every change merged to `main` counts as an update. Claude Code doesn't auto-update third-party marketplaces by default. To pick up new skills and commands:

- Turn on auto-update: `/plugin` → **Marketplaces** → `releases` → enable auto-update.
- Or update by hand. First refresh the marketplace listing with `/plugin marketplace update releases`. Then update the installed plugin with `claude plugin update releases@releases --scope user`, using the scope you installed with (`user`, `project` or `local`). Restart Claude Code to load the new version.

For local development against a cloned copy:

```bash
claude --plugin-dir <path-to-releases-cli-clone>/plugins/claude/releases
```

### Grok Build

This plugin is submitted to the [xAI plugin marketplace](https://github.com/xai-org/plugin-marketplace) as `release-notes-index`. Once listed, run `/plugin` in Grok Build, search for **Release Notes Index**, and install it. The marketplace pins a commit of this repo, so updates arrive when the catalog entry is bumped.

## What you get

Everything you need to ask your agent about release notes and changelogs.

- **Hosted MCP connection** to `agents.releases.sh` — search, lookup, and changelog slicing tools.
- **`/releases <product> [query]`** for manual lookups.
- **Auto-triggering skills:**
  - `releases-mcp` — activates on questions about releases, changelogs, breaking changes, or version updates ("what's new in Next.js 15?").
  - `releases-cli` — activates when a user mentions or runs the `releases` CLI.
  - `analyzing-releases` — competitive intel across multiple companies.

Try it after install:

```text
What changed in Next.js 15?
Show me the latest Tailwind releases.
Compare Bun vs Deno release activity.
```

Or run the command directly:

```text
/releases next.js
/releases tailwind v4 breaking changes
```

## License

MIT, same as the rest of this repository.

## Data and network access

The plugin ships no hooks, scripts, or binaries and runs nothing on your machine. It reaches two Release Notes Index services:

- **`agents.releases.sh`**: the hosted MCP server behind the search and lookup tools. It receives your search queries and lookup requests. Signing in is optional; it is only needed to follow products or manage webhooks, and happens through your MCP client's own OAuth flow.
- **`api.releases.sh`**: the REST API used by the optional `releases` CLI. The `releases-cli` skill only sends requests here if you install the CLI and your agent runs it. The skill describes how to install the CLI from npm or Homebrew; the plugin itself never downloads or executes anything.

Search queries are kept for 90 days to improve search. See the [privacy policy](https://releases.sh/privacy) for details.

## Standalone skills (any agent)

If you want only the skill behaviour in another agent — no MCP connection, no command — install the bundled skills directly via the [`skills`](https://github.com/vercel-labs/skills) CLI from the open agent-skills ecosystem:

```bash
releases skills install                       # requires the `releases` CLI
npx skills add buildinternet/releases         # equivalent, no CLI required
```

Skills are symlinked by default; re-running the install refreshes everything atomically.

## Looking for the operator surface?

Source onboarding, parse-pipeline debugging, and bulk maintenance are maintainer workflows that live with the backend in the [releases monorepo](https://github.com/buildinternet/releases) — its `.claude/skills/` tree is the canonical home for those skills and is picked up automatically by Claude Code in a checkout. (The former `releases-admin` plugin bundled snapshots of them here; those copies drifted and have been retired.)
