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

Pick orgs by activity level or overview freshness.

**Finding orgs with missing or stale overviews.** No single command exposes this, but the CLI is composable. The snippet below writes each org's overview status to `/tmp/overview-status/`, then prints a sorted table:

```bash
mkdir -p /tmp/overview-status
releases admin org list --json | jq -r '.[].slug' \
  | xargs -n1 -P8 -I{} sh -c 'releases admin overview {} --json 2>/dev/null > /tmp/overview-status/{}.json'

for f in /tmp/overview-status/*.json; do
  slug="${f##*/}"; slug="${slug%.json}"
  jq -r --arg slug "$slug" 'if .content then "\($slug)\t\(.updatedAt // .generatedAt)" else "\($slug)\tNONE" end' "$f"
done | sort -t$'\t' -k2
```

`NONE` means no overview exists; anything older than **30 days** is stale per `OVERVIEW_STALE_DAYS` (`@buildinternet/releases-core/overview`).

**Other selection signals.** `releases admin org list --json` exposes:

- `recentReleaseCount` — recently active orgs with overviews not updated since last activity
- `lastActivity` — orgs inactive long enough that existing overview may be fine

### Dispatching agents

Use the Agent tool with `run_in_background: true` and `model: "sonnet"` for each org. Send all agent calls in a single message for maximum parallelism.

**Have agents return markdown inline, not upload it.** Dispatched sub-agents commonly get their `Write` and `Bash` denied against `/tmp`, which breaks the write-file-then-`overview-write` handoff. Shape the prompt so the agent returns generated markdown in its final report; the parent session writes the file and uploads. This also keeps the failure surface in one place — if an agent bails, the parent falls back to generating in-session from `overview-inputs`.

Prompt template:

````
Regenerate the AI overview for the `{slug}` org in the Releases registry.
The `releases` CLI is installed and authenticated against production.
Invoke the `regenerating-overviews` skill for the prompt and workflow.

  1. (If scrape/agent sources) skim `releases admin playbook {slug}`.
  2. `releases admin source fetch --org {slug} --json --wait 600` if needed.
     If exit code != 0, STOP and report the error verbatim — do not generate
     from older data.
  3. `releases admin overview-inputs {slug} --json`. If `selected` is empty,
     stop and report "empty-window".
  4. Generate the markdown inline per the skill.

Output rules — these are not negotiable:
  - 250 words target. 300 words is the HARD CEILING. Strip until it fits.
  - No markdown headings (`#`, `##`, …). The UI renders the org header.
  - Return ONLY the markdown inside a fenced code block. No preamble, no
    word-count notes, no "Here you go", no commentary after.

Acceptable shape (for reference — do not copy verbatim):

```markdown
**Vercel** focused on AI Gateway GA and Cache Components in the last 90 days.

**AI Gateway shipped GA** with bring-your-own-key, request caching, and per-
project budget caps. Pricing tiers are now metered per million tokens; the
free tier covers experimentation but not production traffic. Vercel SDK 6.0
removes the legacy `experimental_streamText` export — `streamText` is the
canonical API.

**Cache Components became stable** in Next.js 16. `use cache` directives now
participate in PPR, and `unstable_cache` is deprecated in favor of
`cacheTag` / `cacheLife`. The migration codemod handles ~80% of call sites.
```

Return in your final message:
  - Slug, Selected/Total
  - Status: generated | empty-window | fetch-error
  - The generated markdown in a fenced code block (required when generated).

Do not attempt to upload. The parent session handles writes.
````

### Tracking results

After agents complete, the parent harvests each returned code block, writes `/tmp/<slug>-overview.md`, and runs `releases admin overview-write` in parallel (idempotent, last write wins). For any agent that bailed without content, re-fetch `overview-inputs` locally and generate inline.

Summary table format:

| Org | Window | Selected/Total | Result                                |
| --- | ------ | -------------- | ------------------------------------- |
| …   | 90d    | 9/9            | regenerated (1.7k chars)              |
| …   | 90d    | 0/0            | skipped — no releases in window       |
| …   | 90d    | 14/14          | regenerated in-session (agent bailed) |

## Composing With Other Skills

- **`regenerating-overviews`** — the AI prompt + workflow for the overview step. Required reading for any sub-agent doing the second step above.
- **`parsing-changelogs`** — what `admin source fetch` does under the hood. Useful when fetches misbehave.
- **`managing-sources`** — for adding, hiding, or pausing sources before a refresh.
