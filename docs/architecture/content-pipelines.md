# Content pipelines

A map of every routine or scheduled AI-content job — org overview regeneration, batch summarization, feed enrichment, and the rest — grown one at a time and now scattered across `remote-mode.md`, `web.md`, `feature-flags.md`, `ingest.md`, and AGENTS.md one-liners. This page answers "where is X managed, when does it run, what model does it use, how do I trigger it manually?" in one place instead of four; each row still links to the doc that owns the detail (#1896).

## Summary table

| Pipeline                             | Schedule                                       | Gate                                                                 | Model lane                                                            | Manual trigger                                                        |
| ------------------------------------ | ---------------------------------------------- | -------------------------------------------------------------------- | --------------------------------------------------------------------- | --------------------------------------------------------------------- |
| Org overview regen                   | Daily `0 8 * * *` (08:00 UTC), per-org cadence | `overview-regen-enabled` + per-org cadence (`overview_cadence_days`) | OpenRouter `SUMMARIZE_MODEL` (Anthropic Haiku fallback)               | `POST /v1/workflows/overview-regen`                                   |
| Batch summarize (title/summary)      | Daily `30 4 * * *` (04:30 UTC)                 | `batch-summarize-enabled`                                            | Anthropic Message Batches, `claude-haiku-4-5`                         | `POST /v1/workflows/batch-summarize`                                  |
| Batch feed-enrich                    | None (admin-only)                              | none (`BATCH_ENRICH_ENABLED` reserved, unused)                       | Anthropic Message Batches (article extraction)                        | `POST /v1/workflows/batch-enrich`                                     |
| Ingest-time release-content summary  | Ingest-time (every fetch)                      | none — always runs                                                   | Anthropic Haiku (`claude-haiku-4-5`)                                  | `scripts/generate-release-content.ts`                                 |
| Ingest-time marketing classifier     | Ingest-time (per source, opt-in)               | per-source `metadata.marketingFilter = true`                         | Anthropic Haiku 4.5                                                   | n/a (runs inline during fetch)                                        |
| Ingest-time feed enrichment          | Ingest-time (thin summary-only feed items)     | `FEED_ENRICH_ENABLED`                                                | OpenRouter `FEED_ENRICH_MODEL` (deepseek-v4-flash) or Anthropic Haiku | `POST /v1/workflows/enrich-feed-content`                              |
| Collection daily summaries           | Daily `15 6 * * *` (06:15 UTC)                 | per-collection `collections.daily_summary_enabled` (default true)    | shared summarization lane (`SUMMARIZE_MODEL` + Haiku fallback)        | `POST /v1/workflows/collection-summaries`                             |
| Digest emails (daily/weekly)         | Daily `0 13 * * *`; weekly `0 13 * * MON`      | none                                                                 | n/a — templated, no AI                                                | `POST /v1/admin/digest/test`                                          |
| Batch org overview (dormant)         | None — no cron dispatches it                   | `batch-overview-enabled` (flag exists, unused by any cron)           | n/a — retirement tracked in #1897                                     | `POST /v1/workflows/batch-overview`                                   |
| Local Claude Code skills (on demand) | On demand                                      | none — human/agent invoked                                           | Claude Code subscription (no metered API spend)                       | `maintaining-orgs` / `regenerating-overviews` / `local-ingest` skills |

## Pipelines

**Org overview regen.** `OverviewRegenWorkflow` fires daily but each org's effective cadence — 7-day default, 2-day fast tier for high-velocity orgs, or a per-org `overview_cadence_days` override — decides who actually regenerates that day. See [web.md → Automated regeneration](web.md).

**Batch summarize.** Backfills `title_generated` / `title_short` / `summary` for releases the ingest-time pass missed, via the Anthropic Message Batches API. The cron self-gates on the flag; the admin trigger runs unconditionally. See [ingest.md](ingest.md) for the `release-content` pass this pipeline shares its model/prompt with.

**Batch feed-enrich.** Async sibling of the synchronous ingest-time feed enrichment, for render-heavy/JS-shell sources the synchronous route can't finish before a client disconnect. No cron path exists yet — `BATCH_ENRICH_ENABLED` is a reserved var, not a live gate. See [ingest.md → Feed enrichment](ingest.md).

**Ingest-time passes (summary, marketing classifier, feed enrichment).** Three cheap AI passes run between parse and insert on every fetch — generated titles/summaries, a marketing-vs-product classifier (opt-in per source), and thin-feed article extraction. See [ingest.md](ingest.md) for the full pipeline and each pass's model/cap details.

**Collection daily summaries.** One row per (collection, closed ET day) — title, one-line summary, bullet takeaways — generated nightly over the shared summarization lane, distinguished only by `generationName` in usage tracking. See [web.md → Collection daily summaries](web.md).

**Digest emails.** Daily and weekly follows-based digests, both firing at 13:00 UTC (Mondays trigger both). Purely templated — no AI generation involved. See [web.md → Admin hub](web.md) for the preview/test routes.

**Batch org overview (dormant).** `BatchOverviewWorkflow` and its `batch-overview-enabled` flag still exist in code but no cron dispatches them — superseded by the per-org-cadence `OverviewRegenWorkflow`. Retirement tracked in #1897.

**Local Claude Code skills.** The on-demand lane: `maintaining-orgs` (fetch + regen sweep), `regenerating-overviews` (single-org regen), and `local-ingest` / the backfill workflows run overview/summary/extraction work on the operator's Claude Code subscription instead of the metered Anthropic API. See [local-ingest.md](local-ingest.md) and [maintenance-workspace.md](maintenance-workspace.md).
