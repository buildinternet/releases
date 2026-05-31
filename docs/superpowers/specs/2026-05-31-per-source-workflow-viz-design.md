# Per-source workflow visualization (Fetch Log tab)

**Date:** 2026-05-31
**Status:** Design — approved directions, pending spec review
**Surface:** Web frontend, dev-only Fetch Log tab on an org Overview page

## Problem

The Fetch Log tab today shows two flat tables: a **Fetch Plan** panel (per-source strategy / interval / last poll / next due, with inline priority + Firecrawl edits) and a **fetch-log list** (per-run SOURCE / TIME / STATUS / RESULT / DURATION rows). Neither shows _how a given source actually moves through the ingestion pipeline_ — which stages apply to it, where it currently sits, and how the last run went. An operator debugging "why isn't this source ingesting well" has to hold the whole fetch → parse → AI-passes → insert → embed pipeline in their head and cross-reference two tables plus Axiom.

We want a per-source **workflow visualization** that makes the ingestion path legible at a glance.

## Chosen design (decisions locked during brainstorming)

| Axis           | Decision                                                                                                                          |
| -------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| **Intent**     | **Blend** — pipeline topology as the canvas, annotated with current state + last-run outcome per node.                            |
| **Placement**  | **Side drawer** — clicking a Fetch Plan row slides in a right-side drawer for that source. Table stays put.                       |
| **Node scope** | **Full pipeline, async tail collapsed** — content path expanded; post-commit async steps behind a `+ post-commit (N) ▸` expander. |
| **Adaptivity** | **Adaptive per source type** — render only the stages that actually apply to the source; no dimmed N/A nodes.                     |
| **Fidelity**   | **Phased** — Phase 1 derives everything from data we already store; Phase 2 adds per-stage timing for a true waterfall.           |
| **Rendering**  | **Custom vertical pipeline** — divs + connector line + status dot. No new dependency (no React Flow / @xyflow).                   |

Explicitly **not** chosen: React Flow / Kumo / AI-SDK flow components (overkill for a mostly-linear pipeline in a narrow drawer, fights the app's monospace-table aesthetic, +dependency weight). Considered and set aside in favor of a hand-rolled vertical component.

## Architecture

Three new units plus reuse of the existing fetch-plan helpers.

### 1. `describeWorkflowStages(source)` — pure topology function

Lives in `@releases/adapters` (`packages/adapters/src/workflow-stages.ts`), beside the existing `describeFetchPlan` / `computeFetchState` / `computeSweepHealth` in `fetch-plan.ts`. Pure, runtime-neutral, fully unit-testable. This is the **single source of truth** for the adaptive node set — no per-type branching in React.

Signature (illustrative):

```ts
type StageKind = "sync" | "ai" | "async";
interface WorkflowStage {
  key: string; // "poll" | "fetch" | "hash" | "extract" | "parse" | "enrich" | "classify" | "upsert" | "summarize" | "embed" | "changelog" | "publish" | "agent-session" | "webhook" | "diff"
  label: string; // "Poll", "Fetch", "Extract", …
  kind: StageKind; // drives grouping (content path vs async tail) + accent color
  detailHint?: string; // static sub-label, e.g. "Browser Rendering", "tool-loop", "github-api"
}
function describeWorkflowStages(source: SourceRow): WorkflowStage[];
```

Inputs it branches on: `source.type` (`github` / `feed` / `scrape` / `agent` / `appstore`, plus the `fetch-plan` strategy refinements `video`, `crawl`, `firecrawl`) and metadata flags (`marketingFilter`, `feedContentDepth === "summary-only"`, `firecrawl`, `crawlEnabled`, `githubUrl`). It reuses `describeFetchPlan(source).strategy` to stay consistent with the cadence the Fetch Plan table already shows — the topology can't drift from the strategy label.

#### Adaptive stage sets per source type

Content-path stages are listed top-to-bottom; the async tail is grouped separately. `[flag]` = conditional on that flag.

- **github** — Poll (`github-api`) → Fetch (releases API) → Hash check → Parse (structured/direct) → `[classify if marketingFilter]` → Upsert → **async:** Summarize, Embed, Changelog discover+embed, Publish.
- **feed** — Poll (`etag`/feed 4xx) → Fetch (RSS/Atom/JSON Feed) → Hash check → Parse feed → `[Feed enrich if feedContentDepth=summary-only & FEED_ENRICH_ENABLED]` → `[classify if marketingFilter]` → Upsert → **async:** Summarize, Embed, Publish.
- **scrape** — Poll (detector/`etag`) → Fetch (Browser Rendering) → Hash check → Extract (one-shot ≤50K tokens or tool-loop >50K) → `[classify if marketingFilter]` → Upsert → **async:** Summarize, Embed, Publish.
  - **crawl** variant (`metadata.crawlEnabled`): Fetch node becomes "Crawl (multi-page `/crawl`)"; rest identical to scrape.
- **video** (YouTube) — Poll → Fetch (YouTube API/feed) → Hash check → Parse → Upsert → **async:** Summarize, Embed, Publish. (Feed-like; no extract/enrich/classify/changelog.)
- **appstore** — Poll (iTunes lookup; `?v=` version is the change signal) → Fetch (iTunes lookup API → release notes) → Hash check → Parse (appstore materialization) → Upsert → **async:** Summarize, Embed, Publish. No extract, no enrich, no changelog.
- **agent** — Trigger (scheduled / scrape-agent sweep) → **Agent session** (managed discovery/worker — browses + extracts; collapses fetch+extract into one node) → Parse records (server-side Sonnet body→records) → `[classify if marketingFilter]` → Upsert → **async:** Summarize, Embed, Publish. The managed-agent fetch is a relative black box; represent it as a single `agent-session` node.
- **firecrawl** — **webhook-driven, no poll** (cadence = `firecrawl-webhook`, excluded from poll-fetch cron). Webhook received (`monitor.page`) → Diff parse (`addedContentFromDiff`; hunkless whole-document diff — branches: diff-delta vs full re-scrape) → Extract (Haiku on added content) → `[classify if marketingFilter]` → Upsert → **async:** Summarize, Embed, Publish.

> These three (appstore / agent / firecrawl) plus video/crawl are the cases the brainstorming mockups didn't render; they're the highest-risk part of the topology mapping and **must be covered by `describeWorkflowStages` unit tests** that assert the exact ordered stage list per fixture source.

### 2. `GET /v1/status/source-workflow?sourceId=…` — dev status endpoint

New handler in `workers/api/src/routes/status.ts`, mounted under the same dev `/api/proxy` gating as the existing fetch-plan/fetch-log status endpoints (not part of the public REST surface). Everything in the response is **derived from tables we already store** — no new instrumentation in Phase 1.

Response shape:

```ts
interface SourceWorkflowResponse {
  source: { id; slug; name; type; strategyLabel };
  stages: WorkflowStage[]; // describeWorkflowStages(source)
  state: FetchState & SweepHealth; // reuse computeFetchState + computeSweepHealth
  plan: FetchPlan; // reuse describeFetchPlan (cadence, interval)
  lastRun: {
    // latest fetch_log row for this source
    status: "success" | "error" | "no_change" | "dry_run";
    releasesFound: number;
    releasesInserted: number;
    durationMs: number | null;
    error: string | null;
    createdAt: string;
  } | null;
  aiPasses: {
    // recent usage_log rows, grouped by operation
    operation: string; // summarize | classify_marketing | enrich_feed_content | extract
    ran: boolean;
    count: number; // rows touched in the correlated window
    inputTokens: number;
    outputTokens: number;
  }[];
  sparkline: ("success" | "error" | "no_change" | "dry_run")[]; // last ~10 fetch_log statuses
}
```

Reads: `sources` (config + state), `fetch_log` (last run + sparkline, via `idx_fetch_log_source_created`), `usage_log` (AI-pass presence/cost by `sourceId`, correlated to the last-run window by `createdAt`).

### 3. Drawer UI

- `web/src/components/source-workflow-drawer.tsx` — the right-side drawer container (open/close, source header, status strip, pipeline).
- `web/src/components/workflow-pipeline.tsx` — the custom vertical pipeline (R1): one row per stage = status dot + name + sub-detail + outcome/counts; connector line between rows; async tail behind a `+ post-commit (N) ▸` expander; `kind` drives accent color (sync = green/blue, ai = purple, async = amber).
- `web/src/components/use-source-workflow.ts` — data hook fetching `GET /v1/status/source-workflow`, mirroring the existing `use-fetch-plan.ts` / `use-fetch-log.ts` patterns.
- Wire-up: `org-fetch-plan-panel.tsx` rows become clickable; selecting a row sets the active sourceId and opens the drawer.

### Phase 1 node → data mapping (the honest part)

| Node                        | Phase 1 source                                        | Shows                                                      |
| --------------------------- | ----------------------------------------------------- | ---------------------------------------------------------- |
| Poll                        | `sources.changeDetectedAt`, detection kind            | changed / no-change + detection (etag/github-api/detector) |
| Fetch                       | `fetch_log.status`                                    | ✓ / ✗ + fetch mode (render / API / feed)                   |
| Hash check                  | `sources.lastContentHash` + last-run status           | changed / unchanged                                        |
| Extract / Parse             | `usage_log` (`extract`) presence                      | ran (tool-loop / direct)                                   |
| Feed enrich                 | `usage_log` (`enrich_feed_content`)                   | N enriched                                                 |
| Classify                    | `usage_log` (`classify_marketing`) + suppressed count | N suppressed                                               |
| Upsert                      | `fetch_log.releasesFound/Inserted`                    | found N · +M                                               |
| Summarize                   | `usage_log` (`summarize`)                             | N rows                                                     |
| Embed / Changelog / Publish | — (Axiom-only today)                                  | "fired" best-effort or "unknown"                           |
| Run total                   | `fetch_log.durationMs`                                | single number (no per-stage ms)                            |

**Phase 1 gets:** full adaptive topology, live state (scheduled/backed-off/paused/starved, next due, change-detect health), per-run outcome + counts, which AI passes ran (+ token cost), a last-10 sparkline.
**Phase 1 misses:** per-stage durations (waterfall); embed/changelog/publish outcomes (not in D1).

## Phase 2 — per-stage instrumentation (documented, not built now)

Add per-stage spans so every node gets a real duration and the async tail gets true outcomes. Two storage options (decide at Phase 2 start):

- **`fetch_log_stages` table** — one row per (fetchLogId, stageKey) with `durationMs`, `status`, `detail`. Normalized; queryable; more rows.
- **`stages` JSON column on `fetch_log`** — array of `{key, durationMs, status}`. Fewer rows; opaque to SQL.

Written from the `poll-and-fetch` workflow's existing `step.do` boundaries (which already isolate poll / fetch-and-persist / embed / changelog / generate-content / publish). The drawer auto-upgrades from outcome-dots to a waterfall when stage rows exist; absence falls back to Phase 1 rendering. Requires a paired migration per the schema-gate rule. Mind D1's 100-bind limit if batch-inserting stage rows.

## Testing

- **`describeWorkflowStages`** — unit tests asserting the exact ordered stage list for every source type/flag combination (github, feed, feed+enrich, feed+marketingFilter, scrape, scrape+crawl, video, appstore, agent, firecrawl). This is the correctness-critical unit.
- **Status endpoint** — in-process worker route test (`routes.request(path, init, env)`) with a seeded test DB: asserts derived `lastRun`, `aiPasses`, `sparkline`, and that `stages` matches `describeWorkflowStages`. Fake Secrets Store as `{ get: async () => value }`.
- **Components** — render `workflow-pipeline` from fixtures: adaptive node sets, async-tail collapse/expand, error/no-change/backed-off states.
- Type-check (root + worker tsc), `bun test`, lint, format.

## Non-goals (v1 / Phase 1)

- No React Flow or any graph library; no per-stage timing; no horizontal node-graph.
- Not public-facing — stays behind the dev-only Fetch Log gating.
- No live streaming — one fetch of workflow state when the drawer opens (manual refresh ok).
- No editing from the drawer — priority/Firecrawl edits remain on the Fetch Plan row.

## Open items for spec review

1. Confirm the **appstore / agent / firecrawl / video / crawl** stage sets above (github/feed/scrape were confirmed against on-screen mockups).
2. History depth: Phase 1 shows the latest run + a last-10 sparkline. Clicking a sparkline bar to load _that_ run is deferred to Phase 2 (needs per-run stage data to be worth it). OK?
3. `aiPasses` correlation window: how tightly to bind `usage_log` rows to the last run (e.g. same `sourceId` within N minutes of `lastRun.createdAt`).
