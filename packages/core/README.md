# @buildinternet/releases-core

Pure helpers shared by the Releases registry and the [Releases CLI](https://github.com/buildinternet/releases-cli) — schema, categories, slicing, IDs, slugs, tokens, CLI contracts.

## Exports

Imported as `@buildinternet/releases-core/<subpath>`.

| Subpath           | Purpose                                                                                                    |
| ----------------- | ---------------------------------------------------------------------------------------------------------- |
| `schema`          | Drizzle ORM table definitions (source of truth for the Releases D1 database).                              |
| `categories`      | Canonical category list, validation, and alias resolution (`resolveCategorySlug`, `parseCategoryAliases`). |
| `dates`           | Date cutoffs and helpers.                                                                                  |
| `changelog-range` | Pure range parsing.                                                                                        |
| `changelog-slice` | Token-aware CHANGELOG slicing.                                                                             |
| `overview`        | Overview staleness + preview helpers.                                                                      |
| `id`              | Prefixed nanoid generators and entity-type lookup.                                                         |
| `slug`            | Slug generation.                                                                                           |
| `tokens`          | Token counting (tiktoken-backed).                                                                          |
| `cli-contracts`   | Shared `--json` envelope types for the CLI.                                                                |
| `d1-limits`       | Backend capability constants (`D1_MAX_BINDINGS`, `IN_ARRAY_CHUNK_SIZE`) for single-column `IN` chunking.    |

Published from the [`buildinternet/releases`](https://github.com/buildinternet/releases) monorepo. The upstream `packages/core/` directory is the single source of truth; both the monorepo and the OSS CLI consume this package from npm.

## Internal helpers

DB-coupled and worker-only helpers (release upsert, hashing, webhook signing) live in the monorepo under `@releases/core-internal` and are **not** published.
