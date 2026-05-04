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

> **On-demand orgs** (`discovery = 'on_demand'`) are hidden stubs materialized by the on-demand lookup endpoint. They get embeddings and cron fetches but no overviews or summarization. The `releases admin overview plan` / `overview list` endpoints already filter to curated orgs server-side via the `organizations_active` view, so manifest-driven sweeps don't need a separate filter pass. To promote an on-demand org to curated, use `releases admin org update <slug> --discovery curated`.

## Single Org Update

Two steps:

```bash
# 1. Fetch active sources (skips fetchPriority=paused)
releases admin source fetch --org <slug>

# 2. Regenerate the overview by invoking the regenerating-overviews skill.
#    See that skill for the workflow; the inputs and update commands are:
releases admin overview inputs <slug> --json
# … generate markdown locally per skill prompt …
releases admin overview update <slug> --content-file /tmp/<slug>-overview.md
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

After regen, `releases admin overview get <slug>` prints the new content with metadata. If `selected: []` came back from `overview inputs`, no overview is written — that's usually a signal that the fetch missed (try `--max` higher) or all sources are paused.

## Batch Updates

When updating multiple orgs, use parallel Claude Code sub-agents (one per org). Each agent runs the two-step flow above for its target.

### Selecting targets

Pick orgs by activity level or overview freshness.

**Finding orgs with missing or stale overviews.** One call returns a planning-ready manifest:

```bash
releases admin overview plan --stale-days 14 --missing --has-activity --json
```

Each row carries the freshness signals an orchestrator needs:

- `staleness`: `"missing"` (no overview), `"behind"` (overview exists but `releasesSinceOverview > 0`), `"fresh"`
- `releasesSinceOverview` — the real outdated signal; a 30-day-old overview with zero new releases isn't actually stale
- `action` (plan-mode only): `"missing" | "refresh" | "skip"`
- `needsFetch` (plan-mode only): true when the org has active sources but the most recent release is more than 7 days old — orchestrator should run `admin source fetch --org <slug>` first
- `recentReleaseCount`, `orgLastActivity`, `overviewUpdatedAt` for sorting / triage

Filter knobs:

- `--stale-days <n>` — include `behind` rows whose overview is at least N days old
- `--missing` — include rows with no overview at all
- `--has-activity` — drop orgs with zero recent releases (avoid regen on dormant orgs)

For the lighter payload without `action` / `needsFetch`, use `releases admin overview list --stale-days <n> --missing --has-activity --json`.

**Pre-flight per-org.** Before dispatching a regen sub-agent, confirm there's something worth feeding the model without paying for the full release-content + media payload:

```bash
releases admin overview inputs <slug> --check --json
# → { orgSlug, selected, totalAvailable, hasExistingContent, wouldRegenerate, windowDays }
```

Skip dispatch when `wouldRegenerate: false`.

### Dispatching agents

Use the Agent tool with `run_in_background: true` and `model: "sonnet"` for each org. Send all agent calls in a single message for maximum parallelism.

**Have agents return markdown inline, not upload it.** Dispatched sub-agents commonly get their `Write` and `Bash` denied against `/tmp`, which breaks the write-file-then-`overview update` handoff. Shape the prompt so the agent returns generated markdown in its final report; the parent session writes the file and uploads. This also keeps the failure surface in one place — if an agent bails, the parent falls back to generating in-session from `overview inputs`.

Prompt template:

```
Regenerate the AI overview for the `{slug}` org in the Releases registry.
The `releases` CLI is installed and authenticated against production.
Invoke the `regenerating-overviews` skill for the prompt and workflow.

  1. (If scrape/agent sources) skim `releases admin playbook {slug}`.
  2. `releases admin source fetch --org {slug} --json --wait 600` if needed.
     If exit code != 0, STOP and report the error verbatim — do not generate
     from older data.
  3. `releases admin overview inputs {slug} --json`. If `selected` is empty,
     stop and report "empty-window".
  4. Generate the markdown inline per the skill.

Output rules — these are not negotiable:
  - 250 words target. 300 words is the HARD CEILING. Strip until it fits.
  - No markdown headings (`#`, `##`, …). The UI renders the org header.
  - Return ONLY the markdown inside a fenced code block. No preamble, no
    word-count notes, no "Here you go", no commentary after.

Acceptable shape (for reference — do not copy verbatim):

~~~markdown
**Vercel** focused on AI Gateway GA and Cache Components in the last 90 days.

**AI Gateway shipped GA** with bring-your-own-key, request caching, and per-
project budget caps. Pricing tiers are now metered per million tokens; the
free tier covers experimentation but not production traffic. Vercel SDK 6.0
removes the legacy `experimental_streamText` export — `streamText` is the
canonical API.

**Cache Components became stable** in Next.js 16. `use cache` directives now
participate in PPR, and `unstable_cache` is deprecated in favor of
`cacheTag` / `cacheLife`. The migration codemod handles ~80% of call sites.
~~~

Return in your final message:
  - Slug, Selected/Total
  - Status: generated | empty-window | fetch-error
  - The generated markdown in a fenced code block (required when generated).

Do not attempt to upload. The parent session handles writes.
```

### Tracking results

After agents complete, the parent harvests each returned code block, writes `/tmp/<slug>-overview.md`, and runs `releases admin overview update` in parallel (idempotent, last write wins). For any agent that bailed without content, re-fetch `overview inputs` locally and generate inline.

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
