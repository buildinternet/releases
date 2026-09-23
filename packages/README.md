# packages

Shared code, split between published npm packages and private in-tree packages.

| Directory        | Import name                         | Published?                           | Role                                                                                          |
| ---------------- | ----------------------------------- | ------------------------------------ | --------------------------------------------------------------------------------------------- |
| `core/`          | `@buildinternet/releases-core`      | Published                            | Pure, runtime-neutral helpers shared with the OSS CLI; DB schema is source of truth.          |
| `core-internal/` | `@releases/core-internal`           | Private, workspace-only              | DB-coupled / worker-only helpers the thin CLI doesn't need.                                   |
| `api-types/`     | `@buildinternet/releases-api-types` | Published                            | Wire protocol — request/response shapes for the API worker.                                   |
| `adapters/`      | `@releases/adapters`                | Private, workspace-only              | Fetch adapters (GitHub, Cloudflare, crawl, feed, App Store) + extraction orchestration.       |
| `ai/`            | `@releases/ai-internal`             | Private, workspace-only              | AI helpers for ingest/content pipelines — evaluation, extraction, classification, generation. |
| `rendering/`     | `@releases/rendering`               | Private, workspace-only              | Atom feed helpers, markdown/JSON formatters, media URL helpers.                               |
| `search/`        | `@releases/search`                  | Private, workspace-only              | Embedding providers/cache, Vectorize hybrid search, embedding pipelines.                      |
| `agent-shared/`  | `@releases/agent-shared`            | Private, workspace-only              | Managed-agent prompts, typed tools, and grader rubrics.                                       |
| `design-system/` | `@releases/design-system`           | Private, workspace-only              | Token + component vocabulary behind the web app.                                              |
| `lib/`           | `@releases/lib`                     | Private (`logger` subpath published) | Small cross-app platform helpers — see its own README for scope.                              |

## Key rules

- Schema changes land in `packages/core` first; the CLI picks them up on its next version bump.
- Wire changes land in `packages/api-types` first and are additive — renames/removals get a one-minor-version deprecation alias before removal.
- Worker code (`apps/api`, `apps/mcp`, `apps/discovery`, `apps/webhooks`) logs via `logEvent()` from `@releases/lib/log-event`, never the fs-backed `@buildinternet/releases-lib/logger`.
- The carved-out workers (`apps/mcp`, `apps/discovery`, `apps/webhooks`) resolve workspace packages through their own `tsconfig.json` `paths` map, not `bun install` — a new package a carved-out worker imports needs a matching `paths` entry there.

See [AGENTS.md → Workspaces and carved-out packages](../AGENTS.md#workspaces-and-carved-out-packages) for the full package-by-package writeup this table summarizes.
