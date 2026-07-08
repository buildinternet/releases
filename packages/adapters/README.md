# @releases/adapters

Adapter primitives (`types`, `source-meta`, `content-hash`), the `github`, `cloudflare`, `crawl`, and `feed` adapters, plus the shared scrape/agent fetch orchestration.

## Exports

- `@releases/adapters/types` — shared `RawRelease`/`Adapter`/`FetchOptions`/`FetchResult` types every adapter implements.
- `@releases/adapters/source-meta` — `SourceMetadata` shape and helpers (feed/GitHub/appstore fields, `getSourceMeta`, `isGitHubFetched`).
- `@releases/adapters/fetch-plan` — pure resolver for how/how often a source is fetched (poll-cron tier intervals, Firecrawl cadence).
- `@releases/adapters/workflow-stages` — pure resolver for which ingestion-pipeline stages apply to a source, in order (drives the dev Fetch Log drawer).
- `@releases/adapters/user-agent` — the bot user-agent string used on every outbound fetch to third-party sites.
- `@releases/adapters/content-hash` — content hash for dedup/change-detection on a `RawRelease`.
- `@releases/adapters/github` — GitHub releases + CHANGELOG-file fetch adapter.
- `@releases/adapters/github-discovery` — worker-safe planner for GitHub CHANGELOG path discovery (no fetch, no DB writes).
- `@releases/adapters/cloudflare` — Cloudflare Browser Rendering fetch (content/markdown render of a page).
- `@releases/adapters/cf-challenge` — pure detector for Cloudflare challenge interstitials in rendered output.
- `@releases/adapters/crawl` — Cloudflare `/crawl` multi-page changelog job (start + poll).
- `@releases/adapters/appstore` — iTunes Lookup API adapter for App Store release notes.
- `@releases/adapters/app-links` — pure parsers for Apple App Site Association / Android Digital Asset Links well-known files.
- `@releases/adapters/feed` — RSS/Atom/JSON feed adapter (discovery, parsing, HTML→markdown).
- `@releases/adapters/feed-depth` — pure detection of "summary-only" feeds from a batch of items.
- `@releases/adapters/media-classify` — shared media-type classification by URL extension (GIF detection).
- `@releases/adapters/firecrawl` — Firecrawl monitor API client (create/update/poll monitors).
- `@releases/adapters/firecrawl-diff` — reduces a Firecrawl unified diff to just the added content.
- `@releases/adapters/extract` — AI-driven changelog extraction strategies, shared between the CLI and the discovery worker.
- `@releases/adapters/extract/shared` — pure extraction helpers (version sanitization, tagged-entry parsing) safe for Workers and Bun.
- `@releases/adapters/extract/types` — types for the extract package (`ExtractedEntry`, `KnownRelease`, deps interfaces).
- `@releases/adapters/extract/aisdk` — OpenRouter/Vercel-AI-SDK large-body tool-loop extraction path (provider-agnostic port of the Anthropic-SDK loop).
- `@releases/adapters/overview-model` — builds the AI-SDK `LanguageModel` for the org-overview structured-output lane.
- `@releases/adapters/github-probe` — lightweight GitHub repo probe (exists/has-releases/has-changelog) for the on-demand lookup endpoint.
- `@releases/adapters/scrape-fetch` — extraction entry point for the discovery worker; routes `scrape`/`agent` sources to the right strategy.
- `@releases/adapters/scrape-persister` — persistence seam for `scrapeFetch` (release insert, fetch-log, source updates), HTTP-backed by default.
- `@releases/adapters/extract-deps-worker` — worker-side `ExtractDeps` implementation wiring the Anthropic client, secrets, and playbook assembly.
- `@releases/adapters/playbook-block` — two-tier playbook markdown assembly for the discovery worker.
- `@releases/adapters/deterministic-update` — deterministic per-source fetch→extract update loop, no Managed-Agents session.

**Private, workspace-only — imported via `@releases/adapters`, not published to npm.**
