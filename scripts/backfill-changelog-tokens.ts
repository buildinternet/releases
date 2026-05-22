#!/usr/bin/env bun
/**
 * Backfill exact cl100k_base token counts for oversized changelog rows.
 *
 * Context: `countTokensSafe` in src/lib/tokens.ts falls back to a chars/4
 * heuristic for inputs ≥256KB to bound BPE latency on the hot upsert path.
 * Rows written above that cap therefore store an approximate total in
 * `source_changelog_files.tokens`. This one-off script recomputes an exact
 * total by splitting each file on `##` headings and encoding every section
 * independently — each chunk stays well under the cap, so BPE stays bounded.
 *
 * Lists oversized rows via `GET /v1/sources/changelog-files/oversized`,
 * fetches content via `GET /v1/sources/:slug/changelog`, and writes back
 * via `PATCH /v1/sources/:slug/changelog/tokens`. Requires
 * RELEASES_API_URL and admin RELEASES_API_KEY in env.
 *
 * Usage:
 *   bun scripts/backfill-changelog-tokens.ts                 # dry run (default)
 *   bun scripts/backfill-changelog-tokens.ts --apply         # actually write
 *   bun scripts/backfill-changelog-tokens.ts --source <slug> # one row
 *   bun scripts/backfill-changelog-tokens.ts --json          # machine-readable
 *
 * Conventions: all progress/logs go to stderr. Only `--json` output goes
 * to stdout, after all rows are processed.
 */

import { Tiktoken } from "js-tiktoken/lite";
import cl100k_base from "js-tiktoken/ranks/cl100k_base";

import { logger } from "@buildinternet/releases-lib/logger";
import { adminGet, adminPatch as adminPatchClient } from "./lib/admin-client.js";

const API_URL = process.env.RELEASES_API_URL ?? process.env.RELEASED_API_URL;

// Matches LIVE_ENCODE_MAX_CHARS in src/lib/tokens.ts. Kept as a local
// constant so the script doesn't depend on an internal export.
const LIVE_ENCODE_MAX_CHARS = 256 * 1024;

let _encoder: Tiktoken | null = null;
function encoder(): Tiktoken {
  if (_encoder === null) _encoder = new Tiktoken(cl100k_base);
  return _encoder;
}

/**
 * Split on `##` headings (ATX H2) and encode each section independently.
 * Any preamble before the first `##` is encoded as its own chunk so the
 * sum matches a whole-file encode exactly. Section boundaries are safe
 * split points for BPE — merges rarely cross `\n##` — and every slice is
 * far smaller than the 256KB cap, so Tiktoken stays O(n).
 */
export function exactTokensBySection(content: string): number {
  if (content.length === 0) return 0;

  const sections: string[] = [];
  let lineStart = 0;
  let sectionStart = 0;
  const enc = encoder();

  for (let i = 0; i <= content.length; i++) {
    if (i === content.length || content[i] === "\n") {
      const line = content.slice(lineStart, i);
      // H2 heading: exactly two `#`, then space/tab.
      if (
        line.length >= 3 &&
        line[0] === "#" &&
        line[1] === "#" &&
        line[2] !== "#" &&
        (line[2] === " " || line[2] === "\t")
      ) {
        if (lineStart > sectionStart) {
          sections.push(content.slice(sectionStart, lineStart));
        }
        sectionStart = lineStart;
      }
      lineStart = i + 1;
    }
  }
  if (sectionStart < content.length) {
    sections.push(content.slice(sectionStart));
  }

  let total = 0;
  for (const section of sections) {
    if (section.length === 0) continue;
    // Matches tokens.ts: tolerate literal `<|endoftext|>` etc. in source bodies.
    total += enc.encode(section, "all", []).length;
  }
  return total;
}

interface BackfillRow {
  sourceSlug: string;
  path: string;
  filename: string;
  bytes: number;
  oldTokens: number | null;
  newTokens: number;
  delta: number;
}

interface ParsedArgs {
  apply: boolean;
  json: boolean;
  source: string | null;
}

function parseArgs(argv: string[]): ParsedArgs {
  const args: ParsedArgs = { apply: false, json: false, source: null };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--apply") args.apply = true;
    else if (arg === "--dry-run") args.apply = false;
    else if (arg === "--json") args.json = true;
    else if (arg === "--source") args.source = argv[++i] ?? null;
    else if (arg?.startsWith("--source=")) args.source = arg.slice("--source=".length);
    else if (arg === "--help" || arg === "-h") {
      process.stdout.write(
        [
          "Usage: bun scripts/backfill-changelog-tokens.ts [options]",
          "",
          "Options:",
          "  --apply           Actually write the new token counts (default: dry run)",
          "  --source <slug>   Only process the changelog file for one source",
          "  --json            Emit a machine-readable JSON summary to stdout",
          "  -h, --help        Show this message",
          "",
        ].join("\n"),
      );
      process.exit(0);
    } else if (arg && arg !== "--dry-run") {
      logger.warn(`unknown arg: ${arg}`);
    }
  }
  return args;
}

// ── API helpers ────────────────────────────────────────────────────────────
// Thin wrappers that strip the leading "/v1" prefix (the admin client adds it)
// and enforce required semantics (throwOnError: true).

const REQUIRED = { throwOnError: true as const };

interface OversizedRowResponse {
  sourceId: string;
  sourceSlug: string;
  sourceName: string;
  orgSlug: string;
  path: string;
  filename: string;
  bytes: number;
  tokens: number | null;
  fetchedAt: string;
}

async function apiGet<T>(path: string): Promise<T> {
  // Strip the /v1 prefix — admin-client prepends it internally.
  const result = await adminGet<T>(path.replace(/^\/v1/, ""), REQUIRED);
  // With throwOnError: true, null only occurs on 204/empty-body responses,
  // never for real data endpoints.
  return result as T;
}

async function apiPatch(path: string, body: unknown): Promise<void> {
  await adminPatchClient(path.replace(/^\/v1/, ""), body, REQUIRED);
}

async function run(args: ParsedArgs): Promise<BackfillRow[]> {
  const all = await apiGet<OversizedRowResponse[]>(
    `/v1/sources/changelog-files/oversized?minBytes=${LIVE_ENCODE_MAX_CHARS}`,
  );
  const filtered = args.source ? all.filter((r) => r.sourceSlug === args.source) : all;
  logger.info(
    `remote: ${all.length} oversized row(s) reported by API; processing ${filtered.length}`,
  );

  const out: BackfillRow[] = [];
  for (const row of filtered) {
    // Fetch the full file content via the existing changelog GET. Passing
    // no range params returns the full body verbatim.
    const sourcePath = `/v1/orgs/${encodeURIComponent(row.orgSlug)}/sources/${encodeURIComponent(row.sourceSlug)}`;
    // oxlint-disable-next-line no-await-in-loop -- sequential: fetch then conditionally patch each row; API rate limit applies
    const cl = await apiGet<{ content: string; path: string; bytes: number }>(
      `${sourcePath}/changelog?path=${encodeURIComponent(row.path)}`,
    );
    const newTokens = exactTokensBySection(cl.content);
    const oldTokens = row.tokens;
    const delta = oldTokens === null ? newTokens : newTokens - oldTokens;
    const summary: BackfillRow = {
      sourceSlug: row.sourceSlug,
      path: row.path,
      filename: row.filename,
      bytes: row.bytes,
      oldTokens,
      newTokens,
      delta,
    };
    out.push(summary);
    logger.info(
      `[${args.apply ? "apply" : "dry-run"}] ${row.sourceSlug} (${row.path}) ` +
        `bytes=${row.bytes} old=${oldTokens ?? "null"} new=${newTokens} delta=${delta >= 0 ? "+" : ""}${delta}`,
    );
    if (args.apply) {
      // oxlint-disable-next-line no-await-in-loop -- sequential: must patch after fetch completes; API rate limit applies
      await apiPatch(`${sourcePath}/changelog/tokens`, {
        tokens: newTokens,
        path: row.path,
      });
    }
  }
  return out;
}

// ── Entry point ────────────────────────────────────────────────────────────

async function main() {
  if (!API_URL) {
    throw new Error("RELEASES_API_URL must be set");
  }
  const args = parseArgs(process.argv.slice(2));
  logger.info(
    `backfill-changelog-tokens starting (${args.apply ? "APPLY" : "dry-run"}` +
      `${args.source ? `, source=${args.source}` : ""})`,
  );

  const rows = await run(args);

  const totalDelta = rows.reduce((sum, r) => sum + r.delta, 0);
  logger.info(
    `processed ${rows.length} row(s); total delta=${totalDelta >= 0 ? "+" : ""}${totalDelta}` +
      `${args.apply ? " (written)" : " (dry run — rerun with --apply to persist)"}`,
  );

  if (args.json) {
    process.stdout.write(
      JSON.stringify(
        {
          apply: args.apply,
          source: args.source,
          processed: rows.length,
          totalDelta,
          rows,
        },
        null,
        2,
      ) + "\n",
    );
  }
}

main().catch((err) => {
  logger.error(err instanceof Error ? (err.stack ?? err.message) : String(err));
  process.exit(1);
});
