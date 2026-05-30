# Fetch-strategy & interval panel on the org Fetch Log tab

**Date:** 2026-05-30
**Status:** Approved — ready for implementation plan

## Problem

The org page's **Fetch Log** tab (dev-only — `notFound` outside `NODE_ENV=development`)
shows a paginated list of individual fetch attempts, but nothing about _how_ or _how
often_ each source is fetched. When debugging ingest, you can't see at a glance that a
source runs "every 12 hours via Firecrawl" vs "every 4 hours via browser scrape."

This adds a per-source summary at the top of that tab — strategy, interval, and live
timing state — and inline controls to change the two fetch levers that have clean,
side-effect-correct write paths: **fetch priority/interval** and **Firecrawl**.

## How fetch behavior resolves today (grounding)

- **Interval** is driven by `source.fetchPriority` via `TIER_INTERVALS` in
  `workers/api/src/cron/poll-fetch.ts`: `normal` → every 4h, `low` → every 24h,
  `paused` → never polled. Smart-fetch backoff then pushes `source.nextFetchAfter`
  out (1h→48h on repeat no-change, up to 72h on errors); `queryDueSources` honors it.
- **Strategy** resolves from `source.type` + `metadata` (`packages/adapters/src/source-meta.ts`):
  GitHub API (`type:"github"` or `metadata.githubUrl`), RSS/Atom/JSON feed
  (`metadata.feedUrl`), App Store (`type:"appstore"`), video (`type:"video"`),
  multi-page crawl (`metadata.crawlEnabled`), browser scrape / agent extraction
  (`type:"scrape"|"agent"` with no feed), or **Firecrawl** (`metadata.firecrawl.enabled`).
- **Firecrawl** sources are _excluded_ from the poll cron (`notFirecrawl` predicate in
  `queryDueSources`) and run on their own `metadata.firecrawl.schedule` (default
  "every 6 hours"), ingested via the inbound webhook + workflow.
- **Provisioning a Firecrawl monitor** is NOT a raw metadata write. `POST
/v1/sources/:id/firecrawl/sync` (`workers/api/src/routes/firecrawl.ts`) merges
  `{enabled,schedule,proxy,goal}` into `metadata.firecrawl` _and_ creates the external
  monitor on enable / deletes it on disable, with orphan-compensation. The edit feature
  must use this route for the Firecrawl toggle.
- **Existing write paths the edit feature reuses:** `PATCH
/v1/orgs/:orgSlug/sources/:sourceSlug { fetchPriority }`; server-action plumbing in
  `web/src/app/actions/source-admin.ts` (`adminActionEnv()` + admin Bearer secret).

## Design

### 1. Shared resolver — `packages/adapters/src/fetch-plan.ts` (new, pure / worker-safe)

Single source of truth for strategy + interval, shared between the new endpoint and the
poll cron.

- Move `TIER_INTERVALS` here from `poll-fetch.ts`; re-import it back into `poll-fetch.ts`
  so the displayed interval can never drift from the cron's real cadence. Also centralize
  the Firecrawl default-schedule string (`"every 6 hours"`).
- `describeFetchPlan(source: Source): FetchPlan` where
  ```ts
  type FetchStrategy =
    | "github"
    | "feed"
    | "appstore"
    | "video"
    | "crawl"
    | "scrape"
    | "agent"
    | "firecrawl";
  interface FetchPlan {
    strategy: FetchStrategy;
    strategyLabel: string; // "GitHub API", "RSS feed", "Browser scrape", "Firecrawl", …
    intervalHours: number | null; // null for firecrawl (external cadence) and paused
    intervalLabel: string; // "every 4 hours", "every 6 hours (Firecrawl)", "paused"
    cadence: "poll" | "firecrawl-webhook";
    paused: boolean;
    firecrawlSchedule?: string; // present when strategy === "firecrawl"
  }
  ```
  Strategy precedence mirrors `queryDueSources` / the fetch dispatcher exactly:
  `firecrawl.enabled` → GitHub (`isGitHubFetched`) → appstore → video → feed (`feedUrl`)
  → crawl (`crawlEnabled`) → scrape / agent. Feed label refines by `feedType`
  (RSS/Atom/JSON Feed) when available.
- `computeFetchState(source: Source, now: Date): FetchState` where
  ```ts
  interface FetchState {
    lastPolledAt: string | null;
    nextDueAt: string | null; // null for firecrawl & paused
    backedOff: boolean; // nextFetchAfter pushes next poll past the tier interval
    paused: boolean;
  }
  ```
  Poll sources: `nextDue = max(lastPolledAt + intervalHours, nextFetchAfter)`;
  `backedOff = nextFetchAfter > lastPolledAt + intervalHours`. Firecrawl: `nextDueAt: null`
  (webhook-driven, surfaced as "webhook" in the UI). Paused: `nextDueAt: null`.
- Unit tests (`fetch-plan.test.ts`) cover every strategy branch plus
  backoff / paused / firecrawl state.

### 2. Worker endpoint — `workers/api/src/routes/status.ts`

`GET /status/fetch-plan?org=<slug>`, `hide: hideInProduction` (sibling of the existing
dev-only `/status/fetch-log`). Resolves the org slug, queries its sources, maps each
through `describeFetchPlan` + `computeFetchState` with a single `now`, returns:

```ts
interface FetchPlanRow {
  id: string; // typed src_… id, needed for the firecrawl-sync call
  slug: string;
  name: string;
  type: string;
  plan: FetchPlan;
  state: FetchState;
}
interface FetchPlanResponse {
  sources: FetchPlanRow[];
}
```

Sorted by name. No pagination — an org's source count is small. An in-process worker
route test covers the response shape and one firecrawl + one paused row.

### 3. Wire schema — `packages/api-types`

Add `FetchPlanRow` / `FetchPlanResponse` (additive). Consumed by the web hook.

### 4. Web — summary panel above the log

- `web/src/components/use-fetch-plan.ts` — hook that fetches
  `/api/proxy/status/fetch-plan?org=<slug>` (same proxy pattern as `use-fetch-log.ts`),
  exposing `{ rows, loading, error, refetch }`.
- `web/src/components/org-fetch-plan-panel.tsx` (client) — renders the per-source table:
  **Source · Strategy · Interval · Last poll · Next due**, with a `backed off` / `paused`
  badge in the Next-due column. Loading / error / empty states mirror `OrgFetchLogView`.
  Inline edit controls live here (section 5).
- `OrgFetchLogView` renders `<OrgFetchPlanPanel orgSlug={…} />` above `<FetchLogList />`.

### 5. Inline edit controls — `web/src/app/actions/source-admin.ts`

- `setFetchPriorityAction({ orgSlug, sourceSlug, priority })` →
  `PATCH /v1/orgs/:orgSlug/sources/:sourceSlug { fetchPriority }`. UI: a dropdown per
  row — **normal (4h) / low (24h) / paused**. On success, `revalidate` + panel `refetch()`.
- `syncFirecrawlAction({ sourceId, enabled, schedule? })` →
  `POST /v1/sources/:sourceId/firecrawl/sync`. UI: a toggle + optional schedule field.
  **Guarded by a confirm step** — enabling provisions a real external monitor that bills
  Firecrawl credits. Button disabled while in-flight; errors shown inline.

Both actions return the existing `ActionResult` shape (`{ ok: true } | { ok: false; error }`).

### Deliberately deferred (YAGNI)

Editing `githubUrl`, `feedUrl`, `crawlEnabled`, `extractStrategy` — these are _displayed_
(strategy label reflects them) but not editable in v1. They either change the strategy
class entirely or need extra fields (crawl patterns); a follow-up can add them. The two
levers shipping here are the high-value ones with clean, side-effect-correct write paths.

## Data flow

```
org Fetch Log tab (dev-only)
  └─ OrgFetchLogView
       ├─ OrgFetchPlanPanel ──fetch──▶ /api/proxy/status/fetch-plan?org=slug
       │                                  └─▶ worker GET /status/fetch-plan
       │                                        └─ query org sources
       │                                        └─ describeFetchPlan + computeFetchState
       │                                        └─ FetchPlanResponse
       │   edit control ──server action──▶ PATCH …/sources/:slug { fetchPriority }
       │                              └──▶ POST …/sources/:id/firecrawl/sync
       │   on success ──▶ panel refetch()
       └─ FetchLogList (unchanged)
```

## Error handling

- Panel: loading / error / empty states, mirroring `OrgFetchLogView`.
- Edit actions: return `ActionResult`; surface `error` inline; disable the control while
  in-flight; `refetch()` the panel on success.
- Firecrawl toggle: confirm before enabling; the sync route's own orphan-compensation
  handles a mint-then-persist-fail; a `500 {api_key_unbound|webhook_secret_unbound}`
  surfaces as the action error string.

## Testing

- **Unit** — `fetch-plan.test.ts`: each strategy branch, interval labels, backoff /
  paused / firecrawl state.
- **Worker route** — in-process `/status/fetch-plan` test (firecrawl + paused rows).
- **Gates** — `npx tsc --noEmit` (root + api worker), `bun test`, `bun run lint`,
  `bun run format:check`.
- **Manual** — `dev:web` + `dev:api`; open an org's Fetch Log tab; verify the panel;
  flip a source's priority and confirm the interval/next-due updates; exercise the
  Firecrawl toggle against staging (or with the confirm guard) and confirm the monitor
  syncs.

## Scope guard

The tab is already `notFound` outside dev; the new endpoint is `hideInProduction`; the
edit routes are admin-Bearer gated. This stays a dev / operator surface — no public
exposure of fetch internals or write paths.

## Files

**New**

- `packages/adapters/src/fetch-plan.ts`
- `packages/adapters/src/fetch-plan.test.ts`
- `web/src/components/use-fetch-plan.ts`
- `web/src/components/org-fetch-plan-panel.tsx`

**Modified**

- `workers/api/src/cron/poll-fetch.ts` (import `TIER_INTERVALS` from adapters)
- `workers/api/src/routes/status.ts` (+ `GET /status/fetch-plan`)
- `workers/api/test/…` (+ route test)
- `packages/api-types/src/…` (+ `FetchPlanRow` / `FetchPlanResponse`)
- `web/src/app/actions/source-admin.ts` (+ two actions)
- `web/src/components/org-fetch-log-view.tsx` (mount the panel)
- `packages/adapters/package.json` (add `"./fetch-plan": "./src/fetch-plan.ts"` — the
  package uses per-module subpath exports, not a barrel `index.ts`)
