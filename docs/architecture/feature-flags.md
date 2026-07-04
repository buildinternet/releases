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

Default = current prod value. Note the polarity split: `*-enabled` flags are **off** at
`false`; `*-disabled` flags are kill switches, so `false` means the feature is **on**.

### Enabled in prod (default `true`)

| Flag key                  | Default | What it controls                                                                                        |
| ------------------------- | ------- | ------------------------------------------------------------------------------------------------------- |
| `batch-summarize-enabled` | `true`  | Post-ingest batch auto-summarize (Haiku title/short-title/summary generation).                          |
| `feed-enrich-enabled`     | `true`  | Enriches summary-only feed items by fetching the linked page and extracting full content before insert. |
| `web-bot-auth-enabled`    | `true`  | Signs outbound fetches with RFC 9421 Web Bot Auth signatures.                                           |

### Disabled in prod (default `false`)

| Flag key                       | Default | What it controls                                                                                                                                                                                                                                                                                                                           |
| ------------------------------ | ------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `rate-limit-enabled`           | `false` | Public read-path rate limiting. Off = no limiting.                                                                                                                                                                                                                                                                                         |
| `invalidation-enabled`         | `false` | Cache-invalidation workflow. Off = not running.                                                                                                                                                                                                                                                                                            |
| `batch-overview-enabled`       | `false` | Batch org-overview (AI knowledge-page) generation workflow. Off = manual/agent-driven only.                                                                                                                                                                                                                                                |
| `extract-toolloop-enabled`     | `false` | Multi-round tool-use extraction path for large bodies (>50K tokens). Off = one-shot inline extraction only.                                                                                                                                                                                                                                |
| `raw-snapshot-capture-enabled` | `false` | Steady-state scrape path captures the scraped markdown as a raw snapshot (#1283) for cheap re-extraction (#1284). Off = only deep-Firecrawl backfills + the Firecrawl webhook persist raw. Read by the **discovery worker** (`RAW_SNAPSHOT_CAPTURE_ENABLED`).                                                                              |
| `enable-ai-tools`              | `false` | Gates the MCP AI-generation tools. Off = those tools not exposed.                                                                                                                                                                                                                                                                          |
| `feedback-disabled`            | `false` | Kill switch for the feedback endpoints. `false` = feedback **enabled**.                                                                                                                                                                                                                                                                    |
| `recommendations-disabled`     | `false` | Kill switch for recommendations. `false` = recommendations **active**.                                                                                                                                                                                                                                                                     |
| `search-query-log-disabled`    | `false` | Kill switch for search-query logging (`search_queries` table). `false` = logging **active**.                                                                                                                                                                                                                                               |
| `api-tokens-disabled`          | `false` | Kill switch for scoped `relk_` API-token auth. `false` = tokens **active**.                                                                                                                                                                                                                                                                |
| `cache-disabled`               | `false` | Kill switch for `Cache-Control` response headers. `false` = caching **active**.                                                                                                                                                                                                                                                            |
| `ma-sessions-disabled`         | `false` | Incident kill switch for managed-agent discovery sessions. `false` = sessions **allowed**.                                                                                                                                                                                                                                                 |
| `indexing-disabled`            | `false` | When `true`, stamps `X-Robots-Tag: noindex` + `Disallow: /` (how staging is gated). `false` in prod = indexable.                                                                                                                                                                                                                           |
| `openrouter-enabled`           | `false` | Single switch for the secondary cheap-call AI lanes (marketing classifier, live summarizer, …). On = each lane that also has an OpenRouter model var set routes to OpenRouter; off = all stay on Anthropic Haiku. Per-lane control is the model var (empty → Anthropic).                                                                   |
| `deterministic-update-enabled` | `false` | Runs routine `POST /update` runs as a direct `scrapeFetch` loop instead of a Managed-Agents (Haiku) worker session (#1878) — the agent added nothing load-bearing but paid a ~19k-token cache-creation tax per session. On ⇒ no agent session; off ⇒ legacy agent path. Read by the **discovery worker** (`DETERMINISTIC_UPDATE_ENABLED`). |

## Adding a flag

Add a `FLAGS` registry entry, convert the read site to `await flag(...)`, and create the
same kebab-case key in **both** Flagship apps before relying on it. Numeric tunables (spend
caps, jitter window, search-ranking knobs) and secrets stay out of Flagship.
