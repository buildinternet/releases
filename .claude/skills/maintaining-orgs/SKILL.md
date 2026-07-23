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

> **On-demand orgs** (`discovery = 'on_demand'`) are hidden stubs materialized by the on-demand lookup endpoint. They get embeddings and cron fetches but no overviews or summarization. The `releases admin overview plan` / `overview list` endpoints already filter to curated orgs server-side via the `organizations_public` view (which excludes `on_demand`), so manifest-driven sweeps don't need a separate filter pass. To promote an on-demand org to curated, use `releases admin org update <slug> --discovery curated`.

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

> **Sandbox without a working CLI?** If the compiled `releases` binary can't reach the API through a TLS-intercepting egress proxy (the weekly SANA sandbox), the overview steps have a curl-to-REST fallback — see `regenerating-overviews` → _Running without the CLI (curl fallback)_, including the plan manifest (`GET /v1/admin/overviews?format=plan`) that drives target selection below. **Step 1 (`admin source fetch`) has no curl fallback yet** — it dispatches a managed update run and polls, not a single REST call. In a broken-CLI sandbox, skip the fetch and regenerate from current indexed data (surface that the fetch was skipped); a proper fetch-trigger fallback is tracked in [#2163](https://github.com/buildinternet/releases/issues/2163).

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

**`overview get` does not return citations.** Its payload is `org`, `content`, `releaseCount`, `generatedAt`, `updatedAt`, `lastContributingReleaseAt` — no citations field. Confirm the stored citation count from the `overview update` response (`"citations": N`), not `overview get`, or you'll think a successful write dropped every link.

## Batch Updates

When updating multiple orgs, use parallel Claude Code sub-agents (one per org). Each agent runs the two-step flow above for its target.

### Sweep via Workflow (recommended)

The **`update-overviews` dynamic Workflow** (`.claude/workflows/update-overviews.ts`) wraps this whole batch flow in a deterministic harness — selection, the `needsFetch` pre-fetch, budget-gated generation waves, in-parent HTML de-escape + lint + citation-offset re-derivation, and run-recording — so the disciplines documented below are enforced in code rather than re-derived each sweep. **Local Claude Code only**; it fans out `agent()` sub-agents and writes through the same `releases admin overview update` CLI.

**Cost contract.** Spends only your Claude Code session tokens for the `agent()` sub-agents, hard-capped by the turn's `budget.total` (set a `+Nk` directive on the request). No metered Anthropic bill — generation is local sub-agents, _not_ a metered Anthropic Batch API call. The one exception is `needsFetch` source fetches: re-fetching a `scrape`/`agent` source runs the API worker's deterministic update workflow with billed server-side extraction (feed/github fetches are free). Always **dry-run first** (the default) — it reports the target set and writes/fetches nothing.

**Launch recipe.** Launch **by `scriptPath`, not by `name`** — project `.claude/workflows/` scripts are not registered in the Workflow name registry (only plugin-shipped workflows like `deep-research` resolve by name), so `Workflow({ name: "update-overviews" })` errors `not found` (#1407). The path is repo-relative to the session cwd.

```js
// dry-run the outdated set (default): stale ≥14d, missing, must have activity
Workflow({ scriptPath: ".claude/workflows/update-overviews.ts", args: { staleDays: 14 } });
// commit the run
Workflow({
  scriptPath: ".claude/workflows/update-overviews.ts",
  args: { staleDays: 14, dryRun: false },
});
// a date window of overviews (last refreshed on/before Apr 1), live
Workflow({
  scriptPath: ".claude/workflows/update-overviews.ts",
  args: { overviewUpdatedTo: "2026-04-01", dryRun: false },
});
// everyone who shipped since May, capped at 15
Workflow({
  scriptPath: ".claude/workflows/update-overviews.ts",
  args: { activeSince: "2026-05-01", dryRun: false, maxOrgs: 15 },
});
// explicit orgs
Workflow({
  scriptPath: ".claude/workflows/update-overviews.ts",
  args: { orgs: ["vercel", "stripe"], dryRun: false },
});
```

**Selection modes** — the mode is inferred from which args are set; precedence `orgs > activity window > overview-age window > outdated`:

| Args                                        | Mode                    | Selects                                                              |
| ------------------------------------------- | ----------------------- | -------------------------------------------------------------------- |
| `orgs: [...]`                               | explicit list           | exactly those slugs (operator is the gate)                           |
| `activeSince` / `activeUntil`               | release-activity window | orgs whose most-recent release falls in the date range               |
| `overviewUpdatedFrom` / `overviewUpdatedTo` | overview-age window     | orgs whose overview was last refreshed in the date range             |
| `staleDays` / `missing` (or none)           | outdated                | the `overview plan --stale-days N --missing --has-activity` manifest |

Other args: `fetch` (`needsFetch` default \| `none` \| `all`), `dryRun` (default `true`), `model` (`sonnet` default \| `haiku` for bulk), `maxOrgs` (default 25, most-stale-first). Dates are ISO (`YYYY-MM-DD`); the upper bound is inclusive of the whole day. The activity window uses each org's most-recent-release timestamp as the activity proxy — not a count-in-window.

After a run, review the `summary.md` it writes under `~/.releases/work/` for the per-org table and findings: lint-flagged bodies (uploaded anyway — review them), empty-window skips, fetch errors (regen correctly skipped), and any org whose prior citations were stripped to zero.

The manual parallel-sub-agent flow below is the lower-level path — reach for it when you need per-org control the Workflow doesn't expose, or to generate richer Anthropic-emitted (`search_result`) citations in-session for a single org.

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

**Fetch `needsFetch` rows in the parent, not the sub-agent.** For rows the manifest flags `needsFetch: true`, run `releases admin source fetch --org <slug>` from the parent _before_ dispatching — and have sub-agents skip the fetch step entirely (work from current indexed data). This centralizes fetch cost + exit-code visibility (you see a non-zero exit before spending generation tokens), avoids per-agent fetch races on shared sources, and keeps sub-agents read-only so they never trip a `Bash`/`Write` denial. It also measurably helps: a pre-dispatch fetch can widen a thin window (one sweep saw a source go 6 → 13 selectable releases after the parent fetch). Sub-agents whose org wasn't flagged `needsFetch` skip the fetch regardless — the most recent release is already < 7 days old.

**Clip `overview inputs` content for high-volume orgs.** A handful of orgs (`sentry`, `wordpress`, `pulumi`, …) return `overview inputs` payloads of 100K+ tokens — GitHub monorepo release notes and major-version announcements can each run 100K+ characters. The raw `--json` dump piped to stdout exceeds the sub-agent's Bash output cap (~30K chars) and is truncated before the model sees it, so the agent silently generates from only the first few releases. Have sub-agents always pass `--max-content-chars 1000`, which clips each release body to 1000 chars client-side before printing (the CLI still gets the full payload over the wire — only stdout is capped — and 1000 chars/release is what generation truncates to anyway). **A drop in citation count is the symptom** — in the 2026-05-25 sweep, `sentry` and `wordpress` came back with 9 and 5 citations from truncated reads, then 11 and 10 once redone from a complete read.

Prompt template:

```
Regenerate the AI overview for the `{slug}` org in the Releases registry.
The `releases` CLI is installed and authenticated against production.
Read the `regenerating-overviews` skill for the full prompt; the style rules
below are the load-bearing subset and override anything else.

  1. (If scrape/agent sources) skim `releases admin playbook {slug}`.
  2. Do NOT fetch — the parent already fetched this org's sources. Work from
     current indexed data. (If you believe a fetch is needed, STOP and report
     it; don't fetch from inside the sub-agent.)
  3. Read inputs with each release body clipped — the raw payload for
     high-volume orgs exceeds the Bash output cap and truncates silently:
       releases admin overview inputs {slug} --json --max-content-chars 1000
     If `selected` is empty, stop and report "empty-window". Use the URLs in
     `selected[*].url` as the citation source set — do not invent URLs. If the
     read still looks truncated (ends mid-JSON, or `selected` count is far below
     `totalAvailable`), STOP and report it — don't generate from a partial slice.
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
  - Emit a JSON array of `{sourceUrl, title, citedText}`. Do NOT compute
    `startIndex`/`endIndex` — the parent re-derives offsets by substring
    search, so character math on your side is wasted effort and a source of
    errors. `sourceUrl` is the chosen release URL, `title` its release title,
    and `citedText` an EXACT substring of your body that the claim rests on.
  - `citedText` must be a verbatim, contiguous slice of your body from a
    SINGLE formatting run — a bold lead OR the prose after it, never spanning
    the `**` markers. A span that crosses `**` won't be found (the markers sit
    between the words) and the parent will drop that citation.

Return EXACTLY two fenced blocks in your final message — nothing else
between them, no preamble, no commentary after:

  Slug: {slug}
  Selected/Total: {n}/{total}
  Status: generated | empty-window | fetch-error

  ~~~markdown
  …the overview body…
  ~~~

  ~~~json
  [ {"sourceUrl": "…", "title": "…", "citedText": "…"}, … ]
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

**De-escape HTML entities from the returned body first.** Sub-agents reflexively over-escape `&`, `<`, `>`, `"`, `'` (e.g. `Q&amp;A`, `streams.input&lt;T&gt;`) when relaying markdown back as a message — a transport artifact, not the agent's content. The API stores the body verbatim, so an un-decoded entity persists in the rendered page. Decode all five entities in **both** the `body` and each `citedText` _before_ the offset step below, using the **single-pass** replacement the CLI's `unescapeHtmlEntities` uses — `s.replace(/&amp;|&lt;|&gt;|&quot;|&#39;/g, (m) => MAP[m])` where `MAP` is `{ "&amp;": "&", "&lt;": "<", "&gt;": ">", "&quot;": '"', "&#39;": "'" }` (one pass, so `&amp;lt;` stays `&lt;` rather than collapsing to `<`). Decode **in-parent** so your re-derived offsets line up with the stored body, then call the upload **without** `--unescape-html`. (The CLI's `overview update --unescape-html` flag is the alternative for callers who upload escaped text and do _not_ compute offsets locally: it decodes _during_ upload, which would shift offsets you measured against the still-escaped body — so never combine it with the offset-re-deriving flow below.) Background: confirmed sweep issue — monorepo #590, CLI PR #70.

**Re-derive citation offsets in the parent — don't trust agent arithmetic.** Sub-agents return `{sourceUrl, title, citedText}` only. For each citation, find `citedText` in the final (decoded) body with `indexOf` and set `startIndex = idx`, `endIndex = idx + citedText.length`. Drop any citation whose `citedText` isn't found (it crossed a `**` boundary, or the agent paraphrased instead of quoting) or whose span overlaps an earlier one. Offsets built this way are valid against the stored body by construction — it sidesteps the `400 bad_citations` rejections that hand-computed offsets routinely cause, and it's cheaper (agents don't burn tokens counting characters). The offsets are JS `String.prototype.length` (UTF-16 code units), not bytes — so write the parent script in **JS/TS**, where `indexOf` + `.length` give those units directly and need no `wc -c` correction. If you must script the offsets in another language, emit **UTF-16 code-unit** `startIndex`/`endIndex` — not bytes, and not Unicode code points (Python `len()` / Go runes count code points, which diverge from UTF-16 units on non-BMP characters like emoji) — since the API validates against JS `String.length`. Trim the body to remove a trailing newline before computing, since the API rejects `endIndex` at the trailing-newline position.

Then write `/tmp/<slug>-overview.md` and `/tmp/<slug>-overview-citations.json` (the re-derived `{startIndex, endIndex, sourceUrl, title, citedText}` rows), and run `releases admin overview update <slug> --content-file … --citations-file …` in parallel (idempotent, last write wins). Both files are required — omitting `--citations-file` clears existing citations on the page. Confirm the accepted citation count from each update response (`"citations": N`) — `overview get` won't show it.

For any agent that bailed without content, re-fetch `overview inputs` locally and generate inline. When generating in-session, the parent can produce richer Anthropic-emitted citations per the `regenerating-overviews` skill (search_result blocks); batch sub-agents produce model-asserted citations from the URLs visible in `overview inputs` — accept the tradeoff.

Summary table format (`Window` is the effective window used — 30d by default, widened to 90d for quiet orgs whose 30d slice had fewer than 5 releases):

| Org | Window | Selected/Total | Result                                |
| --- | ------ | -------------- | ------------------------------------- |
| …   | 30d    | 9/9            | regenerated (1.7k chars, 8 citations) |
| …   | 90d    | 0/0            | skipped — no releases in window       |
| …   | 30d    | 14/14          | regenerated in-session (agent bailed) |

## Record the Run

A batch refresh makes real prod mutations (`overview update`, `source fetch`) and spends money on managed fetch sessions and sub-agent generation — exactly the kind of work that should leave a durable, cost-aware trail. Write that trail to the per-user `~/.releases/work/` workspace so the run is auditable after the transcript scrolls away. The workspace is in the home dir (not CWD) so it's the same whether you run from the monorepo or the `releases-cli` checkout. Full layout and templates: **`docs/architecture/maintenance-workspace.md`**.

> **Local Claude Code only.** This assumes a persistent local filesystem. A managed-agent session runs in an ephemeral sandbox whose disk is discarded on teardown — skip run-recording there until the workspace can be synced to durable storage (see the doc's "Local Claude Code only" note). This skill is local-driven today, so that's the normal case.

Skip this for a single-org spot check — it's for batch sweeps. At the start of a batch, start a run so the CLI auto-captures the mechanical evidence:

```bash
releases admin work start <batch>
# Creates ~/.releases/work/runs/<ts>-<batch>/ and writes a sticky
# ~/.releases/work/.current-run pointer the CLI reads on every later call.
mkdir -p ~/.releases/work/{tasks,reports} # for the batch definition + cross-run report below
```

(Honors `RELEASES_DATA_DIR` — substitute `$RELEASES_DATA_DIR/work` for `~/.releases/work` if set.) `releases admin work status` shows the active run plus a mutations/sessions tally; `releases admin work end` clears the pointer when the batch is done.

> **Use `work start`, not `export RELEASES_RUN_DIR`.** Claude Code (and most agent runtimes) run **each Bash call in a fresh shell** — shell state, including `export RELEASES_RUN_DIR`, does _not_ carry from one tool call to the next (CWD can reset too), so a one-time `export` silently stops logging after the first command. The sticky `.current-run` pointer `work start` writes is read fresh on every invocation, so logging survives across separate calls. The CLI resolves the active run as `RELEASES_RUN_DIR` env → `.current-run` pointer → none, so for a one-off override you can still set `RELEASES_RUN_DIR=…` inline on a single command and it wins over the pointer.

With a run active, the CLI captures the mechanical evidence on its own:

- Every `releases admin …` write the parent runs — each `overview update`, each `source fetch` trigger — auto-appends a line (`{timestamp, command, target, result}`) to the run's `mutations.jsonl`.
- Managed fetch sessions (`releases admin source fetch … --wait`) you run during the batch land their trace + cost at `<run-dir>/<sessionId>/{trace.json,summary.md}` — the active run is the default trace dir, so no `--trace-dir` flag is needed. To snapshot a session a sub-agent ran, use `releases admin discovery task get <id> --save` (bare `--save` defaults to the active run). The session `summary.md` carries its `estimatedUsd`.
- **Sub-agent generation cost is NOT auto-captured.** The parallel generation sub-agents are the dominant spend on a regen sweep (each ~40–80K tokens), but they aren't CLI sessions, so nothing lands in `runs/`. Record their token totals by hand in `summary.md` from each agent's completion summary — this number is parent-estimated, not logged.

After all sub-agents complete, write the judgment layer the CLI can't:

1. **Per run** — write `summary.md` in the run dir (the path `work start` printed; `work status` reprints it): status, the per-org result table (reuse the "Tracking results" table above), total cost, and what changed.
2. **Per session** — write `~/.releases/work/reports/<date>-<batch>.md` with the cross-run pass-rate / cost table and findings worth acting on.

What to capture, specific to overview regen:

- **Lint rejects**: bodies that tripped the org-as-subject / >25-word opener / banned-phrase checks and had to be re-prompted or fixed in-session.
- **Empty-window skips**: orgs where `overview inputs` returned `selected: []` — a no-op, not a failure.
- **Agents that bailed**: which orgs fell back to in-session generation, and whether citations survived (a refresh that drops `--citations-file` silently strips every link).
- **Fetch errors surfaced**: orgs where `source fetch` exited non-zero and regen was correctly skipped rather than run on stale data.

## Triaging the Staleness Digest

The daily `0 4 * * *` scans email operators a rollup of overdue sources: first-party (`source-staleness` — established cadence, actively polled, yet newest release older than `max(14d, 3× medianGapDays)`) and Firecrawl (`firecrawl-staleness`). A digest entry means "we're fetching but nothing lands" — triage per source, in this order:

1. **Read the fetch log** — `releases admin source fetch-log <slug> --json`. Errors point at the adapter/challenge; clean `no_change` rows point at detection or rendering.
2. **Clean `no_change` on a scrape source → render dry-run**: `releases source fetch <source> --dry-run` renders the index once (no extraction, no MA cost) and reports candidate-link counts. Dozens of candidates = the pipeline can see the page; ~0 / `rendered: false` = empty-shell render — the client-rendered-SPA trap (`finding-changelogs` → Rendering Optimization) applies: look for a feed/`.md`/GitHub alternative, or escalate to `firecrawl-monitoring`.
3. **Suspect the change detector** — a `changeDetector: unreliable` quirk (playbook YAML frontmatter, see `managing-sources`) makes the cron silently skip; an ETag/content-length detector on a page with rotating chrome never trips. Fix the quirk value rather than force-fetching around it.
4. **Cadence was wrong, not the source** — a genuinely slow publisher trips the floor occasionally. No action; the multiplier windows self-correct as history accrues.
5. **Dead surface** — page 404s or moved: update `source.url` (and playbook), or pause with the blocker recorded (`managing-sources` add-and-pause).

Firecrawl-side digest entries have their own runbook: `firecrawl-monitoring` → "Triage: a Firecrawl source went quiet".

## Composing With Other Skills

- **`regenerating-overviews`** — the AI prompt + workflow for the overview step. Required reading for any sub-agent doing the second step above.
- **`parsing-changelogs`** — what `admin source fetch` does under the hood. Useful when fetches misbehave.
- **`managing-sources`** — for adding, hiding, or pausing sources before a refresh.
- **`firecrawl-monitoring`** — triage and lifecycle for Firecrawl-backed sources flagged in the digest.
