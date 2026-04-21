---
name: maintaining-orgs
description: >
  Routine maintenance of indexed organizations — fetch all sources, regenerate
  overviews, verify data quality. Use when asked to "update", "refresh", or
  "maintain" one or more orgs, or when doing periodic sweeps of the registry.
---

# Maintaining Orgs

Keep indexed organizations current by fetching their sources and regenerating overviews. Driven from Claude Code using the installed `releases` CLI against the production API. Two pieces compose:

1. **Fetch** — pull every active source so the database reflects what's been published. CLI does the work; no AI required.
2. **Regenerate overview** — re-derive the org's AI summary from the freshened release set. AI work; runs through the **`regenerating-overviews`** skill (which carries the prompt + workflow).

There is intentionally **no single-command "refresh in one step"** today. Compose the two pieces below.

## When to Use

- Periodic maintenance: "update the top 10 orgs"
- Before analysis: ensure data is fresh before competitive intel or trend work
- After onboarding: first full fetch + overview for a newly added org
- Spot checks: "is Stripe up to date?"

## Single Org Update

Two steps:

```bash
# 1. Fetch active sources (skips fetchPriority=paused)
releases admin source fetch --org <slug>

# 2. Regenerate the overview by invoking the regenerating-overviews skill.
#    See that skill for the workflow; the inputs and write commands are:
releases admin overview-inputs <slug> --json
# … generate markdown locally per skill prompt …
releases admin overview-write <slug> --content-file /tmp/<slug>-overview.md
```

For orgs with `scrape` or `agent` sources, skim the playbook before fetching — it documents source-specific quirks that may affect `--max` or require crawl flags:

```bash
releases admin playbook <slug>
```

Skip this for orgs with only `feed` and `github` sources. Check source types with `releases admin org show <slug>`.

### Useful flags on `admin source fetch`

- `--max <n>` — per-source release cap (default 200)
- `--concurrency <n>` — parallel fetches (default 3)
- `--dry-run` — preview without fetching
- `--org <slug>` — fetch all active sources for the org
- `--stale` / `--changed` / `--retry-errors` — narrow scope

### Verifying the result

After regen, `releases admin overview <slug>` prints the new content with metadata. If `selected: []` came back from `overview-inputs`, no overview is written — that's usually a signal that the fetch missed (try `--max` higher) or all sources are paused.

## Batch Updates

When updating multiple orgs, use parallel Claude Code sub-agents (one per org). Each agent runs the two-step flow above for its target.

### Selecting targets

Pick orgs by activity level. Good candidates for routine maintenance:

- **High-value orgs** with many sources (Vercel, Stripe, Cloudflare, Anthropic, GitHub)
- **Recently active orgs** — check `recentReleaseCount` in `releases admin org list --json`
- **Orgs not recently fetched** — sources with stale `lastFetchedAt`

Previously completed in this project: Anthropic, OpenAI, Vercel, Cloudflare, GitHub, Stripe, Supabase, Sentry, Clerk, Prisma, Datadog, Docker, Expo, Linear, Neon.

### Dispatching agents

Use the Agent tool with `run_in_background: true` and `model: "sonnet"` for each org. Send all agent calls in a single message for maximum parallelism.

Each agent prompt should include:

1. That the `releases` CLI is installed and configured with an admin API key
2. The org slug
3. Instructions to run the fetch + regen-overview flow (referencing the `regenerating-overviews` skill for the AI step)
4. Instructions to report back concisely: sources fetched, new releases, overview status

Example prompt template:

```
You are operating the Released CLI (`releases`) — a hosted changelog registry client.
The CLI is installed and authenticated against the production API.

Your task: refresh **{Org Name}** (slug: `{slug}`).

Steps:
  1. (Optional) For scrape/agent sources, check the playbook:
     releases admin playbook {slug} 2>/dev/null
  2. Fetch active sources:
     releases admin source fetch --org {slug} --json
  3. Regenerate the overview by following the `regenerating-overviews` skill —
     this means calling overview-inputs, generating markdown using the skill's
     prompt, then overview-write.

Report back: sources fetched, new releases found, overview status. Keep it concise.
```

### Tracking results

After all agents complete, compile a summary table:

| Org | Sources | New Releases | Overview |
| --- | ------- | ------------ | -------- |

This gives a quick audit of what changed and whether any orgs need attention.

## Composing With Other Skills

- **`regenerating-overviews`** — the AI prompt + workflow for the overview step. Required reading for any sub-agent doing the second step above.
- **`parsing-changelogs`** — what `admin source fetch` does under the hood. Useful when fetches misbehave.
- **`managing-sources`** — for adding, hiding, or pausing sources before a refresh.
