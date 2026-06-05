# Logging

Logging splits by runtime. Pick the helper by where the code runs, not by what it does.

## CLI + runtime-neutral packages

`packages/adapters/`, `packages/ai/`, `packages/lib/`, `scripts/`, `tests/evals/`, and `src/agent/` log via `@buildinternet/releases-lib/logger` (source at `packages/lib/src/logger.ts`). The logger writes to stderr **and** persists per-day files under `~/.releases/logs/` — that's the whole point of using it, and it only makes sense in a Node/Bun runtime.

## Worker code

`workers/api/`, `workers/mcp/`, `workers/discovery/`, and `workers/webhooks/` emit structured JSON via `logEvent()` from `@releases/lib/log-event` (worker-safe; no `fs` imports).

- **Payload shape.** Workers Logs indexes the top-level keys of JSON-stringified `console.*` lines as filterable fields, so payloads carry `component` (e.g. `"poll-fetch-workflow"`, `"search-log"`) and `event` (kebab-case, e.g. `"no-change-detected"`, `"insert-failed"`) as top-level keys, plus arbitrary context (`sourceSlug`, `err`, request id, workflow instance id, …).
- **Severity.** Set by which `console.*` function the helper invokes — `logEvent("info"|"warn"|"error", {...})` dispatches to `console.log` / `console.warn` / `console.error`, which is what Workers Logs reads for the level field. **Don't** put `level` in the payload.
- **Errors.** The helper unwraps `Error` instances to `{name, message, stack, cause?}` (a default `JSON.stringify(err)` produces `{}`).

New worker code MUST use `logEvent`; existing plain-string `console.*` call sites migrate per-touch (no one-shot codemod, no lint rule — oxlint doesn't support custom rules and adding ESLint just for this isn't worth it).

**Never introduce `@buildinternet/releases-lib/logger` into a worker** — it writes to a virtual `fs` discarded per-request and double-tags components with its hard-coded `[releases]` prefix.

## Auth audit events (`component: "auth"`)

Human-auth business actions are emitted as `logEvent` audit records (`workers/api/src/auth/audit.ts`, #1427) — security/audit telemetry distinct from `telemetry_events` (PII-clean CLI contract) and `search_queries`. PII is minimal: the **user id**, never the email, the session token, or password material; client IPs are **truncated** by `redactIp` (IPv4 → `/24`, IPv6 → `/48`) before they reach the log sink.

| `event`                    | severity | fields         | where it's wired                                                                              |
| -------------------------- | -------- | -------------- | --------------------------------------------------------------------------------------------- |
| `sign-in-success`          | info     | `userId`, `ip` | `databaseHooks.session.create.after` (email, social, one-tap, post-verification auto-sign-in) |
| `sign-up`                  | info     | `userId`       | `databaseHooks.user.create.after`                                                             |
| `email-verified`           | info     | `userId`       | `emailVerification.afterEmailVerification`                                                    |
| `password-reset-completed` | info     | `userId`       | `emailAndPassword.onPasswordReset`                                                            |
| `sign-out`                 | info     | `userId`       | `databaseHooks.session.delete.after` (request path `/sign-out`)                               |
| `session-revoked`          | warn     | `userId`       | `databaseHooks.session.delete.after` (any other deletion, e.g. password-reset revocation)     |
| `sign-in-failure`          | warn     | `reason`, `ip` | the `/api/auth/*` handler in `index.ts` (see below)                                           |

`sign-in-failure` is logged at the **HTTP response layer**, not via an internal hook: a rate-limit rejection (429) short-circuits in Better Auth's router before any hook runs, so the response (path + status) is the only place all failure modes are observable. `reason` is derived from status alone — `429 → rate-limited`, `403 → unverified`, `401 → invalid-credentials`. `invalid-credentials` deliberately covers **both** a wrong password and an unknown email: Better Auth returns the same generic error for both (account-enumeration protection), so they're indistinguishable — and the _logged_ reason stays internal anyway, the user-facing response is always generic.

The email-delivery hooks (`email-sent`, `email-no-binding`, `email-send-failed`, `secret-unresolved`) share the same `component: "auth"` (`workers/api/src/auth/email.ts`).
