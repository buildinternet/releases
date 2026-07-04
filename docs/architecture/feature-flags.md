# Feature flags (Cloudflare Flagship)

Runtime on/off switches — kill switches and rollout gates that operators can flip from the Cloudflare dashboard without a deploy. Before adding one, read the convention in AGENTS.md: **the default is no flag**; ship features enabled and reach for a flag only when you can name the kill-switch, staged-rollout, or operational need it serves.

Flags are boolean only (numeric tunables and secrets stay in wrangler vars / Secrets Store) and are evaluated at runtime through the `FLAGS` Flagship binding, with the wrangler var kept as an automatic fallback. Evaluation order is **Flagship value → wrangler var (`=== "true"`) → hardcoded default**, failing open to the var on any error.

- Registry + evaluator: `@releases/lib/flags` (`FLAGS` registry, `flag(binding, varValue, def)`).
- Apps (Flagship has no in-app environment concept, so prod and staging are separate apps):
  - Prod: `releases-platform` — `2cf02390-e39a-477a-91c1-571d07b987ef`
  - Staging: `releases-platform-staging` — `548a95f1-4f8c-402d-8aa2-1b861523d377`
- Design + plan: [`docs/superpowers/specs/2026-05-30-flagship-feature-flags-design.md`](../superpowers/specs/2026-05-30-flagship-feature-flags-design.md),
  [`docs/superpowers/plans/2026-05-30-flagship-feature-flags.md`](../superpowers/plans/2026-05-30-flagship-feature-flags.md).

## Dashboard setup

Flag management is **dashboard-only** in the current Flagship public beta — no REST API,
Terraform provider, or wrangler command. To take a flag live, create the key in **both**
apps with a default variation matching the **Default** column below (so creation is
behaviour-neutral), leave Flagship's per-flag **Enable flag** toggle on, then flip a
variation when you actually want to change behaviour. When a flag is disabled or absent in
Flagship, the client resolves the value passed to `getBooleanValue` — the wrangler var —
so nothing changes until a flag exists _and_ its variation diverges from the var.

## Flags

**This table is generated from the `FLAGS` registry (`@releases/lib/flags`) — do not
edit it by hand.** Run `bun run flags:docs` to regenerate after changing the registry;
a test fails if it's stale. Each flag is grouped by its `kind`:

- **Kill switches** are permanent operational levers (incident / rollback / mode toggles).
- **Rollout gates** are temporary — once one has been fully on (or off) in prod for a
  while, retire it (delete the flag + its dead branch). Un-retired rollout gates are the
  main source of sprawl.

`Default` is the **hardcoded last-resort fallback** — the value used only when Flagship is
unreachable _and_ the wrangler var is unset. It is **not** the live prod value: Flagship (or
the `env` var, which is the `key` in `UPPER_SNAKE_CASE`) overrides it at runtime, so check
the dashboard for what's actually on. Polarity: `*-enabled` flags are off at `false`;
`*-disabled` kill switches are on at `false`. `Reads` is the worker(s) that evaluate the flag.

<!-- BEGIN GENERATED FLAG TABLE (bun run flags:docs) -->

#### Kill switches — permanent operational levers

| Flag key                      | Default | Reads          | What it controls                                                                                                                                                                                             |
| ----------------------------- | ------- | -------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `api-tokens-disabled`         | `false` | api, mcp       | Kill switch for scoped `relk_` API-token auth. false = tokens active (static root key still works).                                                                                                          |
| `batch-summarize-enabled`     | `false` | api            | Post-ingest batch auto-summarize (Haiku title / short-title / summary).                                                                                                                                      |
| `cache-disabled`              | `false` | api            | Kill switch for `Cache-Control` response headers. false = caching active.                                                                                                                                    |
| `extract-toolloop-enabled`    | `true`  | discovery      | Multi-round tool-use extraction for large bodies (>50K tokens). Off = one-shot inline only.                                                                                                                  |
| `feed-enrich-enabled`         | `false` | api            | Enriches summary-only feed items by fetching the linked page and extracting full content before insert.                                                                                                      |
| `feedback-disabled`           | `false` | api            | Kill switch for the feedback endpoints. false = feedback enabled.                                                                                                                                            |
| `indexing-disabled`           | `false` | api, mcp       | Stamps `X-Robots-Tag: noindex` + `Disallow: /` (how staging is gated). false in prod = indexable.                                                                                                            |
| `ma-sessions-disabled`        | `false` | discovery      | Incident kill switch for managed-agent sessions. false = sessions allowed.                                                                                                                                   |
| `openrouter-enabled`          | `true`  | api, discovery | Single switch for the secondary cheap-call AI lanes (marketing classifier, summarizer, feed-enrich, large-body extract). On = lanes with an OpenRouter model var route to OpenRouter; off = Anthropic Haiku. |
| `rate-limit-enabled`          | `false` | api, mcp       | Public read-path rate limiting. Off = no limiting.                                                                                                                                                           |
| `recommendations-disabled`    | `false` | api            | Kill switch for recommendations. false = recommendations active.                                                                                                                                             |
| `scrape-title-dedup-disabled` | `false` | api            | Kill switch for scrape-source title dedup (#1410). false = dedup active.                                                                                                                                     |
| `search-query-log-disabled`   | `false` | api, mcp       | Kill switch for search-query logging (`search_queries` table). false = active.                                                                                                                               |
| `web-bot-auth-enabled`        | `false` | api, discovery | Signs outbound content fetches with RFC 9421 Web Bot Auth signatures.                                                                                                                                        |

#### Rollout gates — retire once fully rolled out

| Flag key                       | Default | Reads     | What it controls                                                                                                                                  |
| ------------------------------ | ------- | --------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| `backfill-workflow-enabled`    | `false` | api       | Durable resumable full-history backfill workflow (deep Firecrawl path). Off = inline backfill only.                                               |
| `batch-overview-enabled`       | `false` | api       | Batch org-overview (AI knowledge-page) generation workflow. Off = manual/agent-driven only.                                                       |
| `invalidation-enabled`         | `false` | api       | Cache-invalidation workflow. Off = not running.                                                                                                   |
| `media-gif-transcode-enabled`  | `false` | api       | Transcode uploaded/ingested GIFs to video. Off = store the GIF as-is.                                                                             |
| `oauth-client-reaper-enabled`  | `false` | api       | Stale OAuth-client reaper cron. Off = observe-only (log reapable candidates); on = delete abandoned DCR clients.                                  |
| `org-drain-actor-enabled`      | `false` | api       | Actor-native scrape/agent drain (OrgActor, #1777). On = actor path drives; off = the force-drain + scrape-agent-sweep crons run.                  |
| `overview-regen-enabled`       | `false` | api       | Automated weekly org-overview regeneration workflow (#1706). Off = manual/agent-driven only.                                                      |
| `raw-snapshot-capture-enabled` | `false` | discovery | Steady-state scrape path captures the scraped markdown as a raw snapshot (#1283) for cheap re-extraction (#1284).                                 |
| `user-api-keys-enabled`        | `false` | api, mcp  | Better Auth user-API-key (`relu_`) path — verification + self-serve creation. Separate from `api-tokens-disabled` (which kills both token lanes). |

<!-- END GENERATED FLAG TABLE -->

## Adding a flag

Add a `FLAGS` registry entry (all fields required: `key`, `env`, `default`, `kind`, `reads`,
`description`), convert the read site to `await flag(...)`, run `bun run flags:docs` to update
the table above, and create the same kebab-case key in **both** Flagship apps before relying
on it. Numeric tunables (spend caps, jitter window, search-ranking knobs) and secrets stay out
of Flagship.
