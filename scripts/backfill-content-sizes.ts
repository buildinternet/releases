#!/usr/bin/env bun
/**
 * Backfill `releases.content_chars` / `releases.content_tokens` for rows
 * that pre-date the columns (added in
 * `20260514000200_releases_content_size.sql`). New ingest paths populate
 * the columns; this one-off sweeps everything else so feed surfaces can
 * surface a size hint on every row.
 *
 * Walks `releases` in id-ASC pages where either column is NULL, computes
 * the size in TS via `@buildinternet/releases-core/tokens`, and writes
 * UPDATEs in chunked SQL files. Idempotent — re-running picks up exactly
 * the rows still NULL.
 *
 * Usage:
 *   bun scripts/backfill-content-sizes.ts                    # dry run, prod DB
 *   bun scripts/backfill-content-sizes.ts --apply
 *   bun scripts/backfill-content-sizes.ts --db released-db-staging --apply
 *
 * Requires `wrangler whoami` authenticated to the right account.
 */

import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { computeContentSize } from "@buildinternet/releases-core/tokens";

interface Args {
  apply: boolean;
  db: string;
  remote: boolean;
  pageSize: number;
  chunkSize: number;
}

function parseArgs(argv: string[]): Args {
  const args: Args = {
    apply: false,
    db: "released-db",
    remote: true,
    pageSize: 500,
    chunkSize: 200,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--apply") args.apply = true;
    else if (a === "--local") args.remote = false;
    else if (a === "--db") args.db = argv[++i] ?? args.db;
    else if (a?.startsWith("--db=")) args.db = a.slice("--db=".length);
    else if (a === "--page") args.pageSize = Number(argv[++i] ?? args.pageSize);
    else if (a === "--chunk") args.chunkSize = Number(argv[++i] ?? args.chunkSize);
    else if (a === "--help" || a === "-h") {
      process.stdout.write(
        [
          "Usage: bun scripts/backfill-content-sizes.ts [options]",
          "",
          "Options:",
          "  --apply            Write the UPDATEs (default: dry run)",
          "  --db <name>        Target D1 database (default: released-db)",
          "  --local            Use --local instead of --remote",
          "  --page <n>         Rows fetched per SELECT (default: 500)",
          "  --chunk <n>        UPDATEs per file passed to wrangler (default: 200)",
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
  content: string | null;
}

function escapeSqlLiteral(v: string): string {
  return `'${v.replace(/'/g, "''")}'`;
}

function fetchPage(
  db: string,
  remote: boolean,
  afterId: string | null,
  pageSize: number,
): ReleaseRow[] {
  // Walk by id ASC for a deterministic, resumable cursor. Filter on the
  // missing-cache predicate so re-running picks up exactly the rows still
  // pending — including ones that landed after a prior pass started.
  const where = afterId
    ? `WHERE (content_chars IS NULL OR content_tokens IS NULL) AND id > ${escapeSqlLiteral(afterId)}`
    : `WHERE content_chars IS NULL OR content_tokens IS NULL`;
  const sql = `SELECT id, content FROM releases ${where} ORDER BY id ASC LIMIT ${pageSize}`;
  const out = wranglerExecute(db, remote, sql);
  const parsed = JSON.parse(out);
  const results = Array.isArray(parsed) ? parsed[0]?.results : parsed?.results;
  return (results ?? []) as ReleaseRow[];
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  process.stderr.write(
    `Backfilling content_chars / content_tokens on ${args.db} (${args.remote ? "remote" : "local"})${
      args.apply ? "" : " — DRY RUN"
    }\n`,
  );

  const tmp = mkdtempSync(join(tmpdir(), "content-sizes-"));
  let scanned = 0;
  let updated = 0;
  let cursor: string | null = null;

  try {
    while (true) {
      const page = fetchPage(args.db, args.remote, cursor, args.pageSize);
      if (page.length === 0) break;
      cursor = page[page.length - 1].id;
      scanned += page.length;

      const updates: string[] = [];
      for (const row of page) {
        const { contentChars, contentTokens } = computeContentSize(row.content);
        updates.push(
          `UPDATE releases SET content_chars = ${contentChars}, content_tokens = ${contentTokens} WHERE id = ${escapeSqlLiteral(row.id)};`,
        );
      }
      updated += updates.length;

      if (args.apply && updates.length > 0) {
        for (let i = 0; i < updates.length; i += args.chunkSize) {
          const chunk = updates.slice(i, i + args.chunkSize).join("\n");
          const file = join(tmp, `chunk-${cursor}-${i}.sql`);
          writeFileSync(file, chunk);
          wranglerExecuteFile(args.db, args.remote, file);
        }
      }

      process.stderr.write(`  scanned=${scanned} would_update=${updated} cursor=${cursor}\n`);
    }
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }

  process.stderr.write(`Done. scanned=${scanned} would_update=${updated} apply=${args.apply}\n`);
}

await main();
