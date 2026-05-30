# Firecrawl Monitoring Integration — Design

**Date:** 2026-05-29
**Status:** Approved design, pre-implementation
**Author:** Zach Dunn (with Claude)

> **⚠️ Correction (2026-05-30, post-implementation).** Two assumptions in the diagrams below were wrong once tested against the live Firecrawl API:
>
> 1. The `monitor.page` webhook delivers a **diff, not markdown** — there is no `markdown` field in the payload. The flow diagrams here show `monitor.page { …, markdown, … }` and `extract(markdown)`; the implemented workflow extracts the diff delta and only re-scrapes the full page on a `new`/baseline event.
> 2. **`diff.text` is a hunkless whole-document diff** — no `@@` hunk headers, no `---`/`+++` file headers — not the textbook unified diff Firecrawl's docs imply. Parse it only via `addedContentFromDiff` (#1262).
>
> The living reference is **[docs/architecture/firecrawl-monitoring.md](../../architecture/firecrawl-monitoring.md)**; this document is kept as the historical design record.

## Problem

A curated set of high-value changelog sources — OpenAI release notes the canonical
example — cannot be ingested by our own fetch pipeline. They sit behind Cloudflare
managed challenges that our scrape adapter + Cloudflare Browser Rendering path cannot
clear (UA spoofing is a dead end; Web Bot Auth signing does **not** help because these
fail at the _render/challenge_ stage, not at direct fetch). Today these sources are
**paused** (5 OpenAI sources, plus others).

[Firecrawl monitoring](https://docs.firecrawl.dev/features/monitoring) is an external
service that runs recurring scrapes/crawls, diffs each result against the prior snapshot,
optionally judges whether a change is _meaningful_ against a natural-language goal, and
notifies via webhook or email. Its `enhanced`/`auto` proxy tier is designed for "complex
sites" and is our lever for clearing anti-bot protection where we currently fail.

## Goal

Use Firecrawl as an **external fetch + change-detection backend** for a curated,
opt-in set of hard-to-reach sources. Start narrow (the blocked sources), but build the
integration — metadata, webhook receiver, monitor lifecycle — so it scales to more
sources without rework.

### Non-goals

- Replacing our own fetch pipeline for sources we _can_ fetch. Firecrawl is opt-in per
  source, not a wholesale change-detection layer.
- A second extraction code path. Firecrawl supplies **markdown content**; our existing
  extract → dedup → insert → embed → summarize pipeline does the rest, so quality stays
  identical to every other source.
- Web admin-panel control in the first cut (deferred to Phase 3).

## Key decisions (locked during brainstorming)

1. **Scope:** Both — start narrow (blocked sources like OpenAI), design to scale.
2. **Firecrawl's role:** Supplies markdown content; we run it through our existing
   pipeline. Firecrawl's `judgment.meaningful` is used as a **cost gate** on whether to
   run our (paid) extraction — with a safety valve so it can never silently swallow a
   real release.
3. **Monitor lifecycle:** Admin-triggered create/sync/delete, but the helpers are
   **idempotent and keyed on a desired-state object** derived from `source.metadata`, so
   a reconcile sweep later is a thin loop over the same helper.
4. **Ingest wiring:** Receiver authenticates + validates + enqueues; a dedicated
   **`FirecrawlIngestWorkflow`** does extract/dedup/insert/embed as `step.do` boundaries
   (matches the `POLL_FETCH_USE_WORKFLOW` philosophy — each phase is an independent
   retry boundary).

## Architecture

```text
[Admin]  POST /v1/sources/:slug/firecrawl/sync { enabled, schedule?, proxy?, goal? }
   └─ merge into source.metadata.firecrawl
   └─ syncFirecrawlMonitor → Firecrawl POST/PUT/DELETE /v2/monitor
        spec: { url: source.url,
                schedule, proxy:"auto", goal, judgeEnabled:true,
                webhook:{ url: https://api.releases.sh/v1/integrations/firecrawl/webhook,
                          headers:{ "X-Firecrawl-Token": <FIRECRAWL_WEBHOOK_SECRET> },
                          metadata:{ sourceId },
                          events:["page"] } }
   └─ stamp monitorId → source.metadata.firecrawl

[Firecrawl, on schedule]  scrape (proxy auto clears anti-bot) → diff → judge(goal)
   └─ POST receiver:  monitor.page { url, status, markdown, diff, judgment, metadata:{ sourceId } }

[Receiver  POST /v1/integrations/firecrawl/webhook]
   └─ verify X-Firecrawl-Token (constant-time)
   └─ resolve metadata.sourceId → source  (unknown/disabled ⇒ 200 + log)
   └─ KV idempotency guard on (checkId + url)
   └─ GATE (see "Cost-gate safety valve")
   └─ spawn FirecrawlIngestWorkflow({ sourceId, url, markdown, checkId, status, judgment })
   └─ return 200 fast

[FirecrawlIngestWorkflow]
   load-source → extract(markdown)→RawRelease[] → dedup+insert
     → publish events + embed + Haiku summaries → bookkeep (fetch_log path="firecrawl")
```

A firecrawl-enabled source is **excluded from the normal poll-fetch cron** so we never
double-fetch (metadata gate in the eligibility predicate).

## Components

### A. Firecrawl client — `packages/adapters/src/firecrawl.ts`

Pure, runtime-neutral, worker-safe. Caller passes `{ apiKey, fetch? }`. No DB, no secrets
plumbing inside.

- `createMonitor(spec)`, `getMonitor(id)`, `updateMonitor(id, spec)`, `deleteMonitor(id)`,
  `runMonitor(id)` — wrap `/v2/monitor*`.
- `scrapeOnce(url, { proxy })` — wraps `/v2/scrape`; used for the **Phase 0 spike** and
  ad-hoc debugging only.
- Typed request/response shapes. `monitor.page` payload field names (`markdown` vs
  `content`, exact `judgment` shape) are **pinned against Firecrawl's events doc in
  Phase 2** — flagged as an open item below.

`packages/adapters/` is the right home: it is the pure, worker-safe adapter-primitives
package, and Firecrawl is conceptually a fetch backend.

### B. Desired-state + spec derivation

Extend `SourceMetadata` (`packages/adapters/src/source-meta.ts`):

```ts
firecrawl?: {
  enabled: boolean;          // opt-in master switch
  monitorId?: string;        // stamped after create; cleared on delete
  schedule?: string;         // cron or natural-language; default "every 6 hours"
  proxy?: "basic" | "enhanced" | "auto";  // default "auto"
  goal?: string;             // natural-language judge goal
  judgeEnabled?: boolean;    // default true; false = always extract (gate off)
  lastCheckId?: string;      // observability
  lastChangeAt?: string;     // observability (ISO)
};
```

`deriveMonitorSpec(source, { webhookUrl, webhookSecret }): FirecrawlMonitorSpec` — **pure**.
This is the heart of idempotency: it maps `source.url` + the metadata block into the exact
monitor config we want to exist. Reconcile = derive the spec, diff against the live monitor,
PUT only if changed.

**Defaults:** `schedule: "every 6 hours"` (changelogs don't move fast; a 6h cadence keeps
credit cost low — the 15-min minimum would be ~96 checks/day/source for no benefit),
`proxy: "auto"`, `judgeEnabled: true`, `goal:` a template such as _"Detect new product
releases, version announcements, or changelog entries on this page."_

### C. Sync helper + admin surface

- `syncFirecrawlMonitor(source, env) → { metadataPatch }`:
  - `enabled && !monitorId` → `createMonitor(spec)`, return patch stamping `monitorId`.
  - `enabled && monitorId` → derive spec, diff vs `getMonitor`, `updateMonitor` if changed.
  - `!enabled && monitorId` → `deleteMonitor`, return patch clearing `monitorId`.
  - Idempotent. A future reconcile job is a loop over all firecrawl-enabled sources calling
    this helper.
- `POST /v1/sources/:slug/firecrawl/sync { enabled, schedule?, proxy?, goal? }` —
  admin-gated (via the `adminRoutes` allowlist; resource-scoped action mirroring the
  existing `POST /v1/sources/:slug/fetch` precedent). Merges inputs into
  `metadata.firecrawl`, runs the helper, persists the returned patch. One endpoint does
  enable / change-interval / disable.
- CLI: `releases admin source firecrawl <enable|sync|disable> <slug> [--schedule …] [--proxy …]`
  (OSS CLI repo — out of tree).

### D. Inbound webhook receiver — `POST /v1/integrations/firecrawl/webhook`

- New route module `workers/api/src/routes/firecrawl-webhook.ts`.
- **Auth:** verify `X-Firecrawl-Token` header (constant-time compare vs
  `FIRECRAWL_WEBHOOK_SECRET`). The route is wired into `route-namespaces.ts` as its **own
  bucket** so it bypasses both the `adminRoutes` API-key gate and
  `publicReadAuthMiddleware` — it authenticates on its own header.
- **Routing:** resolve `payload.metadata.sourceId` (echoed by Firecrawl) → source. No
  monitorId lookup needed. Unknown or disabled source ⇒ **200 + log** (never 4xx — a
  permanently-bad mapping must not trigger Firecrawl retry storms).
- **Idempotency:** KV guard on `checkId + url` (short TTL) so Firecrawl retries don't
  double-spawn the Workflow. (Defense in depth — release dedup is already idempotent.)
- Apply the gate, spawn `FirecrawlIngestWorkflow`, return 200 fast.

### E. `FirecrawlIngestWorkflow`

Registered as a Workflow binding in `workers/api/wrangler.jsonc`. Steps (each a retry
boundary):

1. `load-source` — load source by id; bail if not found or not firecrawl-enabled.
2. `extract` — run markdown through `extractReleasesFromBody(source, markdown, env)` →
   `RawRelease[]`. Honors our existing extract tiers (one-shot vs toolloop for large bodies).
3. `dedup-insert` — dedup against existing URLs (`selectNewReleaseIndices`), insert via
   `RELEASE_URL_UPSERT`, return `insertedIds`.
4. `publish-embed-summarize` — `publishReleaseEvents` + `embedReleasesForSource` + Haiku
   content generation. Best-effort.
5. `bookkeep` — write `fetch_log` row (`path="firecrawl"`), update source counters
   (`lastFetchedAt`, clear backoff), stamp `metadata.firecrawl.lastCheckId`/`lastChangeAt`.

**Refactor:** lift `extractReleasesFromBody` plus the dedup/insert/publish/embed/summarize
tail out of `fetchOne` (`workers/api/src/cron/poll-fetch.ts`) into shared functions the
Workflow steps call. This touches the large `fetchOne`, but it is the correct seam — the
cron path calls the same helpers, so the two ingest paths cannot drift.

## Cost-gate safety valve

The gate decides only whether to **extract** (spend our Anthropic tokens). The markdown is
already in hand either way — Firecrawl did the fetch and diff.

| Firecrawl page `status` | Action                                                                                                                                                      |
| ----------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `new`                   | **Always extract.** A brand-new page/section is definitionally a real change; the judge can never suppress it.                                              |
| `changed`               | Extract iff `judgment.meaningful === true`. **Fail-open:** judge disabled, judgment absent/malformed, or low confidence ⇒ extract anyway.                   |
| `same`                  | Skip (no diff).                                                                                                                                             |
| `error`                 | Log + write an observability `fetch_log` error row. Do **not** trip our `consecutive_errors` backoff (that signal belongs to the cron path, not Firecrawl). |
| `removed`               | Log only for the narrow start — no delete/suppress on a page-gone signal (too risky early).                                                                 |

**No silent skips.** Every skip is logged with `sourceId/url/checkId/confidence`
(`logEvent` component `firecrawl-webhook`, event e.g. `gate-skip-not-meaningful`) so a
suspected over-filtering judge is queryable in Axiom. This is the "no silent caps"
principle; it directly answers the prior live regression where title-filtering silently
dropped real releases.

**Kill switch:** per-source `metadata.firecrawl.judgeEnabled = false` turns the gate off
(always extract). `runMonitor(id)` forces a re-check.

## Secrets & environment

Two secrets, both bound via Secrets Store in `workers/api/wrangler.jsonc`:

- `FIRECRAWL_API_KEY` — already present in root `.env` + CF Secrets Store. Used only by
  the sync helper for monitor management (`/v2/monitor*`).
- `FIRECRAWL_WEBHOOK_SECRET` — **new.** A random secret we generate, store in CF Secrets
  Store, and set on every monitor's webhook `headers["X-Firecrawl-Token"]` at create time;
  the receiver constant-time compares against it.

The wrangler.jsonc **bindings** are added in-repo. The actual secret **values** are added
to CF Secrets Store by the user (per the global rule: never edit `.env` directly; the user
manages secret material).

The secret lives in the header, not the URL, so it does not leak via logs or referrers.
`metadata.sourceId` is a routing key, not a credential — a valid token is required
regardless of the sourceId supplied.

## Error handling

- Receiver auth failure → 401 + log.
- Unknown / disabled source, malformed payload → 200 + log (no retry storms).
- Workflow step failure → native step retry; terminal failure leaves source state
  untouched, so the next scheduled check re-delivers (dedup makes re-delivery safe — no
  partial-insert corruption).
- Firecrawl scrape `error` status → observability row only; no backoff impact.

## Observability

- `fetch_log` rows tagged `path="firecrawl"` so existing cron-runs / fetch-log admin
  surfaces include Firecrawl ingests alongside cron fetches.
- `logEvent` components: `firecrawl-sync` (monitor lifecycle), `firecrawl-webhook`
  (receiver + gate decisions), `firecrawl-ingest-workflow` (per step). Kebab-case events.
- `metadata.firecrawl.lastCheckId` / `lastChangeAt` stamped per processed webhook for
  at-a-glance source state.

## Interaction with the existing fetch pipeline

Add `!metadata.firecrawl?.enabled` to the poll-fetch cron eligibility predicate
(`pollAndFetch`). A firecrawl-owned source keeps its `type` (e.g. `scrape`) and
`fetchPriority: normal` — ownership is expressed via metadata only. We deliberately do
**not** use `fetchPriority: "paused"`, which stops the on-demand path too and reads as
"given up." This is the same "wire the new path into every fetch-eligibility gate" lesson
from the App Store source-type work (#1160).

## Testing

- **Unit:** Firecrawl client (mock `fetch`); `deriveMonitorSpec` idempotency (same input →
  same spec, metadata change → diff); receiver auth (good/bad/missing token); gate matrix
  (`new` / `changed`×{meaningful, absent, low-confidence} / `same` / `error` / `removed`);
  `extractReleasesFromBody`.
- **In-process worker route smoke:** `routes.request(path, init, env)` with a fake Secrets
  Store (`{ get: async () => value }`) for the receiver → spawn path.
- **Phase 0 spike:** manual (real Firecrawl call, costs credits) — not automated.

## Phasing

- **Phase 0 — premise spike (gates the whole project):** one manual
  `scrapeOnce(openaiUrl, { proxy: "auto" })`; confirm we get real content, not a challenge
  page. If Firecrawl is _also_ blocked → stop and reassess (try `enhanced`, or conclude
  Firecrawl can't reach it either).
- **Phase 1 — monitor management:** client + `deriveMonitorSpec` + sync helper + admin
  route + CLI + secrets/wrangler wiring. Onboard OpenAI by hand; verify a monitor exists
  and fires (`runMonitor`).
- **Phase 2 — ingest:** receiver + `FirecrawlIngestWorkflow` + the `fetchOne` extract
  refactor + poll-fetch exclusion. End-to-end on OpenAI: Firecrawl change → webhook →
  Workflow → release rows.
- **Phase 3 — scale (deferred):** reconcile sweep job; onboard the other paused/blocked
  sources; **web admin-panel control** (toggle Firecrawl per source, view/edit schedule &
  proxy/goal — a thin client over the same sync endpoint); per-source webhook secrets if
  revocation granularity is ever needed; a small dashboard.

## Open risks / things to validate

1. **Firecrawl clearing CF managed challenge** — ✅ **RESOLVED (2026-05-29 spike).**
   `POST /v2/scrape { url: help.openai.com/.../chatgpt-release-notes, formats:["markdown"],
proxy:"auto" }` returned HTTP 200 / `success:true`, page `statusCode:200`, title
   "ChatGPT — Release Notes | OpenAI Help Center", and **155,598 chars** of current
   markdown (dated entries, "Updated: 26 minutes ago") in 650ms. The premise holds for the
   OpenAI sources. `proxy:"auto"` was sufficient and fast — actual per-check credit cost
   should be observed once a real monitor runs (it may land on the cheaper `basic` tier
   rather than `enhanced`).
2. **Exact `monitor.page` payload field names** (`markdown` vs `content`, `judgment`
   shape, `checkId` location) — pinned against Firecrawl's events doc in Phase 2; the
   client types are finalized then.
3. **Credit cost at scale** — `enhanced` proxy is 5 credits/check; at a 6h cadence that is
   ~20 checks/day/source × 5 = ~100 credits/day/source. Fine for a handful; revisit before
   broad rollout.
4. **Whole-page re-extraction tokens** — we re-extract the full page markdown on each
   meaningful change (dedup drops already-seen rows). Bounded by the judgment gate + our
   existing extract-tier toolloop for large bodies.

## Catalog & credit dimensioning (prod snapshot 2026-05-29)

How broadly Firecrawl helps, and what it costs. Pulled from the live prod catalog
(317 sources). The benefit is narrow by design — GitHub / RSS-feed / App Store sources
are free and easy to fetch ourselves, so Firecrawl only earns its keep on hard `scrape`
(and the lone `agent`) sources.

**Catalog composition:**

| Type       | Count     | Firecrawl benefit                |
| ---------- | --------- | -------------------------------- |
| `github`   | 194 (61%) | none — GitHub API                |
| `scrape`   | 57 (18%)  | only the hard subset (see below) |
| `feed`     | 55 (17%)  | none — RSS/Atom/JSON             |
| `appstore` | 10 (3%)   | none — iTunes API                |
| `agent`    | 1 (<1%)   | candidate                        |
| **Total**  | **317**   |                                  |

**Beneficiary tiers:**

- **Conservative (build for this): ~14 sources** — the set our own pipeline genuinely
  cannot handle: 11 paused `scrape` sources without a discovered feed (5× `help.openai.com`
  release-note pages + chatgpt-macos, x.ai/news, perplexity, amplitude, firebase, replit),
  2 active render-required (fly.io, granola), 1 `agent` (posthog). Six share the
  `help.openai.com` domain — the clearest immediate win.
- **Upper bound: ~50 sources** — every `scrape` source without a feed (includes the 9
  already on Cloudflare crawl that work today but could move).
- **Zero benefit: 259 sources** — GitHub / feed / App Store.

**Credit model.** `credits/month = sources × checks_per_month × credits_per_check`, where
`checks_per_month = 30 × 24 / cadence_hours` (daily = 30, every-12h = 60, every-6h = 120).
Change-judging adds ~1 credit per _changed_ page (only fires on real changes — a few per
month per source), negligible against per-check cost. Table assumes `enhanced` proxy
(5 cr/check), the safe worst case for anti-bot sources:

| Sources           | Daily (30) | Every 12h (60) | Every 6h (120) |
| ----------------- | ---------- | -------------- | -------------- |
| 14 (conservative) | **~2,100** | 4,200          | 8,400          |
| 50 (upper bound)  | ~7,500     | 15,000         | 30,000         |
| 100 (growth)      | ~15,000    | 30,000         | 60,000         |

**Marginal cost per added source:** ~150 cr/mo (daily, `enhanced`) down to ~30 cr/mo if a
source clears on `basic`. The Phase 0 OpenAI spike cleared on `proxy:"auto"` in 650ms,
which suggests several of these may land on the cheaper tier — so the conservative
**~2,100 credits/month** at a daily cadence is a ceiling, not a floor, for the starter set.

**Recommended planning number:** daily cadence, conservative 14-source set ≈ **2,100
credits/month**; expanding to the full ~50-source upper bound ≈ **7,500 credits/month**.
