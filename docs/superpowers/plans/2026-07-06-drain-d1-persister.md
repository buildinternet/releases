# Drain D1 Persister (#1946 phase 4) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give `DeterministicUpdateWorkflow` direct-DB persistence (no `API_SELF` HTTP self-calls) via an injected `ScrapePersister`, while onboarding (discovery worker) keeps the HTTP path unchanged — and close the drain summarization gap by running the shared post-insert chain.

**Architecture:** Extract-then-inject (spec: `docs/superpowers/specs/2026-07-06-drain-d1-persister-design.md`). A 6-method `ScrapePersister` seam in `packages/adapters` defaults to the current HTTP behavior; the three API route handlers' bodies move into shared `workers/api/src/lib/` functions; a `d1Persister` calls those functions in-process. Three PRs: (1) seam + HTTP impl, (2) route-body extraction, (3) d1 impl + workflow switch + post-insert steps.

**Tech Stack:** TypeScript strict, Bun, Cloudflare Workers/Workflows, Drizzle + D1, Hono.

## Global Constraints

- `packages/adapters` stays runtime-neutral: NO drizzle, D1 types, or `workers/api` imports there.
- Onboarding behavior byte-identical: discovery worker keeps the HTTP persister; its tests stay in the root-cwd multi-dir `bun test` invocation (mock.module leak caveat, AGENTS.md).
- Preserve `finalize` semantics: insert → `Promise.all(updateSourceAfterFetch, writeFetchLog)`; fetch log best-effort; error paths write only a fetch log.
- Preserve every route side effect: batch (deny filter, title dedup, media R2 mirror, chunked upsert w/ 100-bind-param cap, cascade coverage, ReleaseHub publish, IndexNow, embed, latest-cache invalidate), fetch-log (backoff/auto-pause, #1862 drain convergence, StatusHub), source PATCH (counter resets + `regeneratePlaybook`).
- Cloudflare Workflows dedupe `step.do` by name: the drain workflow handles MANY sources per instance, so every post-insert step name MUST be namespaced per source.
- Verification commands: `bun run check`, `bun test tests/ web/ workers/discovery workers/mcp workers/webhooks && bun test workers/api`, plus `cd workers/mcp && npx tsc --noEmit` untouched.
- Commits on branch `claude/blissful-lewin-76435a` (worktree); each PR gets its own branch cut from the previous when splitting for review.

---

## PR 1 — `ScrapePersister` seam + `httpPersister` (behavior-preserving)

### Task 1: Define `ScrapePersister` and extract `httpPersister`

**Files:**
- Create: `packages/adapters/src/scrape-persister.ts`
- Modify: `packages/adapters/src/scrape-fetch.ts` (helpers at lines ~118–237, `captureRawSnapshot` ~626–654, `finalize` ~957–1008, `scrapeFetch` entry ~535)
- Modify: `packages/adapters/package.json` (exports map, if per-path exports are enumerated)
- Test: `tests/adapters/scrape-persister.test.ts` (or alongside existing scrape-fetch tests — follow where `tests/` currently covers `packages/adapters`)

**Interfaces:**
- Produces (consumed by Tasks 2, 6, 7):

```ts
// packages/adapters/src/scrape-persister.ts
import type { Source, KnownRelease, MappedEntry, ErrorCategory } from "./types.js"; // reuse existing type homes

export interface FetchLogInput {
  releasesFound: number;
  releasesInserted: number;
  durationMs: number;
  status: string;
  error?: string;
  errorCategory?: ErrorCategory;
  /** #1862 transport-only drain-vs-quiet-poll signal; never a fetch_log column. */
  wasFlagged?: boolean;
}

export interface InsertReleasesResult {
  inserted: number;
  /** rel_ ids of affected rows; empty when the impl cannot know them (pre-extension HTTP). */
  insertedIds: string[];
}

export interface ScrapePersister {
  getSource(identifier: string): Promise<Source | null>;
  getKnownReleases(source: Source): Promise<KnownRelease[]>;
  insertReleases(source: Source, releases: MappedEntry[]): Promise<InsertReleasesResult>;
  updateSourceAfterFetch(source: Source): Promise<void>;
  /** Best-effort inside the impl — must never throw. */
  writeFetchLog(sourceId: string, result: FetchLogInput): Promise<void>;
  /** Gated + best-effort inside the impl — must never throw. */
  captureRawSnapshot(source: Source, body: string): Promise<void>;
}
```

- `httpPersister(env: HttpPersisterEnv): ScrapePersister` where `HttpPersisterEnv = { apiFetcher; apiKey; sessionId?; captureRawSnapshots? }` (the subset of `ScrapeEnv` those helpers read today).

- [ ] **Step 1: Write the failing test.** Assert `httpPersister` reproduces the current HTTP behavior with a fake `apiFetcher` that records requests:

```ts
import { describe, expect, test } from "bun:test";
import { httpPersister } from "@releases/adapters/scrape-persister";

function recordingFetcher(responses: Record<string, unknown>) {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  return {
    calls,
    fetcher: {
      fetch: async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input instanceof Request ? input.url : input);
        calls.push({ url, init });
        const body = responses[new URL(url).pathname];
        return body === undefined
          ? new Response("not found", { status: 404 })
          : Response.json(body);
      },
    },
  };
}

const SOURCE = { id: "src_x", orgId: "org_y", slug: "s", type: "scrape" } as never;

describe("httpPersister", () => {
  test("insertReleases POSTs batch and returns inserted + insertedIds", async () => {
    const { calls, fetcher } = recordingFetcher({
      "/v1/orgs/org_y/sources/src_x/releases/batch": {
        inserted: 2,
        total: 10,
        insertedIds: ["rel_a", "rel_b"],
      },
    });
    const p = httpPersister({ apiFetcher: fetcher, apiKey: "k" });
    const res = await p.insertReleases(SOURCE, [
      { title: "t1", content: "c1" } as never,
      { title: "t2", content: "c2" } as never,
    ]);
    expect(res).toEqual({ inserted: 2, insertedIds: ["rel_a", "rel_b"] });
    expect(calls[0]!.init?.method).toBe("POST");
  });

  test("insertReleases tolerates responses without insertedIds (pre-extension API)", async () => {
    const { fetcher } = recordingFetcher({
      "/v1/orgs/org_y/sources/src_x/releases/batch": { inserted: 1, total: 3 },
    });
    const p = httpPersister({ apiFetcher: fetcher, apiKey: "k" });
    const res = await p.insertReleases(SOURCE, [{ title: "t", content: "c" } as never]);
    expect(res).toEqual({ inserted: 1, insertedIds: [] });
  });

  test("writeFetchLog is best-effort (rejecting fetch does not throw) and strips nothing the route needs", async () => {
    const p = httpPersister({
      apiFetcher: { fetch: async () => Promise.reject(new Error("down")) },
      apiKey: "k",
    });
    await expect(
      p.writeFetchLog("src_x", {
        releasesFound: 0,
        releasesInserted: 0,
        durationMs: 1,
        status: "no_change",
        wasFlagged: true,
      }),
    ).resolves.toBeUndefined();
  });

  test("captureRawSnapshot no-ops when captureRawSnapshots is off", async () => {
    const { calls, fetcher } = recordingFetcher({});
    const p = httpPersister({ apiFetcher: fetcher, apiKey: "k", captureRawSnapshots: false });
    await p.captureRawSnapshot(SOURCE, "body");
    expect(calls).toHaveLength(0);
  });

  test("updateSourceAfterFetch PATCHes the counter-reset payload", async () => {
    const { calls, fetcher } = recordingFetcher({ "/v1/orgs/org_y/sources/src_x": {} });
    const p = httpPersister({ apiFetcher: fetcher, apiKey: "k" });
    await p.updateSourceAfterFetch(SOURCE);
    const sent = JSON.parse(String(calls[0]!.init?.body));
    expect(sent).toMatchObject({
      changeDetectedAt: null,
      consecutiveErrors: 0,
      consecutiveNoChange: 0,
      nextFetchAfter: null,
    });
    expect(typeof sent.lastFetchedAt).toBe("string");
  });
});
```

- [ ] **Step 2: Run it, verify it fails** (`bun test tests/adapters/scrape-persister.test.ts`) with module-not-found.
- [ ] **Step 3: Implement `scrape-persister.ts`.** MOVE (not copy) the bodies of `fetchSourceInfo`, `fetchKnownReleases`, `insertReleases`, `updateSourceAfterFetch`, `writeFetchLog`, `captureRawSnapshot` from `scrape-fetch.ts` into methods of the object returned by `httpPersister(env)`. Keep `sourceSubpath` (move it too, re-export or import back where scrape-fetch still needs it). Behavior deltas allowed in this task, exactly two: (a) `insertReleases` returns `{ inserted, insertedIds: json.insertedIds ?? [] }`; (b) `wasFlagged` still sent only when true (`...(result.wasFlagged ? { wasFlagged: true } : {})`).
- [ ] **Step 4: Thread the seam through `scrape-fetch.ts`.** Add `persister?: ScrapePersister` to `ScrapeEnv`; at the top of `scrapeFetch`, `const persister = env.persister ?? httpPersister(env);` and replace every direct helper call (`fetchSourceInfo` → `persister.getSource`, etc., including inside `finalize`, the error-path `writeFetchLog`, and `captureRawSnapshot` call sites in `runScrapePath`). `finalize`'s success branch records `const { inserted, insertedIds } = await persister.insertReleases(...)` and includes `insertedIds` in the returned JSON string:

```ts
return JSON.stringify({
  fetched: true,
  status: "success",
  releasesFound: releases.length,
  releasesInserted: inserted,
  insertedIds,
  source: source.slug,
});
```

  `finalize` and the path helpers now take `persister` (thread it as a parameter or read it from `env` consistently — pick one; `env` is already threaded everywhere, so attach the resolved persister onto a local and pass explicitly to `finalize`).
- [ ] **Step 5: Run the new test + the existing adapter/discovery suites.** `bun test tests/ workers/discovery` — all green. The discovery worker needs no change: it passes no `persister`, so the default `httpPersister(env)` reproduces today's behavior.
- [ ] **Step 6: `bun run check`** — green.
- [ ] **Step 7: Commit.** `git commit -m "refactor(adapters): extract ScrapePersister seam with httpPersister default (#1946)"`

### Task 2: PR 1 wrap-up

- [ ] **Step 1:** Full test run: `bun test tests/ web/ workers/discovery workers/mcp workers/webhooks && bun test workers/api`.
- [ ] **Step 2:** Open PR 1 (base `main`) titled `refactor(adapters): ScrapePersister seam + httpPersister extraction (#1946 phase 4, 1/3)`. Body: link the spec, state "no behavior change — both callers still HTTP; insertedIds field is additive and empty until PR 2". Use `--body-file`.

---

## PR 2 — Route-body extraction (behavior-preserving)

### Task 3: Extract batch-insert core + effects → `lib/release-batch-ingest.ts`

**Files:**
- Create: `workers/api/src/lib/release-batch-ingest.ts`
- Modify: `workers/api/src/routes/sources.ts` (`postReleasesBatchHandler`, lines ~791–1210)
- Test: `workers/api/test/` — follow the in-process route smoke pattern used by existing sources-batch tests (find them via `grep -r "releases/batch" workers/api/test tests/`)

**Interfaces:**
- Produces (consumed by Task 6):

```ts
// workers/api/src/lib/release-batch-ingest.ts
export interface BatchReleaseInput {
  version?: string | null;
  title: string;
  content: string;
  url?: string | null;
  contentHash?: string;
  publishedAt?: string | null;
  media?: string | null;
  type?: ReleaseType;
  prerelease?: boolean;
}

export interface BatchIngestResult {
  inserted: number;
  total: number;
  insertedIds: string[];
  /** rows for the publish/IndexNow effects, coverage rows already filtered out */
  visiblePublishRows: InsertedReleaseRow[];
}

/** Durable core: deny filter, title dedup, media R2 mirror, chunked upsert, cascade coverage, total count. */
export async function ingestReleaseBatch(
  db: Db,
  env: BatchIngestEnv, // FLAGS, SCRAPE_TITLE_DEDUP_DISABLED, MEDIA, MEDIA_TRANSFORM, MEDIA_GIF_TRANSCODE_ENABLED
  src: SourceRow,
  input: { releases: BatchReleaseInput[]; enrichMode: boolean },
): Promise<BatchIngestResult>;

/** The current waitUntil extras: ReleaseHub publish, IndexNow, embed+embeddedAt, latest-cache invalidate. Awaitable. */
export async function runBatchIngestEffects(
  db: Db,
  env: BatchEffectsEnv,
  src: SourceRow,
  result: BatchIngestResult,
  opts?: { skipEmbed?: boolean; skipInvalidate?: boolean },
): Promise<void>;
```

- [ ] **Step 1: Write/extend the failing test.** In the in-process route smoke style (`routes.request(path, init, env)` with `bun:sqlite` fixture DB from `tests/db-helper.ts`): POST a 2-release batch and assert the response now includes `insertedIds` (array of `rel_` ids, length 2) alongside the existing `{ inserted, total }`. Keep/extend existing assertions (dedup on re-POST, deny filter) — they become the extraction's regression net.
- [ ] **Step 2: Run, verify the new `insertedIds` assertion fails.**
- [ ] **Step 3: Extract.** Move lines ~854–1059 of `postReleasesBatchHandler` (deny filter through total count + cascade filtering) verbatim into `ingestReleaseBatch`; move the three `waitUntil` blocks (publish/invalidate/IndexNow, lines ~1061–1103) and the embed block (~1105–1193) verbatim into `runBatchIngestEffects`, with `opts.skipEmbed`/`skipInvalidate` guards around their respective sections (default false). Request-shaped concerns STAY in the route: body parse, `releases`-array validation, `mode` validation → `enrichMode`. The route becomes:

```ts
const result = await ingestReleaseBatch(db, c.env, src, {
  releases: body.releases,
  enrichMode,
});
c.executionCtx.waitUntil(runBatchIngestEffects(db, c.env, src, result));
return c.json({ inserted: result.inserted, total: result.total, insertedIds: result.insertedIds });
```

  Keep the existing try/catch + `classifyDbError` envelope in the route wrapping the `ingestReleaseBatch` call.
- [ ] **Step 4: Run `bun test workers/api`** — green, including the new `insertedIds` assertion.
- [ ] **Step 5: Commit.** `git commit -m "refactor(api): extract release batch ingest core + effects into lib (#1946)"`

### Task 4: Extract fetch-log side effects → `lib/fetch-log-ingest.ts`

**Files:**
- Create: `workers/api/src/lib/fetch-log-ingest.ts`
- Modify: `workers/api/src/routes/fetch-log.ts` (handler lines ~196–283; helpers `applyScrapeFailureBackoff` ~76–109, `applyDrainConvergence` ~119–162 move wholesale)
- Test: extend the existing fetch-log route tests (find via `grep -rl "logs/fetch" workers/api/test tests/`)

**Interfaces:**
- Produces (consumed by Task 6):

```ts
// workers/api/src/lib/fetch-log-ingest.ts
export interface FetchLogWriteInput {
  sourceId: string | null;
  sessionId: string | null;
  releasesFound: number;
  releasesInserted: number;
  durationMs: number;
  status: string;
  error: string | null;
  errorCategory: string | null;
  wasFlagged?: boolean; // transport-only, stripped before insert
}

/**
 * fetch_log insert + backoff/auto-pause + #1862 drain convergence + StatusHub
 * notify, in that order, matching the route's best-effort semantics. Throws
 * only if the fetch_log INSERT itself fails.
 */
export async function ingestFetchLog(
  db: Db,
  env: FetchLogEnv, // STATUS_HUB?
  input: FetchLogWriteInput,
): Promise<FetchLogRow>;
```

- [ ] **Step 1: Write the failing test** for the lib function directly (fixture DB): (a) `errorCategory: "bot_challenge"` bumps `consecutive_errors` and sets `next_fetch_after`; (b) `wasFlagged: true` + `releasesInserted: 0` increments `unproductive_drains`, and the 5th consecutive call sets `fetch_priority = "paused"`; (c) `wasFlagged: true` + `releasesInserted > 0` resets `unproductive_drains` to 0; (d) `wasFlagged` never lands as a fetch_log column. Import from the not-yet-existing module so it fails.
- [ ] **Step 2: Run, verify failure.**
- [ ] **Step 3: Extract.** Move the handler body (insert → `applyScrapeFailureBackoff` → `applyDrainConvergence` → StatusHub block) verbatim into `ingestFetchLog`; the route keeps auth + body parse and becomes `const row = await ingestFetchLog(db, c.env, body); return c.json(row, 201);` with its existing 500-on-insert-failure behavior (let the throw propagate to the route's error envelope).
- [ ] **Step 4: Run `bun test workers/api`** — new lib tests + existing route tests green.
- [ ] **Step 5: Commit.** `git commit -m "refactor(api): extract fetch-log ingest side effects into lib (#1946)"`

### Task 5: Extract fetch-completion source update → `lib/source-fetch-complete.ts`

**Files:**
- Create: `workers/api/src/lib/source-fetch-complete.ts`
- Test: `workers/api/test/` new file alongside the other lib tests

**Interfaces:**
- Produces (consumed by Task 6):

```ts
// workers/api/src/lib/source-fetch-complete.ts
/**
 * The narrow write `updateSourceAfterFetch` performs via PATCH today:
 * counter resets + the fire-and-forget playbook regen that patchSourceHandler
 * triggers on every source PATCH (sources.ts ~3069). NOT a general PATCH —
 * the actor-notify and vectorize re-embed branches key on fields this write
 * never touches, so they are intentionally absent.
 */
export async function completeSourceFetch(
  db: Db,
  src: { id: string; orgId: string | null },
  opts?: { waitUntil?: (p: Promise<unknown>) => void }, // absent → await the regen
): Promise<void>;
```

Implementation core:

```ts
await db
  .update(sources)
  .set({
    lastFetchedAt: new Date().toISOString(),
    changeDetectedAt: null,
    consecutiveErrors: 0,
    consecutiveNoChange: 0,
    nextFetchAfter: null,
  })
  .where(eq(sources.id, src.id));
if (src.orgId) {
  const regen = regeneratePlaybook(db, src.orgId).catch(() => {});
  if (opts?.waitUntil) opts.waitUntil(regen);
  else await regen;
}
```

Note: this is a NEW function mirroring the PATCH route's behavior for this caller's field set — the PATCH route itself is NOT refactored (its body is dominated by validation/guards irrelevant to this write). The parity test in Task 7 is what pins equivalence.

- [ ] **Step 1: Write the failing test**: seed a source with non-zero counters + `change_detected_at`, call `completeSourceFetch`, assert all five fields reset and `regeneratePlaybook` ran (spy or assert on its observable write — check what `playbook-regen.ts` writes and assert on that with the fixture DB).
- [ ] **Step 2: Run, verify failure. Step 3: Implement (code above). Step 4: Run, green.**
- [ ] **Step 5: Commit.** `git commit -m "feat(api): add completeSourceFetch lib mirroring the fetch-completion PATCH (#1946)"`
- [ ] **Step 6: PR 2 wrap-up.** Full test suite both processes; `bun run check`; open PR 2 (base = PR 1's branch or main after PR 1 merges) titled `refactor(api): extract batch/fetch-log/source-complete route bodies into lib (#1946 phase 4, 2/3)`; body notes the only wire change is the additive `insertedIds` in the batch response.

---

## PR 3 — `d1Persister` + workflow switch + post-insert chain (behavior-sensitive)

### Task 6: Implement `d1Persister`

**Files:**
- Create: `workers/api/src/lib/d1-scrape-persister.ts`
- Test: `workers/api/test/d1-scrape-persister.test.ts`

**Interfaces:**
- Consumes: `ScrapePersister`/`FetchLogInput` (Task 1), `ingestReleaseBatch`/`runBatchIngestEffects` (Task 3), `ingestFetchLog` (Task 4), `completeSourceFetch` (Task 5), plus the existing raw-snapshot route's storage helper (find the route via `grep -rn "raw-snapshot" workers/api/src/routes` and reuse its content-addressing helper; extract it to a small function first if it is inline).
- Produces (consumed by Task 8): `d1ScrapePersister(opts: { db: Db; env: D1PersisterEnv; sessionId: string; captureRawSnapshots: boolean }): ScrapePersister`.

Implementation sketch (complete the env type from what each lib function needs):

```ts
export function d1ScrapePersister(opts: {
  db: Db;
  env: D1PersisterEnv;
  sessionId: string;
  captureRawSnapshots: boolean;
}): ScrapePersister {
  const { db, env, sessionId } = opts;
  return {
    async getSource(identifier) {
      // src_ id, org/slug coordinate, or bare slug — mirror fetchSourceInfo's
      // three shapes using the same resolvers the routes use
      // (resolveSourceFromContext's underlying lookup; reuse, don't re-implement).
      return resolveSourceByIdentifier(db, identifier);
    },
    async getKnownReleases(source) {
      // Mirror GET known-releases?limit=10 — reuse the route's query
      // (extract to lib if inline; it is a simple ordered select).
      return selectKnownReleases(db, source.id, 10);
    },
    async insertReleases(source, releases) {
      const result = await ingestReleaseBatch(db, env, source, {
        releases: releases.map(toBatchReleaseInput), // same field mapping httpPersister sends
        enrichMode: false,
      });
      // Workflows have no waitUntil; await the effects. Embed + invalidate are
      // skipped — the workflow runs them as durable steps (Task 8).
      await runBatchIngestEffects(db, env, source, result, {
        skipEmbed: true,
        skipInvalidate: true,
      });
      return { inserted: result.inserted, insertedIds: result.insertedIds };
    },
    async updateSourceAfterFetch(source) {
      await completeSourceFetch(db, source); // awaits playbook regen (no waitUntil in workflows)
    },
    async writeFetchLog(sourceId, result) {
      try {
        await ingestFetchLog(db, env, {
          sourceId,
          sessionId,
          releasesFound: result.releasesFound,
          releasesInserted: result.releasesInserted,
          durationMs: result.durationMs,
          status: result.status,
          error: result.error ?? null,
          errorCategory: result.errorCategory ?? null,
          ...(result.wasFlagged ? { wasFlagged: true } : {}),
        });
      } catch {
        /* best-effort, matching httpPersister */
      }
    },
    async captureRawSnapshot(source, body) {
      if (!opts.captureRawSnapshots || body.trim().length === 0) return;
      try {
        await storeRawSnapshot(db, env, source, body); // the extracted route helper
      } catch (err) {
        logEvent("warn", { component: "d1-scrape-persister", event: "raw-snapshot-failed", err: err instanceof Error ? err : String(err) });
      }
    },
  };
}
```

- [ ] **Step 1: Write failing tests** against the fixture DB: `getSource` resolves all three identifier shapes; `insertReleases` writes rows + returns ids and does NOT set `embeddedAt` (embed skipped); `writeFetchLog` swallows a forced error; `captureRawSnapshot` no-ops when gated off.
- [ ] **Step 2: Run, verify failure. Step 3: Implement. Step 4: Run, green. Step 5: Commit** `feat(api): d1 ScrapePersister over the extracted ingest lib (#1946)`.

### Task 7: HTTP↔D1 parity test

**Files:**
- Test: `workers/api/test/scrape-persister-parity.test.ts`

**Interfaces:** Consumes both persisters + the in-process route app (`routes.request(path, init, env)` smoke pattern from memory/`reference_worker_route_inprocess_smoke`).

- [ ] **Step 1: Write the test.** Build TWO identical fixture DBs. Persister A = `httpPersister` whose `apiFetcher` is `{ fetch: (i, init) => routes.request(...) }` against DB-A (real route handlers in-process). Persister B = `d1ScrapePersister` on DB-B. Drive the same script through both: `insertReleases` (2 releases, one duplicate URL) → `updateSourceAfterFetch` → `writeFetchLog({ status: "no_change", wasFlagged: true, releasesInserted: 0 })` ×5. Then assert row-level equality between DB-A and DB-B for: `releases` rows (count + urls + titles), `release_coverage` rows, `sources` counters (`last_fetched_at` nullness, `change_detected_at`, `consecutive_errors`, `consecutive_no_change`, `next_fetch_after`, `unproductive_drains`, `fetch_priority` — paused after the 5th unproductive drain on BOTH), `fetch_log` rows (count + status + wasFlagged absent as a column). This is the "direct == HTTP" gate from the spec.
- [ ] **Step 2: Run — expect pass if Tasks 3–6 are faithful; any diff is a real finding, fix the d1 side (or a latent route bug — surface it, don't paper over).**
- [ ] **Step 3: Commit.** `test(api): pin HTTP vs D1 scrape-persister parity (#1946)`

### Task 8: Switch `DeterministicUpdateWorkflow` + post-insert steps

**Files:**
- Modify: `workers/api/src/workflows/deterministic-update.ts` (env iface lines 42–72, `run` 105–182, `buildScrapeEnv` 190–239)
- Modify: `workers/api/wrangler.jsonc` — remove the `API_SELF` service binding ONLY from the workflow's usage; check first whether other consumers bind it (`grep -rn "API_SELF" workers/api`). If the workflow is the sole consumer, delete the binding + `STAGING_ACCESS_KEY` shim wiring from both prod and `[env.staging]` blocks; otherwise leave wrangler untouched and only drop it from `DeterministicUpdateWorkflowEnv`.
- Test: `workers/api/test/deterministic-update.test.ts` (extend existing if present)

**Interfaces:** Consumes `d1ScrapePersister` (Task 6), `runContentAndEmbedSteps`/`runInvalidateLatestCacheStep` (`workers/api/src/lib/ingest-steps.ts:408,435`), `insertedIds` in the fetch-step return (Task 1).

- [ ] **Step 1: Wire the persister.** `buildScrapeEnv` drops the `API_SELF`/`apiFetcher`/staging-key plumbing and instead sets `persister: d1ScrapePersister({ db: createDb(env.DB), env, sessionId, captureRawSnapshots })`. Add `DB` (and whatever `D1PersisterEnv`/`ingest-steps` need: `MEDIA?`, `RELEASES_INDEX?`, embed config vars, `WEB_BASE_URL` for IndexNow, etc. — copy the exact list from `PollAndFetchWorkflowEnv`) to `DeterministicUpdateWorkflowEnv`, and add the corresponding bindings to the workflow's env in `wrangler.jsonc` if not already inherited (workflows share the worker's bindings — verify, likely no wrangler change needed). Keep `apiFetcher` in `ScrapeEnv` for the extraction-deps HTTP calls (out of scope) — the drain still needs `API_SELF` for `buildWorkerExtractDeps`' `ExtractRepo`! **Check this before deleting anything:** `scrapeFetch` line ~545 passes `apiFetcher` to `buildWorkerExtractDeps`. Since ExtractRepo stays HTTP (spec: out of scope), `API_SELF` + `apiFetcher` + staging shim REMAIN in the workflow env; only the six persistence touch-points move off it.
- [ ] **Step 2: Post-insert steps.** After `runScrapeFetchLoop`, iterate `summary.results`; for each result whose parsed JSON has `insertedIds.length > 0`, load the source row (`db`, by slug/id from the result) and run, with per-source-namespaced step names (Workflows dedupe `step.do` by name and this instance handles many sources):

```ts
const nsStep: WorkflowStep = {
  ...step,
  do: ((name: string, a: unknown, b?: unknown) =>
    (step.do as Function)(`${sourceIdentifier}:${name}`, a, b)) as WorkflowStep["do"],
};
await runContentAndEmbedSteps(nsStep, { db, env: stepEnv, source, insertedIds, fetchEnv });
await runInvalidateLatestCacheStep(nsStep, env, source, insertedIds.length);
```

  Wrap in try/catch + `logEvent("warn", …)` per source — a summarize/embed failure must not fail the already-persisted run (spec: error handling). `fetchEnv`/`stepEnv`: construct the same way `poll-and-fetch.ts:360` does — read that call site and mirror it.
- [ ] **Step 3: Tests.** Extend the workflow test (or add one) with a fake `step` that records `do` names: assert (a) fetch steps still named `fetch:<source>`; (b) when a fetch result carries `insertedIds`, `"<source>:generate-content"` and `"<source>:invalidate-latest-cache"`-style namespaced steps run; (c) a throwing generate-content does not fail the run.
- [ ] **Step 4: Full verification.** `bun run check`; both test processes; `cd workers/mcp && npx tsc --noEmit`.
- [ ] **Step 5: Commit.** `feat(api): drain persists direct-to-D1 + runs post-insert chain (#1946)`

### Task 9: Branch-deploy verification + PR 3

- [ ] **Step 1:** Deploy the branch via GHA dispatch (`gh workflow run deploy-workers.yml --ref <branch>` with environment=staging) — staging first.
- [ ] **Step 2:** Trigger a deterministic update for a known scrape source on staging (direct POST to the update dispatch route with the staging key). Compare against a pre-change baseline in Axiom (`releases-cloudflare-logs`): fetch_log row present with correct status/wasFlagged handling; source counters reset; `deterministic-update-complete` event; release rows inserted with coverage grouping; **and the new part** — `generate-content`/`embed` step events for the drained source (summaries populated without waiting for the 04:30 sweep).
- [ ] **Step 3:** Open PR 3 titled `feat(api): drain direct-DB persistence + inline summarization (#1946 phase 4, 3/3)`. Body: spec link, parity-test pointer, staging verification evidence (Axiom queries + before/after), note that `API_SELF` remains for the ExtractRepo HTTP calls (explicitly out of scope). Do NOT auto-request CodeRabbit; this PR likely warrants it (billed drain path) — ask the user.
- [ ] **Step 4:** After merge: close out #1946 with a comment summarizing all four phases; update the memory file `project_deterministic_update_workflow_1946.md`.

---

## Self-review notes

- Spec coverage: interface (T1), extraction (T3–T5), d1 impl (T6), parity test (T7), workflow switch + summarization gap + namespaced steps (T8), branch verify (T9). ExtractRepo explicitly retained on HTTP (T8 step 1 guard).
- Key trap encoded: `API_SELF` cannot be fully removed while `buildWorkerExtractDeps` still uses `apiFetcher` (T8 step 1).
- Line numbers are anchors as of commit `918efac8`; re-grep before editing if the tree has moved.
