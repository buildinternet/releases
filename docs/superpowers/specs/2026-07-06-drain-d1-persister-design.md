# Drain direct-DB persistence (#1946 phase 4) — design

Status: approved 2026-07-06. Final phase of #1946; phases 1–3 merged (#1953 / #1954 / #1957).

## Problem

`DeterministicUpdateWorkflow` (`workers/api/src/workflows/deterministic-update.ts`) runs inside the API worker (has D1/R2) but persists by calling `scrapeFetch` (`packages/adapters/src/scrape-fetch.ts`), which was written for the discovery worker (no D1) — so every write is an HTTP self-call back into the same worker via the `API_SELF` binding.

`scrapeFetch` is also used by onboarding in the discovery worker (`workers/discovery/src/managed-agents-session.ts`), which genuinely has no D1. So this is not a deletion — it is an inject-a-persister refactor: onboarding keeps HTTP, drain gets direct DB.

## Findings (answers to the handoff's open questions)

- **Q1 — post-insert chain.** The `/releases/batch` route already runs embedding, latest-cache invalidation, ReleaseHub events, and IndexNow inline (bespoke `waitUntil` copies in `postReleasesBatchHandler`, not the shared `lib/ingest-steps.ts` helpers). It never runs AI summarization — drained releases wait up to ~24h for the nightly `BatchSummarizeWorkflow` sweep. Poll-fetch and firecrawl summarize inline via `runContentAndEmbedSteps`. Latent gap; phase 4 closes it.
- **Q2 — route side effects beyond the row writes.**
  - `POST /v1/admin/logs/fetch` (`workers/api/src/routes/fetch-log.ts`): fetch_log insert → scrape-failure backoff (`consecutive_errors` bump + exponential `next_fetch_after` + auto-pause at 6, only for `model`/`bot_challenge` categories) → #1862 drain convergence (`unproductive_drains` streak + auto-pause at 5, keyed on the transport-only `wasFlagged` field) → StatusHub DO notify. All best-effort.
  - `PATCH source` (`patchSourceHandler` in `workers/api/src/routes/sources.ts`): for this caller's fields, the counter resets plus a fire-and-forget `regeneratePlaybook(db, orgId)` on every completed drain. No actor notify / vectorize re-embed (those key on fields this caller never sends).
- **Q3 — ordering.** `finalize` does insert → `Promise.all(updateSourceAfterFetch, writeFetchLog)`, fetch log best-effort (`.catch(() => {})`). Error paths write only a fetch log. Preserved as-is.
- **Q4 — raw snapshot.** The drain resolves the `raw-snapshot-capture-enabled` flag and passes `captureRawSnapshots`, so touch-point #6 is in scope for the d1 persister.
- **Beyond the handoff's six touch-points**, `buildWorkerExtractDeps` builds an `ExtractRepo` with five more HTTP calls (`peekContentHash`, `commitContentHash`, `updateSourceMeta`, `getOrgPlaybook`, `logUsage`). **Out of scope** for phase 4 — extraction-time reads/logs stay on HTTP for both callers. A follow-up can migrate them through the same seam if it ever matters.

## Approach: extract-then-inject

Rather than re-implementing the routes' write chains in a parallel drizzle path (silent-drift risk), extract the route handler bodies into shared lib functions; the routes become thin wrappers and the d1 persister calls the same functions in-process. "Direct == HTTP" is then structural, not test-asserted.

### 1. `ScrapePersister` interface (`packages/adapters`, runtime-neutral)

Six methods matching the existing touch-points:

```ts
interface ScrapePersister {
  getSource(identifier: string): Promise<Source | null>;
  getKnownReleases(source: Source): Promise<KnownRelease[]>;
  insertReleases(
    source: Source,
    releases: MappedEntry[],
  ): Promise<{ inserted: number; insertedIds: string[] }>;
  updateSourceAfterFetch(source: Source): Promise<void>;
  writeFetchLog(sourceId: string, result: FetchLogInput): Promise<void>; // best-effort inside impl
  captureRawSnapshot(source: Source, body: string): Promise<void>; // gated + best-effort inside impl
}
```

Threaded through `ScrapeEnv` as `persister?: ScrapePersister`, defaulting to `httpPersister(env)` — the current function bodies moved verbatim — so onboarding is untouched. No drizzle/D1 in `packages/adapters`.

`insertReleases` now returns `insertedIds` (the http impl reads them from the batch route's extended response; see below). `scrapeFetch`'s per-source result JSON gains an `insertedIds` field so the workflow can run post-insert steps replay-safely (the fetch `step.do` return value is durable step state; an in-memory persister side-channel would not survive replay).

### 2. Route-body extraction (`workers/api`, behavior-preserving)

- **Batch insert** → `lib/release-batch-ingest.ts`. Split into:
  - `ingestReleaseBatch(db, env, source, rows)` — the durable core: dedup (`RELEASE_URL_UPSERT`), coverage grouping, chunked insert; returns `insertedIds`.
  - `runBatchIngestEffects(...)` — the current `waitUntil` extras: ReleaseHub publish, IndexNow, embed, latest-cache invalidation.
  - The route composes both exactly as today (effects still via `waitUntil`); the d1 path awaits the effects it needs inside its workflow step instead (a Workflow has no `executionCtx.waitUntil`). The route response additionally returns `insertedIds` (additive).
- **Fetch-log side effects** → `lib/fetch-log-ingest.ts`: row insert + `applyScrapeFailureBackoff` + `applyDrainConvergence` + StatusHub notify, same order and best-effort semantics.
- **Fetch-completion source update** → `lib/source-fetch-complete.ts`: the exact field writes (`lastFetchedAt`, `changeDetectedAt: null`, `consecutiveErrors: 0`, `consecutiveNoChange: 0`, `nextFetchAfter: null`) **plus the `regeneratePlaybook` fire-and-forget** — easy to silently drop, must not be.
- **Raw snapshot**: reuse the existing raw-snapshot route body the same way (content-addressed R2 write).

### 3. `d1Persister` (`workers/api`)

Thin object over the extracted lib functions plus direct drizzle reads for `getSource`/`getKnownReleases`. Wired only in `DeterministicUpdateWorkflow.buildScrapeEnv`; the `API_SELF` binding, `apiFetcher` shim, and staging-key header plumbing in that workflow are removed. (`API_SELF` itself stays — onboarding-facing routes and the discovery worker still use the HTTP surface.)

### 4. Post-insert chain in the drain workflow

After each `fetch:<source>` step returns, when `insertedIds` is non-empty the workflow runs, as separate named steps per source (same discipline as poll-fetch/firecrawl):

- `runContentAndEmbedSteps` (generate-content → embed) — closes the summarization gap;
- `runInvalidateLatestCacheStep`.

The d1 persister's `insertReleases` therefore runs only the durable core + the effects not covered by these steps (ReleaseHub publish, IndexNow) — no double-embed, no double-invalidate.

## Error handling

- Preserve `finalize` semantics exactly: insert → parallel (source update, best-effort fetch log); error paths log-only.
- Post-insert steps use the same retry configs as poll-fetch (`RETRY_GENERATE` / `RETRY_EMBED`); a summarize/embed failure must not fail the already-persisted fetch.
- Best-effort behavior lives inside the persister impls so both impls share the contract.

## Testing

- Parity test pinning observable writes for both persisters against the same fixture DB: release rows inserted, coverage rows, source counters, fetch_log row, `unproductive_drains` convergence, playbook-regen invocation. Use the in-process route smoke pattern (no wrangler).
- Onboarding path: existing discovery tests unchanged; keep discovery in the root-cwd multi-dir `bun test` invocation (mock.module isolation caveat in AGENTS.md).
- Branch-deploy verification before merge of the switch PR: drain a real scrape source, compare Axiom lifecycle (fetch_log, counters, events, IndexNow, and now inline summarization) against a pre-change baseline.

## Sequencing (3 PRs)

1. `ScrapePersister` interface + `httpPersister` extraction — both callers still HTTP; behavior-preserving.
2. Route-body extraction into the three lib modules + `insertedIds` in the batch response — routes remain the only callers; behavior-preserving.
3. `d1Persister` + switch `DeterministicUpdateWorkflow` + post-insert steps — the behavior-sensitive PR, gated on the parity test and the branch-deploy check.

## Out of scope

- Migrating the `ExtractRepo` HTTP calls (content-hash, source-meta, playbook read, usage log).
- Any change to onboarding/discovery behavior.
- Retiring the batch route's inline effects for HTTP callers (they keep exact current behavior).
