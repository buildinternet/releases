---
name: maintaining-orgs
description: >
  Routine maintenance of indexed organizations — fetch all sources, regenerate
  overviews, verify data quality. Use when asked to "update", "refresh", or
  "maintain" one or more orgs, or when doing periodic sweeps of the registry.
  Local-only (Claude Code CLI against production API).
---

# Maintaining Orgs

Keep indexed organizations current by fetching their sources and regenerating overviews. This is a local-only workflow — run it from Claude Code with the `releases` CLI linked and remote mode active.

## When to Use

- Periodic maintenance: "update the top 10 orgs"
- Before analysis: ensure data is fresh before competitive intel or trend work
- After onboarding: first full fetch + overview for a newly added org
- Spot checks: "is Stripe up to date?"

## Single Org Update

The one-liner:

```bash
releases admin org refresh <slug>
```

This fetches every active source for the org (skipping `fetchPriority: paused`) and regenerates the AI overview in one step. It reports sources fetched, new releases, and overview status on completion.

### Useful flags

- `--max <n>` — per-source release cap (default 20)
- `--concurrency <n>` — parallel fetches (default 3)
- `--window <days>` — window for overview release selection (default 90)
- `--dry-run` — preview without fetching
- `--skip-overview` — fetch only, don't regenerate the overview
- `--json` — machine-readable output

### When to check the playbook first

For orgs with `scrape` or `agent` sources, skim the playbook before refreshing — it documents source-specific quirks that may affect `--max` or require crawl flags:

```bash
releases admin content playbook <slug>
```

Skip this for orgs with only `feed` and `github` sources. Check source types with `releases admin org show <slug>`.

### Verifying the result

`org refresh` logs a post-regen confirmation: `Overview regenerated (<chars> chars from <n> of <total> releases, window: <d>d)`. If no releases exist in the window, it warns and skips overview regeneration — this is usually a signal that `--max` was too low or all sources are paused.

## Lower-level building blocks

- `releases admin source fetch --org <slug>` — fetch all active sources for an org without regenerating the overview. Composes with `--stale`, `--changed`, `--retry-errors`, or a positional source slug to narrow scope.
- `releases admin org show <slug> --regenerate [--window <days>]` — regenerate the overview from whatever releases already exist, no fetching.

Use these when you want to decouple the fetch and regenerate steps — e.g., re-running overview generation with a tighter window after a fetch has already completed.

## Batch Updates

When updating multiple orgs, use parallel Claude Code sub-agents (one per org). Each agent runs `org refresh` for its target.

### Selecting targets

Pick orgs by activity level. Good candidates for routine maintenance:

- **High-value orgs** with many sources (Vercel, Stripe, Cloudflare, Anthropic, GitHub)
- **Recently active orgs** — check `recentReleaseCount` in `releases admin org list --json`
- **Orgs not recently fetched** — sources with stale `lastFetchedAt`

Previously completed in this project: Anthropic, OpenAI, Vercel, Cloudflare, GitHub, Stripe, Supabase, Sentry, Clerk, Prisma, Datadog, Docker, Expo, Linear, Neon.

### Dispatching agents

Use the Agent tool with `run_in_background: true` and `model: "sonnet"` for each org. Send all agent calls in a single message for maximum parallelism.

Each agent prompt should include:

1. The working directory (`/Users/zachdunn/Code/released`)
2. That `releases` is bun-linked and remote mode is active
3. The org slug
4. The `org refresh` command to run
5. Instructions to report back concisely: sources fetched, new releases, overview status

Example prompt template:

```
You are operating the Released CLI (`releases`) — a bun-linked changelog indexer.
Working directory: /Users/zachdunn/Code/released

Your task: refresh **{Org Name}** (slug: `{slug}`).

Run: releases admin org refresh {slug} --json

If the org has scrape or agent sources, first check the playbook:
  releases admin content playbook {slug} 2>/dev/null

Report back: sources fetched, new releases found, overview status
(from the JSON output). Keep it concise.
```

### Tracking results

After all agents complete, compile a summary table:

| Org | Sources | New Releases | Overview |
| --- | ------- | ------------ | -------- |

This gives a quick audit of what changed and whether any orgs need attention.
