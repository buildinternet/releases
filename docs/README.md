# Docs guide

A reader's map of the documentation. The architecture docs in [`architecture/`](architecture/) are dense reference material — accurate, but written for someone who already knows the system. This page is the missing on-ramp: what the system does in plain terms, which doc to open for the task in front of you, and what each doc actually covers.

If you're an agent working in this repo, [`AGENTS.md`](../AGENTS.md) is the rulebook and canonical entry point — read it first; this page is its map into the deep dives. Setup and deployment live in [`CONTRIBUTING.md`](../CONTRIBUTING.md). Agents _consuming_ the product (the API, MCP server, or CLI, rather than this codebase) start from [releases.sh/llms.txt](https://releases.sh/llms.txt) instead — the llms.txt convention belongs to the website, not the repo.

## The system in plain terms

Releases tracks what software vendors ship. The pipeline, end to end:

1. **Sources** describe where a vendor publishes changes — a GitHub repo, an RSS feed, a web page we scrape, an App Store listing. Each source has a fetch adapter matching its type.
2. **Ingest** runs on Cloudflare cron/Workflow schedules: fetch each due source, detect what's new, extract structured release records (AI-assisted for messy pages), dedupe, and insert into D1. Cheap AI passes run at insert time — generated titles and summaries, a marketing-vs-product classifier, thin-feed enrichment.
3. **Hard cases get agents.** Pages without feeds are handled by Anthropic managed agents (a Sonnet "discovery" agent for judgment calls, a Haiku "worker" agent for mechanical fetches); pages behind anti-bot challenges go through Firecrawl.
4. **Serving:** the API worker exposes everything over public REST; the MCP worker gives AI agents the same data as tools; the web frontend renders it for people; webhooks and a WebSocket stream push new releases out in real time; hybrid lexical + vector search sits across all of it.

The one structural rule to internalize: **the API worker is the only data plane.** The CLI (in a [separate repo](https://github.com/buildinternet/releases-cli)), the web app, the MCP server, and the agents are all clients of it.

## Start here, by task

| If you're about to…                             | Read                                                                                                                                                                                             |
| ----------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Add or change a REST endpoint                   | [routing.md](architecture/routing.md) for where it goes and how it paginates, [errors.md](architecture/errors.md) for how it fails                                                               |
| Fork or self-host the workers                   | [deploy-coupling.md](architecture/deploy-coupling.md) — account-scoped IDs, secrets, and what degrades without them                                                                              |
| Touch fetch/parse/insert behavior               | [ingest.md](architecture/ingest.md), then [remote-mode.md](architecture/remote-mode.md) for the scheduling around it                                                                             |
| Work on auth, tokens, or OAuth                  | [remote-mode.md → Auth model](architecture/remote-mode.md#auth-model)                                                                                                                            |
| Add or change an MCP tool                       | [mcp.md](architecture/mcp.md) — and keep the WebMCP subset in sync (noted there)                                                                                                                 |
| Change a D1 table                               | [remote-mode.md → Migrations](architecture/remote-mode.md#migrations), and remember schema ships to the CLI via [cli-distribution.md](architecture/cli-distribution.md)                          |
| Touch DB construction / think about Postgres    | [storage-portability.md](architecture/storage-portability.md) — the `createDb` seam and the SQLite-dialect coupling map                                                                          |
| Touch search or embeddings                      | [semantic-search.md](architecture/semantic-search.md)                                                                                                                                            |
| Work on the managed agents or skills            | [agents.md](architecture/agents.md)                                                                                                                                                              |
| Add a web feature                               | [web.md](architecture/web.md)                                                                                                                                                                    |
| Onboard a tricky source                         | [local-ingest.md](architecture/local-ingest.md) (local, no agent bill), [firecrawl-monitoring.md](architecture/firecrawl-monitoring.md) (challenge-blocked pages)                                |
| Reach for a feature flag                        | [feature-flags.md](architecture/feature-flags.md) — but read the "be judicious" convention in AGENTS.md first; the default is no flag                                                            |
| Classify something (kind? type? category? tag?) | [taxonomy.md](architecture/taxonomy.md)                                                                                                                                                          |
| Debug prod (logs, cron runs, cost)              | [logging.md](architecture/logging.md), [coverage.md → Cron observability](architecture/coverage.md#cron-observability), [ai-gateway.md](architecture/ai-gateway.md), plus [runbooks/](runbooks/) |

## The catalog

### Core pipeline

- **[ingest.md](architecture/ingest.md)** — the per-item fetch → parse → insert path: adapter routing, dedup, backoff, exclusion/suppression, and the three ingest-time AI passes.
- **[remote-mode.md](architecture/remote-mode.md)** — the API worker itself. The biggest doc, covering auth (all five credential lanes), rate limiting, caching, migrations, cron/Workflow scheduling, and the SourceActor/OrgActor Durable Objects.
- **[extract.md](architecture/extract.md)** — how AI turns a fetched body into release records: one-shot for small bodies, a budgeted tool-use loop for large ones.
- **[coverage.md](architecture/coverage.md)** — grouping several posts about the same launch under one canonical release; also the cron-run observability table and its alert emails.
- **[events.md](architecture/events.md)** — the real-time side: the `ReleaseHub` Durable Object, the public WebSocket stream, and who consumes publish events (CLI tail, webhooks, cache invalidation).

### API surface

- **[routing.md](architecture/routing.md)** — where routes live and why: CRUD vs job triggers vs admin telemetry, slug/ID resolution, the lookups family, pagination shapes.
- **[errors.md](architecture/errors.md)** — the one error envelope every non-2xx response uses, and how to add a code.
- **[taxonomy.md](architecture/taxonomy.md)** — the classification axes and how `kind`, `type`, and `category` differ (they've collided before; this doc is the referee).
- **[well-known-config.md](architecture/well-known-config.md)** — owner-declared `releases.json` v2 manifest (products + release-note locators), reconciliation, and cost-tiered materialization; fail-closed, never clobbers curator edits.

### Search and AI

- **[semantic-search.md](architecture/semantic-search.md)** — the three Vectorize indexes, hybrid RRF ranking with recency boosts, the query-embedding cache, and related-entity rails.
- **[ai-gateway.md](architecture/ai-gateway.md)** — how Anthropic calls route through Cloudflare AI Gateway for observability, which paths deliberately bypass it, and the OpenRouter cheap-lane switch.
- **[feature-flags.md](architecture/feature-flags.md)** — the Flagship flag registry and every live flag with its polarity.
- **[content-pipelines.md](architecture/content-pipelines.md)** — a map of every routine/scheduled AI-content pipeline (overview regen, batch summarize, feed enrichment, digests) with schedule, gate, model lane, and manual trigger.

### Agents

- **[agents.md](architecture/agents.md)** — the discovery/worker managed agents: how they deploy, the MCP-vs-custom-tool split (reads are public, writes run inside the trust boundary), skills vs per-org playbooks, and the `.claude/` integration.
- **[local-ingest.md](architecture/local-ingest.md)** — onboarding or backfilling a source from local Claude Code instead of dispatching a managed agent, gated by a fail-closed robots.txt/Content-Signal preflight.
- **[maintenance-workspace.md](architecture/maintenance-workspace.md)** — the `~/.releases/work/` convention that gives agent-driven prod maintenance a durable audit trail.

### Web and delivery

- **[web.md](architecture/web.md)** — the frontend feature reference: product-first URLs, changelog slicing, OG images, org overviews, categories, collections, the media/video pipeline, follows, and the admin hub.
- **[webhooks.md](webhooks.md)** — the public subscriber contract: delivery headers, HMAC verification (with code samples), retries and DLQ.
- **[mcp.md](architecture/mcp.md)** — the hosted MCP server: the tool/resource/prompt catalog, auth and scope enforcement, App UIs, and the MCP Registry listing.
- **[workspaces.md](architecture/workspaces.md)** — user-tenancy Workspaces. Not the registry `organizations` — the doc opens with exactly that warning.
- **[consumption-telemetry.md](architecture/consumption-telemetry.md)** — the demand gauge for programmatic (MCP/API) consumption.

### Everything else

- **[firecrawl-monitoring.md](architecture/firecrawl-monitoring.md)** — the external fetch backend for challenge-blocked pages, its unusual diff-not-markdown webhook format, and the backfill/re-extract workflows built on it.
- **[cli-distribution.md](architecture/cli-distribution.md)** — which npm packages publish from which repo, and the schema-change shipping path to the CLI.
- **[storage-portability.md](architecture/storage-portability.md)** — where SQLite/D1 assumptions live and what a future optional Postgres backend would cost. Aspirational, not in progress; read before touching the DB construction seam.
- **[logging.md](architecture/logging.md)** — worker `logEvent()` vs the fs-backed CLI logger, and the auth audit-event reference.
- **[changelog-style.md](changelog-style.md)** — voice and density rules for the project's own daily changelog.
- **[runbooks/](runbooks/)** — operational procedures: auth-audit monitors, the trusted-proxy WAF rule, Verified Bot registration, the demand dashboard.
- **[superpowers/](superpowers/)** — historical design specs and implementation plans. Architecture docs link into these for rationale; they are point-in-time documents, not maintained references.

### Design documents (historical)

Two point-in-time design/plan documents live under `plans/`. The work they describe has since shipped (see remote-mode.md for the running system); they are kept as history, not maintained references:

- **[durable-objects-exploration.md](plans/durable-objects-exploration.md)** — the per-entity actor design exploration (parts of which later shipped as SourceActor/OrgActor).
- **[sourceactor-delegation-plan.md](plans/sourceactor-delegation-plan.md)** — the staged plan for moving scrape/agent delegation onto SourceActor.

## Writing these docs

A few habits keep this directory useful (see also the Conventions preamble in AGENTS.md):

- **Open in plain language.** The first paragraph should tell a newcomer what the system is, why it exists, and when they'd need this doc — before any table names or issue numbers.
- **Reference density is fine below the fold.** These docs are consulted, not read cover-to-cover; precise file paths, env vars, and gotchas are their value. Just don't make them the opening.
- **Issue numbers are citations, not prose.** `(#1234)` after a claim is helpful; a sentence that only makes sense if you've read #1234 is not.
- **Mark anything speculative.** If a doc describes a plan or exploration, say so in a blockquote at the top, like the two design docs above do.
- **One home per fact.** When two docs both need a detail, one owns it and the other links. AGENTS.md points here; this page points into `architecture/`.
