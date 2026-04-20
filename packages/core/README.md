# @buildinternet/releases-core

Pure helpers shared by the Releases registry and the [Releases CLI](https://github.com/buildinternet/releases-cli) — schema, categories, slicing, IDs, slugs, tokens, CLI contracts.

## Exports

- `@buildinternet/releases-core/schema` — Drizzle ORM table definitions (source of truth for the Releases D1 database).
- `@buildinternet/releases-core/categories` — canonical category list + validation.
- `@buildinternet/releases-core/dates` — date cutoffs and helpers.
- `@buildinternet/releases-core/changelog-range` — pure range parsing.
- `@buildinternet/releases-core/changelog-slice` — token-aware CHANGELOG slicing.
- `@buildinternet/releases-core/overview` — overview staleness + preview helpers.
- `@buildinternet/releases-core/id` — prefixed nanoid generators and entity-type lookup.
- `@buildinternet/releases-core/slug` — slug generation.
- `@buildinternet/releases-core/tokens` — token counting (tiktoken-backed).
- `@buildinternet/releases-core/cli-contracts` — shared `--json` envelope types for the CLI.

Published from the [`buildinternet/releases`](https://github.com/buildinternet/releases) monorepo. The upstream `packages/core/` directory is the single source of truth; both the monorepo and the OSS CLI consume this package from npm.

## Internal helpers

DB-coupled and worker-only helpers (release upsert, hashing, webhook signing) live in the monorepo under `@releases/core-internal` and are **not** published.
