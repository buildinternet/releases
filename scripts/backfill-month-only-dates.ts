#!/usr/bin/env bun
/**
 * Backfill `published_at` for releases whose title is a bare month-year
 * (e.g. "March 2026") and whose stored `published_at` does not equal the
 * deterministic first-of-month value.
 *
 * Context: the AI extractor historically returned `publishedAt: null` for
 * monthly-changelog sections. The ingest path now applies `inferMonthOnlyDate`
 * at write time (#926), but existing rows in the DB still carry incorrect
 * dates (either null or the `fetched_at` fallback). This script corrects them.
 *
 * Strategy:
 *   1. List all sources matching an optional --org filter (default: all).
 *   2. For each source, fetch its releases (limit 500).
 *   3. For each release whose title matches inferMonthOnlyDate and whose
 *      stored publishedAt differs from the inferred value, PATCH it.
 *
 * Usage:
 *   bun scripts/backfill-month-only-dates.ts                  # dry run
 *   bun scripts/backfill-month-only-dates.ts --apply          # write
 *   bun scripts/backfill-month-only-dates.ts --org upstash    # one org
 *   bun scripts/backfill-month-only-dates.ts --json           # machine output
 */

import { inferMonthOnlyDate } from "@buildinternet/releases-core/dates";
import { logger } from "@buildinternet/releases-lib/logger";
import { adminGet, adminPatch as adminPatchClient } from "./lib/admin-client.js";

const API_URL = process.env.RELEASES_API_URL ?? process.env.RELEASED_API_URL;

interface ParsedArgs {
  apply: boolean;
  json: boolean;
  org: string | null;
  source: string | null;
}

function parseArgs(argv: string[]): ParsedArgs {
  const args: ParsedArgs = { apply: false, json: false, org: null, source: null };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--apply") args.apply = true;
    else if (arg === "--dry-run") args.apply = false;
    else if (arg === "--json") args.json = true;
    else if (arg === "--org") args.org = argv[++i] ?? null;
    else if (arg?.startsWith("--org=")) args.org = arg.slice("--org=".length);
    else if (arg === "--source") args.source = argv[++i] ?? null;
    else if (arg?.startsWith("--source=")) args.source = arg.slice("--source=".length);
    else if (arg === "--help" || arg === "-h") {
      process.stdout.write(
        [
          "Usage: bun scripts/backfill-month-only-dates.ts [options]",
          "",
          "Options:",
          "  --apply           Actually write the corrected dates (default: dry run)",
          "  --org <slug>      Only process sources for one org",
          "  --source <slug>   Only process one source (org/slug format)",
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

interface SourceItem {
  id: string;
  slug: string;
  orgSlug: string;
  name: string;
}

// GET /v1/sources returns an array directly (no wrapper object).
type SourcesResponse = SourceItem[];

interface ReleaseItem {
  id: string;
  title: string;
  publishedAt: string | null;
}

interface ReleasesResponse {
  releases: ReleaseItem[];
  // The source releases feed is cursor-paginated — see AGENTS.md "Pagination shape".
  pagination: { nextCursor: string | null; limit: number };
}

interface BackfillRow {
  releaseId: string;
  title: string;
  sourceSlug: string;
  orgSlug: string;
  oldPublishedAt: string | null;
  newPublishedAt: string;
}

async function listSources(orgSlug?: string | null): Promise<SourceItem[]> {
  const all: SourceItem[] = [];
  let page = 1;
  // oxlint-disable-next-line no-constant-condition
  while (true) {
    const qs = new URLSearchParams({ page: String(page), limit: "100" });
    if (orgSlug) qs.set("orgSlug", orgSlug);
    // oxlint-disable-next-line no-await-in-loop -- sequential pagination
    const res = await apiGet<SourcesResponse>(`/v1/sources?${qs}`);
    // The endpoint returns a bare array
    const page_items = Array.isArray(res) ? res : [];
    all.push(...page_items);
    // The endpoint doesn't carry hasMore on the bare-array form; stop when we
    // get fewer than limit items (meaning this is the last page).
    if (page_items.length < 100) break;
    page++;
  }
  return all;
}

async function listReleases(orgSlug: string, sourceSlug: string): Promise<ReleaseItem[]> {
  const all: ReleaseItem[] = [];
  let cursor: string | null = null;
  // oxlint-disable-next-line no-constant-condition
  while (true) {
    const qs = new URLSearchParams({ limit: "100" });
    if (cursor) qs.set("cursor", cursor);
    // oxlint-disable-next-line no-await-in-loop -- sequential pagination
    const res = await apiGet<ReleasesResponse>(
      `/v1/orgs/${encodeURIComponent(orgSlug)}/sources/${encodeURIComponent(sourceSlug)}/releases?${qs}`,
    );
    all.push(...(res.releases ?? []));
    cursor = res.pagination?.nextCursor ?? null;
    if (!cursor) break;
  }
  return all;
}

async function run(args: ParsedArgs): Promise<BackfillRow[]> {
  let sources: SourceItem[];
  if (args.source) {
    const parts = args.source.includes("/") ? args.source.split("/", 2) : null;
    if (parts) {
      sources = [{ id: "", slug: parts[1]!, orgSlug: parts[0]!, name: args.source }];
    } else if (args.org) {
      sources = [{ id: "", slug: args.source, orgSlug: args.org, name: args.source }];
    } else {
      throw new Error("--source requires either org/slug format or --org");
    }
  } else {
    sources = await listSources(args.org);
    logger.info(`found ${sources.length} source(s) to scan`);
  }

  const out: BackfillRow[] = [];

  for (const src of sources) {
    // oxlint-disable-next-line no-await-in-loop -- sequential per-source; API rate-limit applies
    const releases = await listReleases(src.orgSlug, src.slug);
    const candidates = releases.filter((r) => {
      const inferred = inferMonthOnlyDate(r.title);
      if (!inferred) return false;
      return r.publishedAt !== inferred;
    });

    if (candidates.length === 0) {
      logger.info(`${src.orgSlug}/${src.slug}: no affected releases (${releases.length} total)`);
      continue;
    }

    logger.info(
      `${src.orgSlug}/${src.slug}: ${candidates.length} release(s) to backfill (of ${releases.length} total)`,
    );

    for (const rel of candidates) {
      const newPublishedAt = inferMonthOnlyDate(rel.title)!;
      const row: BackfillRow = {
        releaseId: rel.id,
        title: rel.title,
        sourceSlug: src.slug,
        orgSlug: src.orgSlug,
        oldPublishedAt: rel.publishedAt,
        newPublishedAt,
      };
      out.push(row);
      logger.info(
        `  [${args.apply ? "PATCH" : "dry-run"}] ${rel.id} "${rel.title}": ` +
          `${rel.publishedAt ?? "null"} -> ${newPublishedAt}`,
      );
      if (args.apply) {
        // oxlint-disable-next-line no-await-in-loop -- sequential: patch one at a time; API rate-limit applies
        await apiPatch(`/v1/releases/${rel.id}`, { publishedAt: newPublishedAt });
      }
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
    `backfill-month-only-dates starting (${args.apply ? "APPLY" : "dry-run"}` +
      `${args.org ? `, org=${args.org}` : ""}` +
      `${args.source ? `, source=${args.source}` : ""})`,
  );

  const rows = await run(args);

  logger.info(
    `${rows.length} release(s) ${args.apply ? "patched" : "identified (dry run -- rerun with --apply to persist)"}`,
  );

  if (args.json) {
    process.stdout.write(
      JSON.stringify(
        {
          apply: args.apply,
          org: args.org,
          source: args.source,
          processed: rows.length,
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
