---
name: firecrawl-monitoring
description: >
  Put a challenge-blocked or unreliable scrape source on the external
  Firecrawl monitoring backend, or triage one that's already on it. Use when
  a page sits behind a bot challenge our Browser Rendering can't clear, when
  render keeps returning an empty shell, when enabling/disabling/tuning a
  monitor, or when a Firecrawl-backed source went quiet or ingested wrong
  content. Operator skill; requires admin API access and prod-only Firecrawl
  bindings.
---

# Firecrawl Monitoring

Firecrawl is an **external fetch + change-detection backend** for `scrape` sources our own pipeline can't reach: Firecrawl scrapes the page on a schedule (its proxies clear the anti-bot challenge), diffs each check, runs an AI meaningfulness judge, and POSTs us a webhook that becomes a release. Full architecture: `docs/architecture/firecrawl-monitoring.md`.

It is **not a new source type** — it's a per-source toggle on an existing `scrape` source, stored under `source.metadata.firecrawl`. `source.url` stays the human-readable page.

**Prod-only.** The Firecrawl bindings exist only in production (staging shares prod's Secrets Store, so a staging sync would mutate prod monitors — never add the bindings to `[env.staging]`).

## When to use it

- The page is behind a **Cloudflare Managed Challenge** (or similar) that our Browser Rendering can't clear — render "succeeds" with a challenge shell, `no_change` / 0 releases on a page that's clearly updating.
- A client-rendered page keeps failing the render path and there's **no feed, no `.md` view, no GitHub source** (`finding-changelogs` exhausted its ladder).

**When NOT to use it:**

- A feed/GitHub/plain-scrape source that works — Firecrawl costs credits per check; the in-repo pipeline is free.
- First resort on a rendering hiccup. Run the render dry-run first (`releases source fetch <source> --dry-run`) — a populated candidate count means the normal pipeline can see the page and something else is wrong.
- Staging, or any environment without the prod bindings.

## Enabling a monitor

```bash
# scrape monitor (default) — watches ONE multi-entry index page
curl -sS -X POST "$RELEASES_API_URL/v1/sources/<src_…>/firecrawl/sync" \
  -H "Authorization: Bearer $RELEASES_API_KEY" -H "Content-Type: application/json" \
  -d '{ "enabled": true }'

# crawl monitor — index that links to a separate page per entry
# (replit /updates, docker-desktop, langfuse, resend, …): same command with
#   -d '{ "enabled": true, "target": "crawl" }'
```

Body: `{ enabled, schedule?, proxy?: "auto"|"basic"|"stealth"|"enhanced", goal?, target?: "scrape"|"crawl" }`. Takes a typed `src_…` id. Defaults: schedule `every 6 hours`, proxy `auto`, a generic release-detection `goal`. Enabling creates the monitor and stamps `monitorId` onto `metadata.firecrawl`; **disabling (`enabled: false`) deletes it**.

Traps that bite here:

- **Create vs. update is asymmetric — the dashboard is authoritative after create.** A later `sync` reconciles only the app-owned webhook; `schedule`/`proxy`/`goal`/`targets` tuned in the Firecrawl dashboard stick and are never reverted. Don't expect a re-sync to change cadence — change it in the dashboard, or disable + re-enable.
- **Switching scrape↔crawl is not a PATCH.** Disable (deletes the monitor), then re-enable with the new `target`.
- **Crawl monitors on sources with existing crawl-ingested history:** dry-run first and diff the produced per-page URLs against stored `releases[].url` (`GET /v1/orgs/<org>/sources/<slug>`) — both crawl backends must agree on the exact canonical URL string (trailing slash, query params) or dedup misses and you double-ingest.
- **Crawl monitors cost a full crawl per check.** Keep the cadence slow (24h default) unless the source is high-velocity; crawl-option tuning (`limit`, `maxDiscoveryDepth`, `includePaths`, …) lives in `metadata.firecrawl.crawl` via `PATCH /v1/sources/:id/metadata` — these are Firecrawl path-regexes, NOT the Cloudflare URL-globs the in-repo crawl adapter uses.
- **Poll-fetch exclusion is automatic.** A `firecrawl.enabled` source is dropped from the cron — don't also trigger manual fetches against it; you'd clobber monitor bookkeeping.

After enabling, record it in the org playbook (`managing-sources` rubric): the source is Firecrawl-backed, why (the blocker), the cadence, and the target type.

## Triage: a Firecrawl source went quiet

The staleness system already watches for this: `firecrawl-staleness` flags a `firecrawl.enabled` source whose `lastFetchedAt` exceeds `max(48h floor, 2× the monitor's live cadence)`, and flagged rows ride the daily operator staleness digest. When one lands:

1. **Check the monitor is alive** — Firecrawl dashboard, or `GET /v2/monitor/{monitorId}/checks` (read-only; `monitorId` is on `metadata.firecrawl`). NB: check-detail JSON can contain raw control characters — `jq` rejects it; parse leniently (Python `json.load(..., strict=False)`).
2. **Check Axiom** (`releases-cloudflare-logs`): `firecrawl-webhook` events (`enqueued`, `gate-skip`, `spawn-failed`), `firecrawl-ingest-workflow` (`ingested`, `credits-exhausted`, `auth-failed`, `ingest-failed`).
   - `credits-exhausted` (402) → the Firecrawl account is out of credits.
   - `auth-failed` (401/403) → key/secret drift.
   - No webhook events at all → the monitor stopped checking, or its webhook config drifted; re-run `sync { enabled: true }` (it reconciles the webhook and self-heals a deleted monitor via 404-recreate).
3. **`enqueued` with `path: "rescrape"` and `diffTextLen > 0`** is the fast-path-miss signal: the diff carried no extractable added lines and the workflow fell back to a paid full-page re-scrape. Occasional is fine; persistent means the diff shape changed — investigate before it burns credits.
4. Quiet because the page genuinely didn't change is fine — `same`/`removed`/`error` checks are no-ops by design, and the judge gate is fail-open (`changed` ingests unless the judge says non-meaningful).

## Triage: wrong or thin content ingested

- **The webhook carries a hunkless whole-document diff** — no `@@` hunk headers; every page line prefixed ` `/`+`/`-`. Parse added content ONLY via `addedContentFromDiff` (`packages/adapters/src/firecrawl-diff.ts`); never assume the documented unified-diff shape. (The original parser did, and silently returned `""` on every real change — #1262.)
- **Per-post fidelity is prompt selection**: crawl-target pages extract with the body-preserving `CRAWL_PAGE_SYSTEM_PROMPT` (verbatim bodies); scrape-target index pages use the summarizing prompt (condensing many entries is correct there). A residual condensation risk exists on the scrape path's full-page baseline; a stored row with a condensed body is healed by `POST /v1/workflows/refetch-release` (see `backfilling-sources` → media/refetch section) or, at worst, a manual D1 content fix per the doc.
- **Old history missing after onboarding** is expected — the baseline scrape is windowed to the newest ~10K tokens. Recover with the backfill machinery (`backfilling-sources`, or `POST /v1/workflows/backfill-source` with supplied markdown for arbitrary depth).

## Related

- **`finding-changelogs`** — exhaust the feed/GitHub/render ladder before reaching for Firecrawl.
- **`managing-sources`** — playbook rubric; add-and-pause as the alternative when Firecrawl isn't warranted.
- **`backfilling-sources`** — deep history recovery and single-release re-fetch for Firecrawl-backed sources.
- `docs/architecture/firecrawl-monitoring.md` — wire format, ingest workflow steps, redelivery semantics, config.
