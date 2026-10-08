# @buildinternet/releases-core

**Scope:** pure, runtime-neutral helpers shared by this monorepo and the CLI — schema, categories, dates, slicing, IDs/slugs, tokens, CLI contracts. Nothing DB-coupled beyond schema definitions and nothing worker-only lives here — that goes in `core-internal`.

Pure helpers shared by the Releases registry and the [Releases CLI](../../apps/cli) — schema, categories, slicing, IDs, slugs, tokens, CLI contracts.

## Exports

Imported as `@buildinternet/releases-core/<subpath>`.

| Subpath             | Purpose                                                                                                                                                                |
| ------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `schema`            | Drizzle ORM table definitions (source of truth for the Releases D1 database).                                                                                          |
| `categories`        | Canonical category list, validation, and alias resolution (`resolveCategorySlug`, `parseCategoryAliases`).                                                             |
| `dates`             | Date cutoffs and helpers.                                                                                                                                              |
| `changelog-range`   | Pure range parsing.                                                                                                                                                    |
| `changelog-slice`   | Token-aware CHANGELOG slicing.                                                                                                                                         |
| `changelog-publish` | Plan a changelog push into the `upsert-content` batch body (single-file `##` sections and directory frontmatter). Shared by the publish Action and `releases publish`. |
| `overview`          | Overview staleness + preview helpers.                                                                                                                                  |
| `id`                | Prefixed nanoid generators and entity-type lookup.                                                                                                                     |
| `slug`              | Slug generation.                                                                                                                                                       |
| `tokens`            | Token counting (tiktoken-backed).                                                                                                                                      |
| `cli-contracts`     | Shared `--json` envelope types for the CLI.                                                                                                                            |
| `d1-limits`         | Backend capability constants (`D1_MAX_BINDINGS`, `IN_ARRAY_CHUNK_SIZE`) for single-column `IN` chunking.                                                               |

Published from the [`buildinternet/releases`](https://github.com/buildinternet/releases) monorepo. The upstream `packages/core/` directory is the single source of truth; the monorepo and the in-tree CLI consume it via `workspace:*`; other consumers use npm.

Changelog-publish fixtures (single-file markdown and directory MDX) ship in `fixtures/changelog-publish/` for the CLI to reuse.

## Internal helpers

DB-coupled and worker-only helpers (release upsert, hashing, webhook signing) live in the monorepo under `@releases/core-internal` and are **not** published.
