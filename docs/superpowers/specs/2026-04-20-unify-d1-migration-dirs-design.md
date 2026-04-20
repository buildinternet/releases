# 2026-04-20 · Unify D1 Migration Directories Design

Closes #397. Follows #370 (core + CLI consolidation) and #385 (kill local mode), which left two parallel migration histories in place for tests.

## Problem

Two D1 migration directories exist for the same logical schema:

- **`workers/api/migrations/`** — hand-written SQL applied to prod D1 via `wrangler d1 migrations apply`. Authoritative for production.
- **`src/db/migrations/`** — `drizzle-kit generate` output. Applied only by tests (14 call sites), via `migrate(db, { migrationsFolder: "src/db/migrations" })` against in-memory `bun:sqlite`.

They drift silently:

- Different filenames for the same logical change (e.g. webhook_subscriptions landed as `20260418215123` on the wrangler side and `20260418215436` on the drizzle side, reconciled in #396).
- Different SQL dialects — drizzle emits backticked identifiers, `--> statement-breakpoint` separators, and trailing `FOREIGN KEY` clauses; wrangler files are hand-written with unquoted identifiers and inline `REFERENCES ... ON DELETE CASCADE`.
- One-way divergence around features drizzle-kit can't emit — `releases_fts` (FTS5 virtual table) only exists in the wrangler side, so tests run against a schema that's missing search.
- Both ran green until 2026-04-19: the `cron_runs` table existed on both sides, but the wrangler migration was never applied to prod, silently broke the nightly email cron, and went undetected because no CI step enforced "prod D1 is current." #396 added the `wrangler d1 migrations apply` step, but didn't address the two-histories root cause.

Origin: `workers/api/migrations/` shipped in `fa3df3c` (2026-03-27); `src/db/migrations/` shipped in `466e335` (2026-03-26) as the local-mode test fixture. Local mode was deleted in `99c0df5` (PR #385) per the #370 plan, with an explicit carve-out that `tests/db-helper.ts` keeps using drizzle-backed `bun:sqlite`. That carve-out preserved drizzle ORM for tests — it did not require keeping drizzle-kit's committed migration output.

## Goals

- One source of truth for D1 schema DDL: `workers/api/migrations/`.
- Tests run against the same SQL that prod applies — closing the FTS5 gap and the dialect-divergence class of bugs.
- Keep developer ergonomics for schema changes: `schema.ts` stays authoritative for TS types; `bun run db:generate` continues to exist as a scaffolding aid for new migrations.
- Preserve Drizzle Studio for local DB introspection.
- Preserve the schema-drift CI check (`schema.ts` changed without a corresponding generator run).

## Non-goals

- Migrating tests from `bun:sqlite` to miniflare D1. Miniflare is slower (process boot + IPC per test) and the change is much larger than this spec contemplates. #370's "narrow local DB for tests" carve-out stays.
- Touching the prod `d1_migrations` table. No rebaseline, no re-registration, no renames of files that already ran in prod.
- Future GraphQL + drizzle integration. `drizzle-graphql`/pothos read `schema.ts` + the live DB, not the migration output. This spec's changes don't affect any future layer there.

## Architecture

### Components and changes

**Delete:**

- `src/db/migrations/` (18 `.sql` files + `meta/_journal.json` + 18 snapshot JSONs).

**Modify:**

- `drizzle.config.ts` — change `out: "./src/db/migrations"` to `out: "./.drizzle-out"` (gitignored). Drizzle-kit still generates when run; output is transient.
- `tests/db-helper.ts` — replace the drizzle `migrate(...)` call with a new `applyMigrations(sqlite)` helper. The helper reads every `.sql` file under `workers/api/migrations/` in sorted filename order and runs each file's contents as a single multi-statement SQL batch via `bun:sqlite`'s native multi-statement runner.
- 13 other test files — replace inline `migrate(db, { migrationsFolder: "src/db/migrations" })` calls with imports from `tests/db-helper.ts`. All 14 call sites route through one helper.
- `scripts/check-migration-filenames.sh` — drop the `src/db/migrations/*.sql` glob; only watch `workers/api/migrations/*.sql`.
- `.github/workflows/ci.yml` — **replace** the existing drift check (`RELEASED_DATA_DIR=/tmp/drizzle-drift-check bunx drizzle-kit generate`) with a new pairing check that closes the #397 root-cause loop: if drizzle-kit would emit new DDL against `schema.ts`, require the PR to include at least one added file under `workers/api/migrations/*.sql`. The old drift check is redundant in the new architecture — with drizzle output gitignored, it would always fail on fresh CI checkouts because no baseline snapshot is committed. (See §"Pairing check" below.)
- `.gitignore` — add `.drizzle-out/`.
- `AGENTS.md` — remove the `src/db/migrations/` line from "Surviving `src/` tree"; update the migration convention note.
- `docs/architecture/remote-mode.md` — remove the parallel-dir mention (if any), describe `workers/api/migrations/` as the single source.
- `README.md` — update the `db:generate` description to "scaffold a migration draft" rather than "generate a D1 migration."
- `package.json` — keep `db:generate` script; no changes to the binary.

**Unchanged:**

- `packages/core/src/schema.ts`, `src/db/schema-coverage.ts`, `workers/api/src/db/schema-cron.ts` — authoritative TS schema for the drizzle ORM and drizzle-kit introspection.
- `drizzle-d1.config.ts` — used for `drizzle-kit studio` against the local miniflare D1. Untouched.
- `drizzle-kit` binary in dev dependencies.
- `workers/api/migrations/` filenames and contents (except the spec's bookkeeping updates, if any).
- Prod `d1_migrations` tracking table.

### Test apply-migrations helper

`tests/db-helper.ts` exports `applyMigrations(sqlite)` — a ~10 line helper that reads `workers/api/migrations/*.sql` in sorted filename order and runs each file's contents as a single multi-statement batch. The existing `createTestDb()` wraps it: open a fresh `bun:sqlite` DB at a temp path, set `journal_mode=WAL` and `foreign_keys=ON`, call `applyMigrations(sqlite)`, then wrap with `drizzle(sqlite, { schema })`.

The 13 test files that currently inline `migrate(db, { migrationsFolder: "src/db/migrations" })` against the same `bun:sqlite` pattern import `applyMigrations` (or `createTestDb` where applicable) instead. No other test code changes.

Why read files directly instead of keeping `drizzle-orm/bun-sqlite/migrator`: wrangler migration files don't have `--> statement-breakpoint` separators, and drizzle's migrator expects them. A custom loader is both simpler and matches what wrangler actually does in prod.

### Schema drift check in CI (removed)

The pre-refactor CI had a "Check for uncommitted schema drift" step that ran `drizzle-kit generate` into a tmp dir and greped for "No schema changes". This depended on the committed `src/db/migrations/meta/*` snapshots providing a baseline for drizzle-kit to compare against. Post-refactor, drizzle output is gitignored (`.drizzle-out/`) and snapshots never reach CI, so the step would always emit a fresh baseline and fail the grep. The pairing check (below) replaces it — it works on fresh checkouts and catches the same underlying class of bug (schema.ts changed without a paired migration) more directly.

### Pairing check (new permanent CI step)

Closes the root cause of #397. The check runs on pull requests and fails if `schema.ts` has uncommitted drizzle output _and_ the PR adds no new file under `workers/api/migrations/`.

Shape:

1. Run `RELEASED_DATA_DIR=/tmp/drizzle-pair-check bunx drizzle-kit generate` into a tmp dir.
2. If output is empty (no new SQL generated) → pass. No schema change, nothing to pair.
3. If output is non-empty → query git for files added on this branch matching `workers/api/migrations/*.sql`. If zero, fail with a message explaining "schema.ts changed; no new wrangler migration was added — hand-port the generated SQL."
4. On PRs only (`if: github.event_name == 'pull_request'`), uses `origin/${{ github.base_ref }}...HEAD` for the added-files diff.

What it doesn't check (out of scope):

- That the _contents_ of the new wrangler file match what drizzle generated. Dialect and hand-edits will diverge legitimately. Matching by existence is enough to stop the #397 class of bug; content correctness is a code-review concern.
- That the file count matches (a single `schema.ts` change can legitimately span multiple wrangler files, e.g. a table + a backfill). The check passes on ≥ 1.

False-positive cases and how to handle them:

- **Schema.ts-only refactor** (rename an imported type, reorganize exports) that happens to confuse drizzle-kit's diff engine into emitting a no-op migration. Mitigation: the drift check already exists today and rarely false-positives in practice; if it does, fix the schema.ts edit to be truly inert. No escape hatch in the check itself — escape hatches invite abuse.
- **A PR that modifies an existing wrangler migration but adds no new file.** This should be rare (modifying applied migrations is dangerous) and probably wrong anyway. The check correctly fails.

### Developer workflow for a new schema change

Before:

1. Edit `schema.ts`.
2. `bun run db:generate` → new file in `src/db/migrations/`.
3. Hand-write `workers/api/migrations/YYYYMMDDHHMMSS_*.sql` mirroring the drizzle output.
4. Commit both.

After:

1. Edit `schema.ts`.
2. `bun run db:generate` → new file in `.drizzle-out/` (preview / scaffold).
3. Hand-author `workers/api/migrations/YYYYMMDDHHMMSS_*.sql`, copying SQL from the preview.
4. Commit just the wrangler file.

The step count is the same; what drops is the "both sides committed" confusion. `.drizzle-out/` is gitignored and can be cleaned.

## Verification gate (before merging the deletion)

Before deleting `src/db/migrations/`, prove that `workers/api/migrations/` is a superset of its schema:

1. Fresh `bun:sqlite` A — apply all `src/db/migrations/*.sql` in order.
2. Fresh `bun:sqlite` B — apply all `workers/api/migrations/*.sql` in order.
3. Dump `SELECT type, name, sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY type, name` from each.
4. Diff.

Expected diffs:

- B has `releases_fts` (FTS5 virtual table + its shadow tables `releases_fts_*`) and any triggers that populate it. A does not.
- Whitespace / identifier-quoting differences on logically equivalent tables — these surface as text diffs but not schema diffs once normalized.

Anything else is a real gap and must be fixed in `workers/api/migrations/` before the deletion lands. The plan captures this as a throwaway dry-run script (`scripts/diff-migration-schemas.ts`) that runs once pre-merge and is deleted with the drizzle dir.

## Risks

1. **Test runtime regression.** 22 wrangler files (vs 18 drizzle files today), with a larger 6.9 KB baseline. Likely imperceptible. If benchmarks show >500 ms added to the suite's slowest test, revisit.

2. **Hidden dialect-dependent test.** A test that relied on a drizzle-emitted quirk (e.g. a specific default-value coercion) fails under wrangler SQL. Low probability — both sides produce valid SQLite. Mitigation: run full suite; investigate any new failure rather than compensating in SQL.

3. **Future contributor confusion.** Someone runs `bun run db:generate` expecting the output to auto-commit. Mitigation: `AGENTS.md` + `README.md` explicitly describe the hand-port step; the `.drizzle-out/` name signals transience.

4. **Drizzle Studio flow.** `drizzle-kit studio` via `drizzle-d1.config.ts` reads the live miniflare D1 DB, not the migration output. Untouched. Verified by the config file's `schema: "./packages/core/src/schema.ts"` + `dbCredentials.url` pointing at `.wrangler/state/v3/d1/...`.

## Follow-ups (out of scope for this spec)

- Reverse pairing check: every new `workers/api/migrations/*.sql` should have a matching `schema.ts` edit (or a justification comment — e.g. data-only migrations, FTS5 changes). Complement to the pairing check above. Separate issue; lower priority because the reverse direction (migration without schema change) is less likely to cause outages.
- Consider whether `bun run db:generate` is worth keeping at all, vs. documenting "read `schema.ts`, write SQL directly." The former keeps a useful scaffold; the latter is one fewer tool. Defer until after this change beds in.

## Testing strategy

- **Verification gate (above):** schema diff between old and new apply paths, before deletion.
- **Unit tests:** all currently-passing tests continue to pass with the new `applyMigrations(db)` helper.
- **CI:** existing `bun run test`, `npx tsc --noEmit`, drift-check, migration-filename, and the `wrangler d1 migrations apply` step added in #396 all green.
- **Local smoke:** run one small consumer (e.g. `bun test tests/api/cron-runs-dao.test.ts`) before the full suite, to validate helper plumbing.

## Rollback

Single-commit revert restores `src/db/migrations/`, reverts `tests/db-helper.ts`, and restores `drizzle.config.ts`. No prod data touched, no `d1_migrations` rows changed. The revert is safe at any time.

## Scope and blast radius

- **Files deleted:** ~38 (18 SQL + `meta/_journal.json` + 18 snapshots + possibly an index file under `meta/`).
- **Files modified:** ~20 (14 test files, 4 config/doc files, `drizzle.config.ts`, `.gitignore`).
- **LOC net:** significantly negative (deletions dominate).

Not a drive-by cleanup, but squarely in the "one PR" bucket.
