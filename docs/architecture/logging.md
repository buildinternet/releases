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
