# Feature flags (Cloudflare Flagship)

The 21 Tier-1 boolean operational flags (kill switches + rollout/rollback gates) are
evaluated at runtime through the `FLAGS` Flagship binding, with the wrangler var kept as
an automatic fallback. Evaluation order is **Flagship value → wrangler var (`=== "true"`)
→ hardcoded default**, failing open to the var on any error.

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

Default = current prod value. Note the polarity split: `*-enabled` flags are **off** at
`false`; `*-disabled` flags are kill switches, so `false` means the feature is **on**.

### Enabled in prod (default `true`)

| Flag key                       | Default | What it controls                                                                                                 |
| ------------------------------ | ------- | ---------------------------------------------------------------------------------------------------------------- |
| `poll-fetch-use-workflow`      | `true`  | Routes the hourly poll-and-fetch ingest through the Cloudflare Workflow path. Off = rollback to the inline cron. |
| `scrape-agent-use-workflow`    | `true`  | Routes the daily scrape-agent discovery sweep through the Workflow path. Off = inline cron.                      |
| `onboard-use-workflow`         | `true`  | Runs source onboarding through the Workflow path instead of inline.                                              |
| `scrape-change-detect-enabled` | `true`  | Content-hash change detection on scrape fetches — unchanged pages short-circuit instead of re-extracting.        |
| `batch-summarize-enabled`      | `true`  | Post-ingest batch auto-summarize (Haiku title/short-title/summary generation).                                   |
| `indexnow-enabled`             | `true`  | Submits new/updated release URLs to IndexNow for faster search-engine pickup.                                    |
| `feed-enrich-enabled`          | `true`  | Enriches summary-only feed items by fetching the linked page and extracting full content before insert.          |
| `web-bot-auth-enabled`         | `true`  | Signs outbound fetches with RFC 9421 Web Bot Auth signatures.                                                    |

### Disabled in prod (default `false`)

| Flag key                    | Default | What it controls                                                                                                 |
| --------------------------- | ------- | ---------------------------------------------------------------------------------------------------------------- |
| `rate-limit-enabled`        | `false` | Public read-path rate limiting. Off = no limiting.                                                               |
| `invalidation-enabled`      | `false` | Cache-invalidation workflow. Off = not running.                                                                  |
| `batch-overview-enabled`    | `false` | Batch org-overview (AI knowledge-page) generation workflow. Off = manual/agent-driven only.                      |
| `media-r2-upload-enabled`   | `false` | Mirrors release media to the R2 bucket at ingest. Off = third-party media URLs stored verbatim.                  |
| `extract-toolloop-enabled`  | `false` | Multi-round tool-use extraction path for large bodies (>50K tokens). Off = one-shot inline extraction only.      |
| `enable-ai-tools`           | `false` | Gates the MCP AI-generation tools. Off = those tools not exposed.                                                |
| `feedback-disabled`         | `false` | Kill switch for the feedback endpoints. `false` = feedback **enabled**.                                          |
| `recommendations-disabled`  | `false` | Kill switch for recommendations. `false` = recommendations **active**.                                           |
| `search-query-log-disabled` | `false` | Kill switch for search-query logging (`search_queries` table). `false` = logging **active**.                     |
| `api-tokens-disabled`       | `false` | Kill switch for scoped `relk_` API-token auth. `false` = tokens **active**.                                      |
| `cache-disabled`            | `false` | Kill switch for `Cache-Control` response headers. `false` = caching **active**.                                  |
| `ma-sessions-disabled`      | `false` | Incident kill switch for managed-agent discovery sessions. `false` = sessions **allowed**.                       |
| `indexing-disabled`         | `false` | When `true`, stamps `X-Robots-Tag: noindex` + `Disallow: /` (how staging is gated). `false` in prod = indexable. |

## Adding a flag

Add a `FLAGS` registry entry, convert the read site to `await flag(...)`, and create the
same kebab-case key in **both** Flagship apps before relying on it. Numeric tunables (spend
caps, jitter window, search-ranking knobs) and secrets stay out of Flagship.
