---
name: maintaining-orgs
description: >
  Routine maintenance of indexed organizations — fetch all sources, regenerate
  overviews, verify data quality. Use when asked to "update", "refresh", or
  "maintain" one or more orgs, or when doing periodic sweeps of the registry.
---

<!-- AUTO-GENERATED: Do not edit directly. Source of truth is src/agent/skills/. Changes here will be overwritten by scripts/sync-plugin-skills.ts -->

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

Skip this for orgs with only `feed` and `github` sources. Check source types with `releases admin org get <slug>`.

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

**Always have agents return citations too.** `overview update` is replace-all on citations — if `--citations-file` is omitted, existing citations are CLEARED. Batch refreshes that skip citations silently strip every inline source link from the page. Require a citations JSON in the agent's return payload (even when model-asserted rather than Anthropic-emitted), then upload both with `--content-file` and `--citations-file`. The two existing-content sub-agents that wrote `/tmp/<slug>-overview-citations.json` proved this works in practice.

Prompt template:

```
Regenerate the AI overview for the `{slug}` org in the Releases registry.
The `releases` CLI is installed and authenticated against production.
Read the `regenerating-overviews` skill for the full prompt; the style rules
below are the load-bearing subset and override anything else.

  1. (If scrape/agent sources) skim `releases admin playbook {slug}`.
  2. `releases admin source fetch --org {slug} --json --wait 600` if needed.
     If exit code != 0, STOP and report the error verbatim — do not generate
     from older data.
  3. `releases admin overview inputs {slug} --json`. If `selected` is empty,
     stop and report "empty-window". Use the URLs in `selected[*].url` as
     the citation source set — do not invent URLs.
  4. Generate the markdown and a citations array per the rules below.

Style rules — these are not negotiable; the parent lints for violations:
  - HARD: do NOT open with the org's own name as the sentence subject.
    The page header already shows the org name. Bad: "Apify's SDK shipped…",
    "Tinybird shipped multi-region…", "pnpm's biggest release…". Good:
    "Recently shipped X" or naming a product ("Nuxt Agent launched…").
    Product names containing the org name ("Linear Agent", "Cloudflare
    Workers") are fine — the rule targets bare org-as-subject openers.
  - HARD: opening sentence ≤25 words. Count and trim.
  - HARD: bold-tease section headers describe the user-facing claim, NOT
    the version or endpoint. Bad: "**3.2.0 added X**", "**Vault 1.21.3
    patched CVE…**". Good: "**Persistent state landed**", "**CVE patches
    shipped across the 1.21.x line**".
  - HARD: no editorializing. Ban: "biggest", "doubling down", "leap
    forward", "in the best sense", "powerful", "seamless", "comprehensive",
    "world-class", "transformative", "next-generation", "cutting-edge".
  - HARD: no admissions of ingestion gaps ("release notes were not
    indexed"). If a release isn't in `selected`, just don't mention it.
  - 250 words target. 300 words is the HARD CEILING. Strip until it fits.
  - 80 words is the floor. Don't pad — if signal is thin, ship a shorter
    page.
  - No markdown headings (`#`, `##`, …).

Citations — model-asserted is acceptable in batch:
  - For each major claim, pick the release URL from `selected[*].url` that
    most directly backs it.
  - Emit a JSON array of `{startIndex, endIndex, sourceUrl, title, citedText}`
    where `startIndex`/`endIndex` are character offsets into your generated
    markdown body (compute against the final body you return), `sourceUrl`
    is the chosen release URL, `title` is its release title, and
    `citedText` is a short substring of your body that the citation backs.
  - Spans should not overlap stripped characters and `endIndex` must not
    exceed the body length.

Return EXACTLY two fenced blocks in your final message — nothing else
between them, no preamble, no commentary after:

  Slug: {slug}
  Selected/Total: {n}/{total}
  Status: generated | empty-window | fetch-error

  ~~~markdown
  …the overview body…
  ~~~

  ~~~json
  [ {"startIndex": …, "endIndex": …, "sourceUrl": "…", "title": "…",
     "citedText": "…"}, … ]
  ~~~

Do not attempt to upload. The parent session writes both files and runs
`releases admin overview update`.
```

### Tracking results

After agents complete, the parent runs a **lint pass** on each returned body before uploading. Reject and re-prompt (or fix in-session) any body that trips:

- Opens with `{OrgName}` or `**{OrgName}**` followed by a space — bare org-as-subject.
- Opening sentence longer than 25 words.
- A bold-tease that leads with a version number or CVE identifier.
- Any banned phrase from the prompt's editorializing list.

Then write `/tmp/<slug>-overview.md` and `/tmp/<slug>-overview-citations.json`, and run `releases admin overview update <slug> --content-file … --citations-file …` in parallel (idempotent, last write wins). Both files are required — omitting `--citations-file` clears existing citations on the page.

**Citation offsets are JS string length, not bytes.** The API validates `endIndex <= content.length` where `content.length` is the JS `String.prototype.length` (UTF-16 code units). `wc -c` reports bytes — em-dashes (—), curly quotes, and other multi-byte UTF-8 characters inflate the byte count vs. the JS length. When clamping/validating offsets, use `bun --eval "const c=require('fs').readFileSync(path,'utf8'); process.stdout.write(String(c.length))"` to get the real ceiling. The API also rejects `endIndex` equal to the trailing newline position, so clamp to the JS length of the trimmed body.

For any agent that bailed without content, re-fetch `overview inputs` locally and generate inline. When generating in-session, the parent can produce richer Anthropic-emitted citations per the `regenerating-overviews` skill (search_result blocks); batch sub-agents produce model-asserted citations from the URLs visible in `overview inputs` — accept the tradeoff.

Summary table format:

| Org | Window | Selected/Total | Result                                |
| --- | ------ | -------------- | ------------------------------------- |
| …   | 90d    | 9/9            | regenerated (1.7k chars, 8 citations) |
| …   | 90d    | 0/0            | skipped — no releases in window       |
| …   | 90d    | 14/14          | regenerated in-session (agent bailed) |

## Composing With Other Skills

- **`regenerating-overviews`** — the AI prompt + workflow for the overview step. Required reading for any sub-agent doing the second step above.
- **`parsing-changelogs`** — what `admin source fetch` does under the hood. Useful when fetches misbehave.
- **`managing-sources`** — for adding, hiding, or pausing sources before a refresh.
