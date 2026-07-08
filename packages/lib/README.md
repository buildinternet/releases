# @releases/lib

Slim private utilities shared by the workers and scripts in this monorepo.

## Exports

- `@releases/lib/anthropic-client` — constructs an Anthropic SDK client, optionally routed through Cloudflare AI Gateway.
- `@releases/lib/anthropic-errors` — classifies `@anthropic-ai/sdk` errors into a stable `kind` discriminant.
- `@releases/lib/anthropic-pricing` — list-price cost estimation for managed-agent sessions.
- `@releases/lib/config` — resolves the CLI/script data dir (`~/.releases` by default).
- `@releases/lib/consumption-ref` — derives a stable, PII-clean `consumerRef` identity for consumption metering.
- `@releases/lib/db-errors` — classifies raw D1/Drizzle errors into stable app-level error codes.
- `@releases/lib/entity-match` — word-boundary post-filtering and ranking for search entity candidates.
- `@releases/lib/errors` — categorized error classes (`CategorizedError`, `AdapterError`, …) for ingest/adapter code.
- `@releases/lib/flags` — worker-safe feature-flag helper backed by Cloudflare Flagship, with layered fallback to wrangler vars.
- `@releases/lib/flags-docs` — renders the feature-flag reference table in `docs/architecture/feature-flags.md` from the flag registry.
- `@releases/lib/legacy-env` — resolves an env var migrating from a legacy name to a canonical one, with a one-time deprecation warning.
- `@releases/lib/log-event` — structured JSON logger for **worker code** (Workers Logs-friendly `console.*` dispatch).
- `@releases/lib/logger` — fs-backed logger for **CLI and runtime-neutral packages** (stderr + `~/.releases/logs/`); the only export published, as `@buildinternet/releases-lib/logger`. Never import this into a worker — use `./log-event` there instead.
- `@releases/lib/ma-rate-limit` — classifies 429 rate-limit errors from managed-agents sessions.
- `@releases/lib/oauth-jwt` — resource-server verification of "Sign in with Releases" OAuth JWT access tokens via `jose` + JWKS.
- `@releases/lib/prompt-escape` — escapes caller-supplied strings for safe interpolation into XML-tagged LLM prompt blocks.
- `@releases/lib/rate-limit-tiers` — shared rate-limit tier policy (anonymous/account/machine) for the API and MCP workers.
- `@releases/lib/releases-error` — generic, safe-to-expose error messages per `ErrorType`, used when an error's real message shouldn't leak to a client.
- `@releases/lib/secrets` — resolves a Cloudflare Secrets Store binding once per isolate, with cached reuse and retry.
- `@releases/lib/session-error-classify` — classifies terminal events from a managed-agents session stream.
- `@releases/lib/source-edit` — feed-type inference and source-edit input resolution helpers.
- `@releases/lib/spend-cap` — KV-backed daily spend circuit breaker for managed-agent sessions.

**Private, workspace-only — imported via `@releases/lib`, not published to npm.**
