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

Launch **by `scriptPath`, not by `name`** — project `.claude/workflows/` scripts are not registered in the Workflow name registry (only plugin-shipped workflows like `deep-research` resolve by name), so `Workflow({ name: "backfill-source" })` errors `not found` (#1407). The path is repo-relative to the session cwd.

Dry-run one source, review the plan + counts, then commit:

```js
Workflow({
  scriptPath: ".claude/workflows/backfill-source.ts",
  args: { source: "acme/changelog" },
}); // dry-run (default)
Workflow({
  scriptPath: ".claude/workflows/backfill-source.ts",
  args: { source: "acme/changelog", dryRun: false, maxReleases: 50 },
});
```

Set a turn budget to cap spend (e.g. prefix the request with `+300k`). Several sources at once:

```js
Workflow({
  scriptPath: ".claude/workflows/backfill-sweep.ts",
  args: { sources: ["acme/changelog", "globex/releases"], dryRun: false },
});
```

`args`: `source` (slug | src\_ id | URL), `maxReleases` (default 50), `dryRun` (default true), `model` (`sonnet` default; `haiku` for bulk/simple). Sweep takes `sources: string[]` and resolves each child `backfill-source` by the same sibling path (override with `backfillScriptPath` for a non-standard checkout layout).

## Re-seed vs. top-up (scrape sources)

A dry-run showing `skippedKnown=0` while the source already has rows is a signal, not a success: **scrape-ingested releases are stored with `url = null`**, so the workflow's known-URL dedup finds nothing to skip. A `dryRun:false` run would then write the overlap as new url'd rows alongside the old url-null rows — duplicates, not a gap-fill.

Correct path for the **first** backfill of an already-ingested `scrape` source:

1. Hard-delete the existing rows to free the `UNIQUE(source_id, url)` dedup slot:
   ```
   releases admin release delete --source <slug> --hard
   ```
2. Then run the backfill with `dryRun: false`.

Truly incremental re-runs (`skippedKnown > 0`) only happen after the source already carries per-release URLs from a prior backfill.

**Caveat:** `releases tail --json` does not expose `url` or `content` — only `id/title/summary/publishedAt/source/contentChars/contentTokens`. To confirm whether existing rows are url-null, use `releases admin release get <id> --json`.

## After a run

The Workflow records the run under `~/.releases/work/` in an **isolated** run dir it mints itself (summary per source, cost line grounded in `budget.spent()`, cross-run sweep report). It deliberately does **not** use `releases admin work start` / the shared `.current-run` pointer — that pointer is global and leaks across concurrent sessions (#1396), so an automated sweep that held it would absorb an unrelated session's mutations. A sweep threads its run dir to each nested source; per-source summaries are namespaced `summary-<slug>.md` to avoid clobbering. Because no pointer is set, these runs don't appear in `releases admin work status`. Review the cross-run report (`reports/<date>-backfill-sweep.md`) for data-quality findings (empty content, thin pages, deferred-for-budget pages). See [maintenance-workspace.md → Concurrency](../../../../docs/architecture/maintenance-workspace.md).

## Related

- **`local-ingest`** — the primitives this wraps (preflight, `/batch`, parity); use it for one-off interactive ingests.
- **`parsing-changelogs`** — the extraction conventions (type, dates, rollups) the extract prompt follows.
- **`managing-sources`** — create the org/source first; naming, primary, playbooks.
- **`maintenance-workspace.md`** — the `~/.releases/work/` run-recording convention.
