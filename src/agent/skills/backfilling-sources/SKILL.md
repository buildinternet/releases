---
name: backfilling-sources
description: Backfill a changelog source's full history locally in Claude Code via the backfill-source / backfill-sweep dynamic Workflows — preflight-gated, window-capped, budget-gated extraction written through the idempotent /batch upsert, with no managed-agent inference bill. Use when a source has a lot of history to pull in and dispatching the managed agent would be too expensive. Local Claude Code only.
---

# Backfilling Sources

Backfill a source's changelog history **without the managed-agent (MA) inference bill**, using the `backfill-source` dynamic Workflow (and `backfill-sweep` for several at once). The Workflow wraps the `local-ingest` primitives — preflight, fetch + extract, `/batch` upsert, parity rules — in a deterministic harness that owns the window cap, the budget gate, the dedup, and the safety gate, so the disciplines that are fragile when left to prose are enforced in code.

**Local Claude Code only.** The Workflow fans out `agent()` sub-agents and relies on a persistent local filesystem (`~/.releases/work/`) and the CLI's `RELEASES_API_*` env. It is not deployed to the MA fleet.

## When to use

- A source has substantial history to backfill and dispatching the MA per window is too expensive.
- A remote fetch burned an extraction loop and wrote 0 releases — extracting locally sidesteps the loop.

## When NOT to use

- A clean feed / GitHub source — just add it (`managing-sources`) and let cron fetch it.
- Inside an MA session — this is local-only.
- A publisher opt-out — the preflight gate refuses it (see below).

## Cost contract

- **Spends:** your Claude Code session tokens for the `agent()` sub-agents, hard-capped by the turn's `budget.total` (set with a `+Nk` directive). Extraction runs at Sonnet; the mechanical phases (preflight, run-setup, write, validate, report) run at Haiku.
- **Does NOT spend:** no MA coordinator-Sonnet, no Haiku worker loop, no metered Anthropic API bill. `POST /v1/workflows/update` is never called. `/batch` runs no AI on insert.
- Always **dry-run first** (the default) — it maps + estimates and writes nothing.

## Preflight gate (non-negotiable)

The Workflow runs `local-ingest`'s `preflight.ts` first and **fails closed**: `refuse` (an `ai-input=no` / `ai-train=no` opt-out) or a persistent `unknown` stops the run before any fetch or write. `conductor.build` (`Content-Signal: ai-train=no, ai-input=no`) is the regression target — it must be refused. Override only with explicit, documented publisher permission.

## Launch recipe

Dry-run one source, review the plan + counts, then commit:

```
Workflow({ name: "backfill-source", args: { source: "acme/changelog" } })            // dry-run (default)
Workflow({ name: "backfill-source", args: { source: "acme/changelog", dryRun: false, maxReleases: 50 } })
```

Set a turn budget to cap spend (e.g. prefix the request with `+300k`). Several sources at once:

```
Workflow({ name: "backfill-sweep", args: { sources: ["acme/changelog", "globex/releases"], dryRun: false } })
```

`args`: `source` (slug | src\_ id | URL), `maxReleases` (default 50), `dryRun` (default true), `model` (`sonnet` default; `haiku` for bulk/simple). Sweep takes `sources: string[]`.

## After a run

The Workflow records the run under `~/.releases/work/` via `releases admin work start` (summary per source, cost line grounded in `budget.spent()`, cross-run sweep report). Review the report for data-quality findings (empty content, thin pages, deferred-for-budget pages).

## Related

- **`local-ingest`** — the primitives this wraps (preflight, `/batch`, parity); use it for one-off interactive ingests.
- **`parsing-changelogs`** — the extraction conventions (type, dates, rollups) the extract prompt follows.
- **`managing-sources`** — create the org/source first; naming, primary, playbooks.
- **`maintenance-workspace.md`** — the `~/.releases/work/` run-recording convention.
