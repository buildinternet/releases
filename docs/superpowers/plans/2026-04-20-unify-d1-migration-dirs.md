# Unify D1 Migration Directories Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make `workers/api/migrations/` the single source of truth for D1 schema DDL. Tests run against the same SQL prod applies. Delete the drizzle-kit output dir from VCS. Add a CI check that fails PRs changing `schema.ts` without a paired wrangler migration file.

**Architecture:** Tests keep using drizzle ORM + in-memory `bun:sqlite` per #370's carve-out. Only the migration-apply step changes: `tests/db-helper.ts` gets a new `applyMigrations(sqlite)` helper that reads `workers/api/migrations/*.sql` in sorted filename order and runs each via `bun:sqlite`'s multi-statement runner (`Database.prototype.exec`). The 14 existing test call sites switch to the helper. `drizzle-kit generate` continues to run in CI for the drift check, but emits to a gitignored `.drizzle-out/` instead of a committed dir. A new CI step requires any PR that would emit new drizzle DDL to add at least one file under `workers/api/migrations/*.sql`.

**Tech Stack:** Bun, `bun:sqlite`, drizzle-orm, drizzle-kit, TypeScript (strict), Cloudflare Worker (wrangler), GitHub Actions.

**Spec:** [`docs/superpowers/specs/2026-04-20-unify-d1-migration-dirs-design.md`](../specs/2026-04-20-unify-d1-migration-dirs-design.md) · closes #397.

**Current branch:** `fix/397-unify-migration-dirs` (already created; spec already committed).

---

## File structure

**Created (temporary, deleted in Task 10):**

- `scripts/diff-migration-schemas.ts` — one-shot verification gate.

**Modified:**

- `tests/db-helper.ts` — adds `applyMigrations(sqlite)`, switches `createTestDb()` to use it.
- 13 test files — replace the drizzle-migrator call with `applyMigrations(sqlite)` (full list in Task 4).
- `drizzle.config.ts` — change `out` path.
- `.gitignore` — add `.drizzle-out/`.
- `scripts/check-migration-filenames.sh` — drop the `src/db/migrations` glob.
- `.github/workflows/ci.yml` — drift-check message update + new pairing-check step.
- `AGENTS.md`, `README.md`, `docs/architecture/remote-mode.md` — doc updates.

**Deleted:**

- `src/db/migrations/` (18 `.sql` files + `meta/_journal.json` + 18 snapshot JSONs).
- `scripts/diff-migration-schemas.ts` (after Task 1 proves the point).

---

## Task 1: Verification gate — prove workers/api/migrations/ is a superset

Before deleting anything, prove the wrangler migration dir produces the same schema (plus FTS5) as the drizzle dir. One-shot script, deleted in Task 10.

**Files:**

- Create: `scripts/diff-migration-schemas.ts`

- [ ] **Step 1: Write the verification script**

Create `scripts/diff-migration-schemas.ts` with the following content. It applies both migration dirs to separate in-memory SQLite DBs and diffs the object names from `sqlite_master`:

```ts
#!/usr/bin/env bun
// One-shot verification gate for #397. Deleted after landing.

import { Database } from "bun:sqlite";
import { readdirSync, readFileSync } from "fs";
import { join } from "path";

function applyDir(sqlite: Database, dir: string): void {
  const files = readdirSync(dir)
    .filter((f) => f.endsWith(".sql"))
    .sort();
  for (const f of files) {
    const sql = readFileSync(join(dir, f), "utf8");
    // bun:sqlite multi-statement runner
    (sqlite as any).exec(sql);
  }
}

function names(sqlite: Database): Set<string> {
  const rows = sqlite
    .query("SELECT name FROM sqlite_master WHERE name NOT LIKE 'sqlite_%'")
    .all() as Array<{ name: string }>;
  return new Set(rows.map((r) => r.name));
}

const a = new Database(":memory:");
applyDir(a, "src/db/migrations");
const b = new Database(":memory:");
applyDir(b, "workers/api/migrations");

const namesA = names(a);
const namesB = names(b);
const onlyInA = [...namesA].filter((n) => !namesB.has(n));
const onlyInB = [...namesB].filter((n) => !namesA.has(n));

console.log(`drizzle (A): ${namesA.size} objects`);
console.log(`wrangler (B): ${namesB.size} objects`);
console.log(`Only in drizzle (A): ${JSON.stringify(onlyInA)}`);
console.log(`Only in wrangler (B): ${JSON.stringify(onlyInB)}`);

if (onlyInA.length > 0) {
  console.error(`\nwrangler migrations are missing ${onlyInA.length} object(s) that drizzle has.`);
  process.exit(1);
}
console.log("\nOK: wrangler is a superset of drizzle (by object name).");
```

- [ ] **Step 2: Run the verification**

Run: `bun scripts/diff-migration-schemas.ts`

Expected output:

- `OK: wrangler is a superset of drizzle (by object name).`
- `Only in wrangler (B)` should include `releases_fts` and the FTS5 shadow tables/indexes (names starting `releases_fts_`), plus any trigger that maintains FTS5 (e.g. `releases_ai`, `releases_au`, `releases_ad`).
- `Only in drizzle (A)` should be `[]`.

If `Only in drizzle (A)` is non-empty, STOP. Investigate the missing object, add it to a new `workers/api/migrations/*.sql` file, and re-run before proceeding.

- [ ] **Step 3: Commit the verification script (kept until Task 10)**

```bash
git add scripts/diff-migration-schemas.ts
git commit -m "chore: add one-shot script to verify workers/api/migrations is a superset of src/db/migrations (#397)"
```

---

## Task 2: Add applyMigrations helper to tests/db-helper.ts

TDD: write a test asserting that `applyMigrations(sqlite)` produces a DB with critical tables, then implement.

**Files:**

- Modify: `tests/db-helper.ts`
- Test: `tests/unit/apply-migrations.test.ts` (new)

- [ ] **Step 1: Write a failing test**

Create `tests/unit/apply-migrations.test.ts`:

```ts
import { describe, it, expect } from "bun:test";
import { Database } from "bun:sqlite";
import { applyMigrations } from "../db-helper";

describe("applyMigrations", () => {
  it("creates the full wrangler schema on a fresh sqlite DB", () => {
    const sqlite = new Database(":memory:");
    applyMigrations(sqlite);

    const rows = sqlite
      .query("SELECT name FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' AND type = 'table'")
      .all() as Array<{ name: string }>;
    const names = rows.map((r) => r.name);

    expect(names).toContain("organizations");
    expect(names).toContain("sources");
    expect(names).toContain("releases");
    expect(names).toContain("cron_runs");
    expect(names).toContain("webhook_subscriptions");
    expect(names).toContain("releases_fts");
  });

  it("is idempotent-safe to call on a fresh DB", () => {
    const sqlite = new Database(":memory:");
    expect(() => applyMigrations(sqlite)).not.toThrow();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/unit/apply-migrations.test.ts`

Expected: FAIL with `Export named 'applyMigrations' not found in module '.../tests/db-helper.ts'`.

- [ ] **Step 3: Implement applyMigrations in tests/db-helper.ts**

Edit `tests/db-helper.ts`. Replace the file's contents with:

```ts
import { Database } from "bun:sqlite";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { mkdtempSync, rmSync, readdirSync, readFileSync } from "fs";
import { tmpdir } from "os";
import * as schema from "@buildinternet/releases-core/schema";

const __dirname = dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_DIR = join(__dirname, "..", "workers", "api", "migrations");

export type TestDb = ReturnType<typeof drizzle<typeof schema>>;

export interface TestDatabase {
  db: TestDb;
  dbPath: string;
  cleanup: () => void;
}

/**
 * Apply every .sql file under workers/api/migrations/ in sorted filename
 * order to the given sqlite database. Matches what `wrangler d1 migrations
 * apply` does in prod — single source of truth post-#397.
 */
export function applyMigrations(sqlite: Database): void {
  const files = readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith(".sql"))
    .sort();
  for (const f of files) {
    const sql = readFileSync(join(MIGRATIONS_DIR, f), "utf8");
    // bun:sqlite multi-statement runner
    (sqlite as any).exec(sql);
  }
}

export function createTestDb(): TestDatabase {
  const tmpDir = mkdtempSync(join(tmpdir(), "releases-test-"));
  const dbPath = join(tmpDir, "test.db");
  const sqlite = new Database(dbPath);
  sqlite.run("PRAGMA journal_mode=WAL");
  sqlite.run("PRAGMA foreign_keys=ON");
  const db = drizzle(sqlite, { schema });

  applyMigrations(sqlite);

  return {
    db,
    dbPath,
    cleanup: () => {
      sqlite.close();
      rmSync(tmpDir, { recursive: true, force: true });
    },
  };
}

export function clearAllTables(db: TestDb): void {
  db.delete(schema.orgTags).run();
  db.delete(schema.productTags).run();
  db.delete(schema.releases).run();
  db.delete(schema.sources).run();
  db.delete(schema.orgAccounts).run();
  db.delete(schema.products).run();
  db.delete(schema.ignoredUrls).run();
  db.delete(schema.tags).run();
  db.delete(schema.domainAliases).run();
  db.delete(schema.organizations).run();
  db.delete(schema.blockedUrls).run();
}
```

The key changes: removed `import { migrate } from "drizzle-orm/bun-sqlite/migrator"`; removed the `migrationsFolder` constant; added `applyMigrations` export; `createTestDb` calls `applyMigrations(sqlite)` instead of `migrate(db, ...)`.

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test tests/unit/apply-migrations.test.ts`

Expected: Both specs PASS.

- [ ] **Step 5: Run the full suite to catch regressions in createTestDb consumers**

Run: `bun test`

Expected: All tests pass. `createTestDb` is used by several tests — they now apply wrangler migrations instead of drizzle migrations. Any newly-failing test likely means a dialect difference matters; investigate before proceeding.

- [ ] **Step 6: Commit**

```bash
git add tests/db-helper.ts tests/unit/apply-migrations.test.ts
git commit -m "test: add applyMigrations helper against workers/api/migrations (#397)"
```

---

## Task 3: Gitignore .drizzle-out/ and redirect drizzle.config.ts output

Non-destructive: point drizzle-kit at a gitignored dir before we touch the committed one.

**Files:**

- Modify: `.gitignore`
- Modify: `drizzle.config.ts`

- [ ] **Step 1: Add .drizzle-out/ to .gitignore**

Append to `.gitignore`:

```
# drizzle-kit generate output — scaffold only, source of truth is workers/api/migrations/
.drizzle-out/
```

- [ ] **Step 2: Update drizzle.config.ts**

Replace the contents of `drizzle.config.ts` with:

```ts
import { defineConfig } from "drizzle-kit";
import { homedir } from "os";
import { join } from "path";

const dataDir = process.env.RELEASED_DATA_DIR || join(homedir(), ".releases");

export default defineConfig({
  dialect: "sqlite",
  schema: [
    "./packages/core/src/schema.ts",
    "./src/db/schema-coverage.ts",
    "./workers/api/src/db/schema-cron.ts",
  ],
  out: "./.drizzle-out",
  migrations: {
    prefix: "timestamp",
  },
  dbCredentials: {
    url: join(dataDir, "releases.db"),
  },
});
```

- [ ] **Step 3: Verify drizzle-kit generate works with the new out path**

Run: `rm -rf .drizzle-out && bun run db:generate`

Expected: `.drizzle-out/` is created with a snapshot (drizzle-kit regenerates from schema.ts). The command exits 0.

- [ ] **Step 4: Verify CI drift check still works in tmp**

Run: `RELEASED_DATA_DIR=/tmp/drizzle-drift-check bunx drizzle-kit generate > /tmp/drift.log 2>&1 && grep -q "No schema changes" /tmp/drift.log && echo OK || echo FAIL`

Expected: `OK`.

- [ ] **Step 5: Clean up .drizzle-out before committing**

Run: `rm -rf .drizzle-out`

Expected: dir removed. It is gitignored so `git status` would not show it either way, but cleanliness aids review.

- [ ] **Step 6: Commit**

```bash
git add .gitignore drizzle.config.ts
git commit -m "chore: gitignore .drizzle-out and redirect drizzle-kit output (#397)"
```

---

## Task 4: Flip the 13 direct migrate() call sites to applyMigrations

Mechanical. Each file has a `makeDb()`-style helper that imports `migrate` from `drizzle-orm/bun-sqlite/migrator` and calls it with `{ migrationsFolder: "src/db/migrations" }`. Replace with an import of `applyMigrations` from `tests/db-helper.ts`.

**Files:**

- Modify: `tests/unit/sources-count.test.ts`
- Modify: `tests/unit/sitemap.test.ts`
- Modify: `tests/unit/release-coverage-collapse.test.ts`
- Modify: `tests/api/scrape-agent-sweep.test.ts` (two call sites — around lines 13 and 208)
- Modify: `tests/api/scrape-agent-candidate-query.test.ts` (two call sites — around lines 11 and 137)
- Modify: `tests/api/releases-batch-binds.test.ts`
- Modify: `tests/api/stale-running-reconciler.test.ts`
- Modify: `tests/api/cron-runs-migration.test.ts`
- Modify: `tests/api/cron-runs-dao.test.ts`
- Modify: `tests/api/cron-runs-bind-budget.test.ts`
- Modify: `tests/api/admin-cron-runs-helpers.ts`
- Modify: `tests/api/status-fetch-log-helpers.ts`
- Modify: `tests/api/retier-binds.test.ts`

- [ ] **Step 1: Apply the transformation to every file**

Example: `tests/api/cron-runs-dao.test.ts` before and after.

Before:

```ts
import { describe, it, expect } from "bun:test";
import { Database } from "bun:sqlite";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { migrate } from "drizzle-orm/bun-sqlite/migrator";
// ...
function makeDb() {
  const sqlite = new Database(":memory:");
  const db = drizzle(sqlite);
  migrate(db, { migrationsFolder: "src/db/migrations" });
  return { db, sqlite };
}
```

After:

```ts
import { describe, it, expect } from "bun:test";
import { Database } from "bun:sqlite";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { applyMigrations } from "../db-helper";
// ...
function makeDb() {
  const sqlite = new Database(":memory:");
  const db = drizzle(sqlite);
  applyMigrations(sqlite);
  return { db, sqlite };
}
```

Rules per file:

1. Delete the line `import { migrate } from "drizzle-orm/bun-sqlite/migrator";`.
2. Add `import { applyMigrations } from "../db-helper";` (relative path is `../db-helper` from both `tests/api/*.ts` and `tests/unit/*.ts`).
3. Replace every `migrate(db, { migrationsFolder: "src/db/migrations" });` with `applyMigrations(sqlite);`. Pass the raw `sqlite` handle, not the drizzle `db` wrapper.
4. If the file creates `drizzle(new Database(":memory:"))` inline without keeping a `sqlite` reference, hoist the `sqlite` declaration onto its own line first so `applyMigrations(sqlite)` has something to call.
5. `scrape-agent-sweep.test.ts` and `scrape-agent-candidate-query.test.ts` each have two call sites — apply to both.

- [ ] **Step 2: Run the full suite**

Run: `bun test`

Expected: All tests pass. If any test fails with `sqlite.exec is not a function` or similar, a call site still references `db` (drizzle wrapper) instead of `sqlite` (raw `bun:sqlite` handle). Fix and re-run.

- [ ] **Step 3: Run type check**

Run: `npx tsc --noEmit`

Expected: No errors.

- [ ] **Step 4: Verify no direct imports of drizzle-orm/bun-sqlite/migrator remain**

Run: `rg "bun-sqlite/migrator" --type ts`

Expected: Zero matches anywhere in the repo.

- [ ] **Step 5: Commit**

```bash
git add tests/
git commit -m "test: route all 14 call sites through applyMigrations (#397)"
```

---

## Task 5: Delete src/db/migrations/

Now safe — no code references it.

**Files:**

- Delete: `src/db/migrations/` (entire directory)

- [ ] **Step 1: Verify nothing still references src/db/migrations in code**

Run: `rg "src/db/migrations" --type ts --type js --type json --type sh`

Expected: Matches only in docs (AGENTS.md, spec/plan files, old plan docs under `docs/superpowers/plans/`) and `scripts/check-migration-filenames.sh` (handled in Task 6). No matches in `tests/`, `workers/`, `packages/`, or `drizzle.config.ts`.

If matches appear in live code, go back to Task 4 and finish the flip.

- [ ] **Step 2: Delete the directory**

Run: `rm -rf src/db/migrations`

Expected: dir removed. `src/db/` now contains only `schema-coverage.ts`.

- [ ] **Step 3: Run the full suite once more**

Run: `bun test`

Expected: All tests pass. Confirms nothing was silently depending on the dir existing.

- [ ] **Step 4: Commit**

```bash
git add -A src/db/migrations
git commit -m "chore: delete src/db/migrations — workers/api/migrations is now the single source of truth (#397)"
```

---

## Task 6: Update scripts/check-migration-filenames.sh

Drop the `src/db/migrations/*.sql` glob. Update the help message.

**Files:**

- Modify: `scripts/check-migration-filenames.sh`

- [ ] **Step 1: Replace the script contents**

Overwrite `scripts/check-migration-filenames.sh` with:

```bash
#!/usr/bin/env bash
# Fails if any migration file added on the current branch uses the legacy
# NNNN_ numeric prefix. New migrations must use a YYYYMMDDHHMMSS_ timestamp
# prefix to prevent filename collisions between concurrent branches.
#
# Existing numeric files (0000..0011) are grandfathered in — renaming them
# would break the d1_migrations tracking state on already-migrated DBs.
set -euo pipefail

base="${1:-origin/main}"

added=$(git diff --name-only --diff-filter=A "$base"...HEAD -- \
  'workers/api/migrations/*.sql' || true)

if [ -z "$added" ]; then
  exit 0
fi

bad=$(echo "$added" | grep -E '/[0-9]{4}_[^/]+\.sql$' || true)

if [ -n "$bad" ]; then
  echo "ERROR: New migration files must use a timestamp prefix (YYYYMMDDHHMMSS_*.sql)." >&2
  echo "Offending files:" >&2
  echo "$bad" | sed 's/^/  /' >&2
  echo >&2
  echo "Generate the timestamp with: date +%Y%m%d%H%M%S" >&2
  exit 1
fi
```

Changes from the existing script:

- Glob list drops `'src/db/migrations/*.sql'`.
- Header comment drops the "Drizzle" reference.
- Help message drops the Drizzle-specific instruction.

- [ ] **Step 2: Smoke-test the script**

Run: `./scripts/check-migration-filenames.sh origin/main`

Expected: Exit 0 (no new migration files added on this branch).

- [ ] **Step 3: Commit**

```bash
git add scripts/check-migration-filenames.sh
git commit -m "chore: drop src/db/migrations glob from filename check (#397)"
```

---

## Task 7: Add pairing-check step to CI

Enforces that a PR changing `schema.ts` (such that drizzle-kit would emit new DDL) also adds at least one file under `workers/api/migrations/`. Closes the root cause of #397.

**Files:**

- Modify: `.github/workflows/ci.yml`

- [ ] **Step 1: Locate the existing drift-check step**

Run: `grep -n "uncommitted schema drift\|drizzle-drift-check" .github/workflows/ci.yml`

Expected: matches around lines 53–60 (the `Check for uncommitted schema drift` step added earlier).

- [ ] **Step 2: Replace the drift-check step and add the pairing check**

In `.github/workflows/ci.yml`, replace the existing drift-check step block with this two-step sequence (indent matches the surrounding `steps:` list):

```yaml
- name: Check for uncommitted schema drift
  run: |
    RELEASED_DATA_DIR=/tmp/drizzle-drift-check bunx drizzle-kit generate > /tmp/drift.log 2>&1
    if ! grep -q "No schema changes" /tmp/drift.log; then
      echo "ERROR: schema.ts has uncommitted changes." >&2
      echo "Run 'bun run db:generate' to preview the SQL, then hand-author the" >&2
      echo "corresponding file under workers/api/migrations/ (wrangler is the source of truth)." >&2
      tail -20 /tmp/drift.log >&2
      exit 1
    fi

- name: Pair schema.ts changes with a wrangler migration (PR only)
  if: github.event_name == 'pull_request'
  env:
    BASE_REF: ${{ github.base_ref }}
  run: |
    # If drizzle-kit would emit new DDL, require at least one added file
    # under workers/api/migrations/ on this PR. Catches the #397 class
    # of bug: schema.ts changed but no wrangler migration authored.
    RELEASED_DATA_DIR=/tmp/drizzle-pair-check bunx drizzle-kit generate > /tmp/pair.log 2>&1 || true
    if grep -q "No schema changes" /tmp/pair.log; then
      echo "No schema changes — pairing check skipped."
      exit 0
    fi
    added=$(git diff --name-only --diff-filter=A "origin/$BASE_REF"...HEAD -- 'workers/api/migrations/*.sql' || true)
    if [ -z "$added" ]; then
      echo "ERROR: schema.ts changes would emit new DDL, but this PR adds no file under workers/api/migrations/." >&2
      echo "Hand-author the wrangler migration and commit it alongside the schema.ts change." >&2
      echo "Preview with: bun run db:generate (output goes to .drizzle-out/)." >&2
      tail -20 /tmp/pair.log >&2
      exit 1
    fi
    echo "Found new wrangler migration file(s):"
    echo "$added" | sed 's/^/  /'
```

Key invariants:

- Runs `drizzle-kit generate` into a fresh tmp data dir (`/tmp/drizzle-pair-check`), isolated from the drift-check dir.
- Uses `|| true` on the generate command because drizzle-kit may exit non-zero when it generates output; we want to inspect the log, not fail on exit code.
- Restricted to `if: github.event_name == 'pull_request'` because it needs a base ref to diff against.
- Uses `origin/$BASE_REF` matching the existing migration-filenames check.

- [ ] **Step 3: Commit**

```bash
git add .github/workflows/ci.yml
git commit -m "ci: pair schema.ts changes with a wrangler migration (#397)"
```

---

## Task 8: Docs updates — AGENTS.md, README.md, remote-mode.md

Remove references to `src/db/migrations/` as a separate dir; describe the new developer flow.

**Files:**

- Modify: `AGENTS.md`
- Modify: `README.md`
- Modify: `docs/architecture/remote-mode.md`

- [ ] **Step 1: Update AGENTS.md**

Locate the line in the "Surviving `src/` tree" section:

```
- `src/db/schema-coverage.ts`, `src/db/migrations/` — release_coverage schema + drizzle-kit migration output.
```

Replace with:

```
- `src/db/schema-coverage.ts` — release_coverage schema (part of the drizzle composite schema).
```

- [ ] **Step 2: Update README.md**

Locate the `db:generate` line:

```
bun run db:generate          # generate a D1 migration after a schema change
```

Replace with:

```
bun run db:generate          # scaffold a migration preview under .drizzle-out/ (then hand-author the real file under workers/api/migrations/)
```

- [ ] **Step 3: Update docs/architecture/remote-mode.md**

Run: `grep -n "src/db/migrations\|drizzle-kit\|migrations" docs/architecture/remote-mode.md`

For each match that describes `src/db/migrations/` as a separate migration dir, rewrite to point to `workers/api/migrations/` as the single source of truth.

If no match currently describes a parallel-dir setup, add one paragraph under the "Migrations" section (create the section if absent):

> D1 schema DDL lives exclusively in `workers/api/migrations/`. Prod applies it via `wrangler d1 migrations apply --remote` (automated in the API-worker deploy). Tests apply the same files via `tests/db-helper.ts` → `applyMigrations(sqlite)`, ensuring prod and tests share a single schema history. `schema.ts` is the source of truth for drizzle ORM types and drizzle-kit introspection; `drizzle-kit generate` exists as a scaffold only — its output is gitignored under `.drizzle-out/`.

- [ ] **Step 4: Commit**

```bash
git add AGENTS.md README.md docs/architecture/remote-mode.md
git commit -m "docs: update migration conventions for the single-dir world (#397)"
```

---

## Task 9: Full verification pass

Before opening the PR, confirm every check passes locally.

- [ ] **Step 1: Type-check**

Run: `npx tsc --noEmit`

Expected: No errors.

- [ ] **Step 2: Lint**

Run: `bun run lint`

Expected: No errors.

- [ ] **Step 3: Format**

Run: `bun run format:check`

Expected: No errors. If the formatter complains about edited files, run `bun run format` and commit the result.

- [ ] **Step 4: Full test suite**

Run: `bun test`

Expected: All pass.

- [ ] **Step 5: Drift check locally**

Run: `RELEASED_DATA_DIR=/tmp/drizzle-drift-check bunx drizzle-kit generate > /tmp/drift.log 2>&1 && grep -q "No schema changes" /tmp/drift.log && echo OK || (tail -20 /tmp/drift.log; echo FAIL)`

Expected: `OK`.

- [ ] **Step 6: Filename check**

Run: `./scripts/check-migration-filenames.sh origin/main`

Expected: Exit 0.

- [ ] **Step 7: Verify apply-migrations.test runs in isolation**

Run: `bun test tests/unit/apply-migrations.test.ts`

Expected: Both specs pass independently of the rest of the suite.

---

## Task 10: Delete the verification script

- [ ] **Step 1: Delete the script**

Run: `rm scripts/diff-migration-schemas.ts`

- [ ] **Step 2: Confirm no reference remains**

Run: `rg "diff-migration-schemas" --type ts --type sh --type yaml --type md`

Expected: Matches only in this plan and the spec.

- [ ] **Step 3: Commit**

```bash
git add -A scripts/diff-migration-schemas.ts
git commit -m "chore: delete one-shot migration verification script (#397)"
```

---

## Task 11: Push and open PR

- [ ] **Step 1: Push**

```bash
git push -u origin fix/397-unify-migration-dirs
```

- [ ] **Step 2: Write the PR body to a temp file**

```bash
cat > /tmp/pr-397-body.md <<'BODY'
## Summary

Closes #397. Unifies D1 migration directories on `workers/api/migrations/` as the single source of truth. Tests now run against the same SQL `wrangler d1 migrations apply` runs in prod, closing the FTS5 gap and the dialect-divergence class of bugs that produced the 2026-04-19 nightly email outage.

- Delete `src/db/migrations/` (18 files + meta/).
- Route all 14 test call sites through a new `applyMigrations(sqlite)` helper in `tests/db-helper.ts`.
- Redirect `drizzle-kit generate` output to a gitignored `.drizzle-out/`.
- Add a CI pairing check that fails PRs changing `schema.ts` without a paired `workers/api/migrations/*.sql` file — closes the root cause of #397.

Spec: `docs/superpowers/specs/2026-04-20-unify-d1-migration-dirs-design.md`
Plan: `docs/superpowers/plans/2026-04-20-unify-d1-migration-dirs.md`

Drizzle ORM, `schema.ts`, Drizzle Studio, and the existing schema-drift check are all preserved.

## Test plan

- [x] `bun test` — full suite passes with wrangler migrations applied in place of drizzle.
- [x] `npx tsc --noEmit` — no errors.
- [x] `bun run lint` / `bun run format:check` — clean.
- [x] Drift check: `bunx drizzle-kit generate` into tmp still reports "No schema changes" on this branch.
- [x] Verification gate: `workers/api/migrations/` applied to a scratch DB is a superset of `src/db/migrations/` (FTS5 extras only). One-shot script landed in Task 1, removed in Task 10.
- [ ] CI: pairing check runs on this PR (no-op — no schema.ts change) and on a synthetic test PR.
BODY
```

- [ ] **Step 3: Open the PR**

```bash
gh pr create --title "fix: unify D1 migration dirs on workers/api/migrations (#397)" --body-file /tmp/pr-397-body.md
```

Expected: PR URL printed.

- [ ] **Step 4: Share the PR URL with the user**

---

## Self-review notes

**Spec coverage:**

- Delete `src/db/migrations/` → Task 5.
- Change `drizzle.config.ts` out path to gitignored dir → Task 3.
- Add `applyMigrations(sqlite)` helper → Task 2.
- Replace 14 test call sites → Task 2 (db-helper) + Task 4 (13 others).
- Update `scripts/check-migration-filenames.sh` → Task 6.
- Update `ci.yml` drift-check message + new pairing check → Task 7.
- Add `.drizzle-out/` to `.gitignore` → Task 3.
- Update AGENTS.md, README.md, remote-mode.md → Task 8.
- Verification gate before deletion → Task 1; deletion is Task 5.
- Rollback path: every task is its own commit; `git revert` works at any granularity.

**Ambiguity resolved:**

- `grep -q "No schema changes"` matches the existing drift-check pattern — stable.
- Pass the raw `sqlite` handle to `applyMigrations`, not the drizzle `db` wrapper — spelled out in Task 4 Step 1 rule 3.
- Test file relative path is `../db-helper` from both `tests/unit/` and `tests/api/` — spelled out in Task 4 Step 1 rule 2.

**Risks:**

- Drift check slightly weaker than before → new pairing check in Task 7 covers the real root cause.
- Test runtime regression → surfaced by `bun test` in Task 2 Step 5 and Task 4 Step 2.
- Dialect-dependent test failure → `bun test` will catch; investigate, don't paper over.
- Drizzle Studio → untouched; `drizzle-d1.config.ts` explicitly out of scope.
