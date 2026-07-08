# @releases/lib

Slim private utilities shared by the workers and scripts in this monorepo.

## Exports

Imported as `@releases/lib/<subpath>`.

| Subpath                  | Purpose                                                                                                 |
| ------------------------ | ------------------------------------------------------------------------------------------------------- |
| `anthropic-client`       | Constructs an Anthropic SDK client, optionally routed through Cloudflare AI Gateway.                    |
| `anthropic-errors`       | Classifies `@anthropic-ai/sdk` errors into a stable `kind` discriminant.                                |
| `anthropic-pricing`      | List-price cost estimation for managed-agent sessions.                                                  |
| `config`                 | Resolves the CLI/script data dir (`~/.releases` by default).                                            |
| `consumption-ref`        | Derives a stable, PII-clean `consumerRef` identity for consumption metering.                            |
| `db-errors`              | Classifies raw D1/Drizzle errors into stable app-level error codes.                                     |
| `entity-match`           | Word-boundary post-filtering and ranking for search entity candidates.                                  |
| `errors`                 | Categorized error classes (`CategorizedError`, `AdapterError`, …) for ingest/adapter code.              |
| `flags`                  | Worker-safe feature-flag helper backed by Cloudflare Flagship, with wrangler-var fallback.              |
| `flags-docs`             | Renders the feature-flag reference table in `docs/architecture/feature-flags.md`.                       |
| `legacy-env`             | Resolves an env var migrating from a legacy name, with a one-time deprecation warning.                  |
| `log-event`              | Structured JSON logger for **worker code** (Workers Logs-friendly `console.*` dispatch).                |
| `logger`                 | fs-backed logger for **CLI / runtime-neutral packages** (stderr + `~/.releases/logs/`). See note below. |
| `ma-rate-limit`          | Classifies 429 rate-limit errors from managed-agents sessions.                                          |
| `oauth-jwt`              | Resource-server verification of "Sign in with Releases" OAuth JWTs via `jose` + JWKS.                   |
| `prompt-escape`          | Escapes caller strings for safe interpolation into XML-tagged LLM prompt blocks.                        |
| `rate-limit-tiers`       | Shared rate-limit tier policy (anonymous/account/machine) for the API + MCP workers.                    |
| `releases-error`         | Generic, safe-to-expose error messages per `ErrorType` (keeps real messages off the wire).              |
| `secrets`                | Resolves a Cloudflare Secrets Store binding once per isolate, with cached reuse + retry.                |
| `session-error-classify` | Classifies terminal events from a managed-agents session stream.                                        |
| `source-edit`            | Feed-type inference and source-edit input resolution helpers.                                           |
| `spend-cap`              | KV-backed daily spend circuit breaker for managed-agent sessions.                                       |

**Private, workspace-only.** Only `logger` is published — as `@buildinternet/releases-lib/logger` — for the CLI and runtime-neutral packages. Never import `logger` into a worker; use `log-event` there instead.
