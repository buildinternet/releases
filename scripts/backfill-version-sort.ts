#!/usr/bin/env bun
/**
 * Backfill `releases.version_sort` for rows that have a non-null `version`
 * but no `version_sort` yet. Computes the sortable key in TS via
 * `computeVersionSort()` and writes UPDATEs in chunks via
 * `wrangler d1 execute`.
 *
 * Context: the column was added in migration
 * `20260514000000_releases_version_sort.sql`. New ingest paths populate it,
 * but existing rows need this one-off backfill so the `latest_version`
 * aggregate stops falling back to date-based ordering (which mis-ranks
 * backports against the active major).
 *
 * Usage:
 *   bun scripts/backfill-version-sort.ts                    # dry run, prod DB
 *   bun scripts/backfill-version-sort.ts --apply            # write
 *   bun scripts/backfill-version-sort.ts --db released-db-staging --apply
 *
 * Requires `wrangler whoami` authenticated to the right account.
 */

import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { computeVersionSort } from "@buildinternet/releases-core/version-sort";

interface Args {
  apply: boolean;
  db: string;
  remote: boolean;
  chunkSize: number;
}

function parseArgs(argv: string[]): Args {
  const args: Args = { apply: false, db: "released-db", remote: true, chunkSize: 500 };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--apply") args.apply = true;
    else if (a === "--local") args.remote = false;
    else if (a === "--db") args.db = argv[++i] ?? args.db;
    else if (a?.startsWith("--db=")) args.db = a.slice("--db=".length);
    else if (a === "--chunk") args.chunkSize = Number(argv[++i] ?? args.chunkSize);
    else if (a === "--help" || a === "-h") {
      process.stdout.write(
        [
          "Usage: bun scripts/backfill-version-sort.ts [options]",
          "",
          "Options:",
          "  --apply            Write the UPDATEs (default: dry run)",
          "  --db <name>        Target D1 database (default: released-db)",
          "  --local            Use --local instead of --remote",
          "  --chunk <n>        Rows per UPDATE batch (default: 500)",
          "  -h, --help         Show this message",
          "",
        ].join("\n"),
      );
      process.exit(0);
    }
  }
  return args;
}

function wranglerExecute(db: string, remote: boolean, sql: string): string {
  const args = [
    "wrangler",
    "d1",
    "execute",
    db,
    remote ? "--remote" : "--local",
    "--json",
    "--command",
    sql,
  ];
  const res = spawnSync(args[0], args.slice(1), {
    cwd: "workers/api",
    encoding: "utf8",
    maxBuffer: 256 * 1024 * 1024,
  });
  if (res.status !== 0) {
    process.stderr.write(res.stderr);
    throw new Error(`wrangler exited with ${res.status}`);
  }
  return res.stdout;
}

function wranglerExecuteFile(db: string, remote: boolean, filePath: string): void {
  const args = [
    "wrangler",
    "d1",
    "execute",
    db,
    remote ? "--remote" : "--local",
    "--file",
    filePath,
  ];
  const res = spawnSync(args[0], args.slice(1), {
    cwd: "workers/api",
    encoding: "utf8",
    maxBuffer: 256 * 1024 * 1024,
  });
  if (res.status !== 0) {
    process.stderr.write(res.stderr);
    throw new Error(`wrangler exited with ${res.status}`);
  }
}

interface ReleaseRow {
  id: string;
  version: string;
}

function fetchPage(
  db: string,
  remote: boolean,
  afterId: string | null,
  pageSize: number,
): ReleaseRow[] {
  // Walk by id ASC for a deterministic, resumable cursor.
  const where = afterId
    ? `WHERE version IS NOT NULL AND version_sort IS NULL AND id > '${afterId.replace(/'/g, "''")}'`
    : `WHERE version IS NOT NULL AND version_sort IS NULL`;
  const sql = `SELECT id, version FROM releases ${where} ORDER BY id ASC LIMIT ${pageSize}`;
  const out = wranglerExecute(db, remote, sql);
  // wrangler --json returns [{ results: [...] }] (an array of one statement result).
  const parsed = JSON.parse(out);
  const results = Array.isArray(parsed) ? parsed[0]?.results : parsed?.results;
  return (results ?? []) as ReleaseRow[];
}

function escapeSqlLiteral(v: string): string {
  return `'${v.replace(/'/g, "''")}'`;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  process.stderr.write(
    `Backfilling version_sort on ${args.db} (${args.remote ? "remote" : "local"})${
      args.apply ? "" : " — DRY RUN"
    }\n`,
  );

  const tmp = mkdtempSync(join(tmpdir(), "version-sort-"));
  let total = 0;
  let updated = 0;
  let nulled = 0;
  let cursor: string | null = null;
  const PAGE = 1000;

  try {
    while (true) {
      const page = fetchPage(args.db, args.remote, cursor, PAGE);
      if (page.length === 0) break;
      cursor = page[page.length - 1].id;
      total += page.length;

      const updates: string[] = [];
      for (const row of page) {
        const sort = computeVersionSort(row.version);
        if (sort == null) {
          nulled++;
          continue;
        }
        updates.push(
          `UPDATE releases SET version_sort = ${escapeSqlLiteral(sort)} WHERE id = ${escapeSqlLiteral(row.id)};`,
        );
      }
      updated += updates.length;

      if (args.apply && updates.length > 0) {
        for (let i = 0; i < updates.length; i += args.chunkSize) {
          const chunk = updates.slice(i, i + args.chunkSize).join("\n");
          const file = join(tmp, `chunk-${i}.sql`);
          writeFileSync(file, chunk);
          wranglerExecuteFile(args.db, args.remote, file);
        }
      }

      process.stderr.write(
        `  scanned=${total} updated=${updated} non_semver=${nulled} cursor=${cursor}\n`,
      );
    }
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }

  process.stderr.write(
    `Done. scanned=${total} would_update=${updated} non_semver=${nulled} apply=${args.apply}\n`,
  );
}

await main();
