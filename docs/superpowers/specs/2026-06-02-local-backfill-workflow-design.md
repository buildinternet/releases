# 2026-06-02 — Local backfill workflow (dynamic Workflow)

## Problem

Backfilling a source's full changelog history through the remote managed agent
(MA) is too expensive to do routinely. The MA path
(`releases admin source fetch` → `POST /v1/workflows/update` → discovery worker)
spins up a coordinator (Sonnet 4.6) plus a worker (Haiku 4.5) and bills inference
for the body→records extraction — and a deep backfill multiplies that across every
window. For onboarding, where there is often a lot of history to pull in at once,
that cost is prohibitive.

The `local-ingest` skill already solves the **cost** half: a local Claude Code
agent is the extractor and writes through the idempotent `/batch` upsert, so no MA
coordinator-Sonnet and no Haiku worker loop run. What it does **not** solve is the
**orchestration** half — the fan-out, the page-list, the window cap, the dedup, and
the "log what you skipped" discipline all live as _prose the model is asked to
follow_. On a large backfill that is exactly where model-driven control flow is
fragile: it silently truncates the window, loses track of which pages it finished,
has no hard token ceiling, and cannot resume when a long run dies partway through.

## Goal

A **dynamic Workflow** (the deterministic JS orchestration primitive from
[Claude Code dynamic workflows](https://claude.com/blog/a-harness-for-every-task-dynamic-workflows-in-claude-code))
that wraps the `local-ingest` primitives in a deterministic harness. The Workflow
owns the loop, the budget, the dedup, the window cap, and the safety gate; the
sub-agents own only the I/O and per-page judgment (read one page → records).

Same cost profile as `local-ingest` (your Claude Code session tokens, hard-capped
by `budget.total`; no separate metered Anthropic API bill, no MA bill), but with
the disciplines that are fragile-in-prose moved into code the model cannot drift
from.

### Non-goals

- Replacing `local-ingest`. This **wraps** its primitives (preflight, fetch +
  extract, `/batch` upsert, parity rules); it does not reimplement them.
- Insert-time AI enrichment. `/batch` runs no AI on insert by design;
  `title_generated` / `title_short` / `summary` stay empty and are a deliberate
  follow-up (see `local-ingest` → Manual enrichment).
- The deterministic extract-lib path (`extractFromBody` / `extractWithTools`). The
  extractor is the agent (Sonnet). The lib path is a later opt-in, not in scope.
- MA / managed-agent execution. This is **local Claude Code only** — it relies on
  `Agent`-tool fan-out, a persistent local filesystem (`~/.releases/work/`), and the
  CLI's `RELEASES_API_*` env. Not deployed to the MA fleet.

## Architectural constraint (load-bearing)

A Workflow **script body has no Bash, no filesystem, no `fetch`** — it is pure JS
orchestration. Every concrete action (running `preflight.ts`, fetching a page,
POSTing to `/batch`, `releases tail`, `releases admin work …`, writing the run
report) happens **inside an `agent()` call**. The script owns control flow; the
agents own I/O. This shapes every phase below: each phase that touches the outside
world is an `agent()` dispatch returning a forced schema.

### Assumptions (verify at implementation time)

- **Sub-agent capabilities.** Workflow sub-agents (the default workflow subagent)
  can run Bash, reach the network, and invoke the `releases` CLI + `curl`. The
  entire design depends on this; if a phase's agent lacks a tool, that phase breaks.
  Verified first in the dry-run smoke test.
- **CLI env.** The `releases` CLI autoloads `RELEASES_API_URL` / `RELEASES_API_KEY`
  from the project `.env`. `.env` is untracked and lives in the **main checkout**, so
  a sub-agent whose CWD is a **worktree** may not see it — thread env explicitly when
  developing/testing the workflow from a worktree. In normal use the operator
  launches from the main checkout where `.env` autoloads.

## Deliverables

```
.claude/workflows/backfill-source.ts           ← per-source engine (the core)
.claude/workflows/backfill-sweep.ts            ← sibling: loops the engine over a list
src/agent/skills/backfilling-sources/SKILL.md  ← front-door: when/why/cost contract, launch recipe
```

`.claude/workflows/` already holds Workflow-tool scripts
(`eval-marketing-subagents.ts`, `eval-summary-subagents.ts`) using the
`export const meta = {…}` + schema + `args` convention, `.ts` extension. The new
scripts match that shape.

## `backfill-source.ts` — per-source engine

### args contract

```jsonc
{
  "source": "acme/changelog", // required — slug, src_ id, or human URL
  "org": "acme", // optional — helps resolve the org-scoped /batch route
  "maxReleases": 50, // optional — page/window cap (default 50). Explicit, never silent.
  "dryRun": true, // optional — DEFAULT TRUE. Map + estimate, no extraction/writes.
  "model": "sonnet", // optional — extractor model (default sonnet; "haiku" for bulk/simple)
}
```

- The **hard token ceiling** is the turn's `budget.total` (set by the operator's
  `+Nk` directive), checked between extract waves — _not_ an arg. `maxReleases` is the
  separate page-count cap. Both are explicit; neither truncates silently.
- `dryRun` defaults **true** so the first invocation always shows the plan + cost
  before any spend. This encodes "present the cost strategy before a bulk run."

### Phases

| #   | Phase                  | Model                        | What the JS owns (not the model)                                                                                                                                                                                                                                                                                                                                                                                     |
| --- | ---------------------- | ---------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 0   | **Preflight gate**     | Haiku                        | Resolve source→URL, run `bun src/agent/skills/local-ingest/preflight.ts <url> --json`. **Fail-closed in JS:** `refuse` → return `{status:'refused'}` and stop; `unknown` → retry once → still unknown → `{status:'blocked-unknown'}` and stop. Only `proceed` continues. The model cannot skip this.                                                                                                                 |
| 0.5 | **Run setup**          | Haiku                        | `releases admin work status --json`; if no active run, `releases admin work start backfill-<slug> --json` and record `weStartedRun=true`; else reuse (sweep owns it). Captures the run dir. The sticky `.current-run` pointer survives the fresh-shell-per-agent reality so later `releases admin …` calls auto-log to `mutations.jsonl`.                                                                            |
| 1   | **Map pages**          | Sonnet                       | Classify shape (`releases admin discovery evaluate <url> --json` → `single-page` \| `index` \| `unknown`) and enumerate detail URLs: sitemap-first (from preflight), else parse index HTML, filtered to the changelog path. **JS applies `maxReleases` and `log()`s exactly what it skipped.** **JS diffs against already-ingested URLs** (`releases tail`) so re-runs skip known pages (idempotent + token-saving). |
| 1.5 | **Dry-run exit**       | —                            | If `dryRun`, return `{status:'dry-run', structure, discovered, capped, skippedKnown, estimatedCost, samplePages}` and stop — only the cheap preflight/map agents spent. To commit, re-invoke with `dryRun:false`.                                                                                                                                                                                                    |
| 2   | **Extract**            | Sonnet (→ Haiku via `model`) | Wave loop over capped targets: `parallel()` of ~8 pages, each an extract agent fetching one page and returning schema-validated batch records (parity rules below). **Budget gate between waves:** `budget.total && budget.remaining() < reserve` → stop, `log()` "extracted X/Y, Z deferred — re-run to continue (idempotent)."                                                                                     |
| 3   | **Collect + validate** | — (JS)                       | Dedup by `url`; drop records missing `title`/`content`; pre-clean `<UNKNOWN>` / `n/a` versions (the batch path does not strip them). Media-URL unwrap stays in the extract prompt (the script can't import `normalizeMediaUrl`).                                                                                                                                                                                     |
| 4   | **Write**              | Haiku                        | Write agent(s) POST records to `/batch` in ~50-chunks (the `local-ingest` bun helper). Centralized parent-saves: extract agents never write, keeping their context clean. Idempotent upsert on `UNIQUE(source_id, url)`.                                                                                                                                                                                             |
| 5   | **Validate**           | Haiku                        | `releases tail <slug> --json`; assert non-empty titles/dates/content; flag thin results.                                                                                                                                                                                                                                                                                                                             |
| 6   | **Run report**         | Haiku                        | Write `summary.md` into the run dir (from `work status --json`) per the maintenance-workspace template. The script passes **`budget.spent()`** as the actual cost — grounded, not the hand-estimate the doc flags as the weak spot. If `weStartedRun`, `releases admin work end`.                                                                                                                                    |

### Why these model tiers

Per repo memory: Haiku degrades when a sub-agent prompt is _instruction-heavy with
tool use_, but is fine for narrow "run one command, return a small schema" work.
The Haiku phases (preflight, run-setup, write, validate, report) are all exactly
that. Sonnet is reserved for the two judgment-heavy, load-bearing phases — **map**
(a bad page-list silently undercovers) and **extract** (parity-correct records from
a fetched page). The `model` arg lets a run drop extraction to Haiku for
bulk/simple sources.

### Return value

```jsonc
{
  "status": "completed | dry-run | refused | blocked-unknown | partial-budget",
  "source": "acme/changelog",
  "structure": "single-page | index",
  "discovered": 312,
  "skippedKnown": 240,
  "capped": 50,
  "extracted": 50,
  "written": 50,
  "deferredForBudget": 0,
  "estimatedCost": "~$X.XX", // dry-run
  "actualCostUsd": 0.0, // real runs, from budget.spent()
  "reportPath": "~/.releases/work/runs/<ts>-backfill-acme/summary.md",
}
```

### Forced schemas (no parsing)

- `PREFLIGHT_SCHEMA` → `{ verdict: "proceed"|"refuse"|"unknown", sitemaps: string[], reason?: string }`
- `MAP_SCHEMA` → `{ structure, pages: string[], totalDiscovered, skippedKnown, note? }`
- `RECORDS_SCHEMA` → `{ pageUrl, records: [{ version?, title, content, url, publishedAt?, media?, type?, prerelease? }] }`
- `WRITE_SCHEMA` → `{ written, chunks, errors: string[] }`
- `VALIDATE_SCHEMA` → `{ count, emptyContent, sampleTitles: string[] }`

### Parity requirements (must match production)

Carried verbatim from `local-ingest` so a locally-backfilled source can later be
picked up by the normal pipeline with no cleanup:

| Axis          | Rule                                                                                |
| ------------- | ----------------------------------------------------------------------------------- |
| `type`        | `feature` vs `rollup` per `parsing-changelogs`. Default unset/`feature`.            |
| `version`     | Real string or omit. Pre-clean `<UNKNOWN>` / `n/a` (batch path does not strip).     |
| `publishedAt` | ISO-8601. Approximate from month/quarter/year headings rather than omit.            |
| `media`       | Unwrap `_next/image` / Vercel optimizer wrappers (in the extract prompt).           |
| `url`         | **Always populate** — the dedup key. Without it the upsert cannot collapse re-runs. |

## `backfill-sweep.ts` — sibling wrapper

```jsonc
{
  "sources": ["acme/changelog", "globex/releases"],
  "maxReleases": 50,
  "dryRun": true,
  "model": "sonnet",
}
```

- One `releases admin work start backfill-sweep` at the top, so every nested
  per-source run detects the active run and writes its `summary-<slug>.md` into the
  one run dir (no `.current-run` pointer collisions — the per-source engine's
  acquire-if-not-held logic defers to the sweep's run).
- Loops `await workflow('backfill-source', { source, … })` **sequentially**: clean
  budget accounting, respects the per-org 409 fetch cooldown, and avoids hammering
  one publisher's pages. (Nested `workflow()` is one level deep — the sweep is a
  sibling of the engine, allowed.)
- After the loop, writes the cross-run `~/.releases/work/reports/<date>-backfill-sweep.md`
  pass-rate + cost table, then `releases admin work end`.

## `backfilling-sources` skill — front-door

SKILL.md beside `local-ingest`, local-only (not deployed to the MA fleet):

- **When to use:** a source has substantial history to backfill and the MA path is
  too expensive; or a remote fetch burned an extraction loop and wrote 0 releases.
- **When NOT to use:** clean feed/GitHub source (let cron fetch it); inside an MA
  session; a publisher opt-out (preflight refuses).
- **Cost contract:** session tokens, hard-capped by `budget.total`; no MA bill, no
  metered Anthropic API bill, no insert-time AI. Dry-run first, always.
- **Preflight lesson:** the `conductor.build` refusal (`Content-Signal: ai-input=no`)
  is the regression target — the gate must refuse it and write nothing.
- **Launch recipe:** `Workflow({ name: 'backfill-source', args: { source, dryRun: true } })`
  → review the plan/cost → re-invoke with `dryRun: false`. Sweep form for a list.
- **Pointers:** parity → `parsing-changelogs`; run-recording → `maintenance-workspace.md`;
  primitives → `local-ingest`; fan-out discipline → `superpowers:dispatching-parallel-agents`.

## Error handling & gates

- **Preflight is fail-closed, in JS.** `refuse`/`unknown` stop the run before any
  fetch or write. Not a prose instruction the model can rationalize past.
- **No silent truncation.** `maxReleases` cap and budget-gate deferral both `log()`
  exactly what was skipped and why; the return value carries `capped` /
  `deferredForBudget`.
- **Idempotent + resumable.** `/batch` upserts on `UNIQUE(source_id, url)`; the
  known-URL diff means re-runs skip done pages; the Workflow journal means a killed
  run resumes via `resumeFromRunId`. A budget-deferred run is just re-invoked.
- **Partial failures isolate.** A page whose extract agent throws drops that page to
  `null` (`.filter(Boolean)`); the rest of the wave proceeds; the dropped page is
  reported, not silently lost.

## Testing

The scripts are launch-and-observe, so verification is behavioral:

1. **Dry-run smoke** against one real source → asserts map + estimate with **zero
   writes** (`releases tail` count unchanged).
2. **Small live run** (`maxReleases: 5`, `dryRun: false`) against a cooperative
   source → validated via `releases tail` (non-empty titles/dates/content) and a
   `summary.md` in the run dir with a `budget.spent()`-grounded cost line.
3. **Conductor refusal** → `Workflow({ name: 'backfill-source', args: { source: 'https://conductor.build/…' } })`
   returns `status:'refused'` and writes nothing. The regression target the
   preflight gate exists for.
4. **Resume** — kill a run mid-extract, re-invoke; assert the known-URL diff +
   `resumeFromRunId` skip already-written pages.

## Open questions / deferred

- **Sweep concurrency.** v1 is sequential. Mild cross-org parallelism is possible
  later but muddies budget accounting and risks the per-org cooldown.
- **Extract-lib opt-in.** A `engine: 'libs'` arg routing to
  `packages/adapters` `extractFromBody`/`extractWithTools` (production parity,
  metered API bill the Workflow budget can't see) is a deliberate later toggle.
- **Single-page entry-splitting cost.** A very large single-page changelog is one
  fetch but a big extract; if it exceeds a comfortable token bound the extract agent
  may need windowing. Out of scope for v1 (cap covers the common case).
