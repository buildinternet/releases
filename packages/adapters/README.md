# @releases/adapters

Fetch-adapter primitives and the per-source adapters (GitHub, Cloudflare render, crawl, feed, App Store, Firecrawl), plus the shared scrape/agent extraction orchestration. All pure / worker-safe.

## Exports

Imported as `@releases/adapters/<subpath>`.

| Subpath                | Purpose                                                                                          |
| ---------------------- | ------------------------------------------------------------------------------------------------ |
| `types`                | Shared `RawRelease` / `Adapter` / `FetchOptions` / `FetchResult` types every adapter implements. |
| `source-meta`          | `SourceMetadata` shape and helpers (`getSourceMeta`, `isGitHubFetched`).                         |
| `fetch-plan`           | Pure resolver for how/how often a source is fetched (tier intervals, Firecrawl cadence).         |
| `workflow-stages`      | Pure resolver for which ingestion-pipeline stages apply to a source, in order.                   |
| `user-agent`           | The bot user-agent string used on every outbound fetch.                                          |
| `content-hash`         | Content hash for dedup / change-detection on a `RawRelease`.                                     |
| `github`               | GitHub releases + CHANGELOG-file fetch adapter.                                                  |
| `github-discovery`     | Worker-safe planner for GitHub CHANGELOG path discovery (no fetch, no DB writes).                |
| `cloudflare`           | Cloudflare Browser Rendering fetch (content/markdown render of a page).                          |
| `cf-challenge`         | Pure detector for Cloudflare challenge interstitials in rendered output.                         |
| `crawl`                | Cloudflare `/crawl` multi-page changelog job (start + poll).                                     |
| `appstore`             | iTunes Lookup API adapter for App Store release notes.                                           |
| `app-links`            | Pure parsers for Apple App Site Association / Android Digital Asset Links files.                 |
| `feed`                 | RSS/Atom/JSON feed adapter (discovery, parsing, HTML→markdown).                                  |
| `feed-depth`           | Pure detection of summary-only feeds from a batch of items.                                      |
| `media-classify`       | Media-type classification by URL extension (GIF detection).                                      |
| `firecrawl`            | Firecrawl monitor API client (create/update/poll monitors).                                      |
| `firecrawl-diff`       | Reduces a Firecrawl unified diff to just the added content.                                      |
| `extract`              | AI-driven changelog extraction strategies, shared by the CLI and discovery worker.               |
| `extract/shared`       | Pure extraction helpers (version sanitization, tagged-entry parsing).                            |
| `extract/types`        | Types for the extract package (`ExtractedEntry`, `KnownRelease`, deps interfaces).               |
| `extract/aisdk`        | AI SDK large-body tool-loop (`extractWithToolsAiSdk`) — OpenRouter or Anthropic.                 |
| `lane-model`           | Shared AI-SDK `LanguageModel` builders for cheap-call lanes and structured-output (overview).    |
| `github-probe`         | Lightweight GitHub repo probe (exists / has-releases / has-changelog).                           |
| `scrape-fetch`         | Extraction entry point for the discovery worker; routes `scrape`/`agent` sources.                |
| `scrape-persister`     | Persistence seam for `scrapeFetch` (release insert, fetch-log, source updates).                  |
| `extract-deps-worker`  | Worker-side `ExtractDeps` wiring the Anthropic client, secrets, and playbook assembly.           |
| `playbook-block`       | Two-tier playbook markdown assembly for the discovery worker.                                    |
| `deterministic-update` | Deterministic per-source fetch→extract update loop, no Managed-Agents session.                   |

**Private, workspace-only — not published to npm.**
