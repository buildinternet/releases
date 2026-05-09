#!/usr/bin/env bun
/**
 * Manual release-content generator. Populates `content_title`,
 * `content_title_short`, and `content_summary` on `releases` rows that
 * match a filter, via Anthropic Haiku 4.5 + a single tuned system prompt.
 *
 * This is an operational tool — run as needed, not on a cron. Ingest
 * paths do not call it today. Use it for backfills, ad-hoc patch-ups of
 * specific orgs, or to regenerate after a prompt change.
 *
 * Usage:
 *   bun scripts/generate-release-content.ts                       # dry run, openai+anthropic past 7d
 *   bun scripts/generate-release-content.ts --apply               # write to D1 prod
 *   bun scripts/generate-release-content.ts --orgs=vercel         # one or more org slugs (comma-sep)
 *   bun scripts/generate-release-content.ts --orgs=all --since=30 # everything in past N days
 *   bun scripts/generate-release-content.ts --apply --since=1
 *
 * Cost: ~$0.005/release at list price (Haiku 4.5; system prompt is the
 * dominant input at ~3,971 tokens). The Haiku 4.5 cache threshold is
 * 4,096 tokens, so this prompt sits just below the cutoff and ephemeral
 * caching never activates. See issue #851 for AI Gateway / alternate
 * model exploration.
 */

import Anthropic from "@anthropic-ai/sdk";
import { spawn } from "node:child_process";
import { daysAgoIso } from "@buildinternet/releases-core/dates";
import { logger } from "@buildinternet/releases-lib/logger";
import {
  summarizeRelease,
  type SummarizeReleaseResult,
} from "@releases/ai-internal/release-content";

const argv = process.argv.slice(2);
const apply = argv.includes("--apply");
const orgsArg = argv.find((a) => a.startsWith("--orgs="))?.split("=")[1];
const sinceArg = argv.find((a) => a.startsWith("--since="))?.split("=")[1];

const orgs = !orgsArg
  ? ["openai", "anthropic"]
  : orgsArg === "all"
    ? null
    : orgsArg
        .split(",")
        .map((s) => s.trim().toLowerCase())
        .filter(Boolean);
const sinceDays = sinceArg ? Number.parseInt(sinceArg, 10) : 7;

if (Array.isArray(orgs) && orgs.length === 0) {
  logger.error(
    `--orgs="${orgsArg}" parsed to no valid org slugs; pass --orgs=all to include every org`,
  );
  process.exit(1);
}

if (sinceArg && Number.isNaN(sinceDays)) {
  logger.error("--since must be an integer number of days");
  process.exit(1);
}

const apiKey = process.env.ANTHROPIC_API_KEY;
if (!apiKey) {
  logger.error("ANTHROPIC_API_KEY not set");
  process.exit(1);
}

const cutoffIso = daysAgoIso(sinceDays);

const CONCURRENCY = 5;

interface ReleaseRow {
  id: string;
  title: string;
  version: string | null;
  content: string;
  url: string | null;
  org_slug: string;
  source_name: string;
  product_name: string | null;
}

function runWrangler(args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn("bunx", ["wrangler", ...args], {
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (b) => (stdout += b.toString()));
    child.stderr.on("data", (b) => (stderr += b.toString()));
    child.on("close", (code) => {
      if (code !== 0) reject(new Error(`wrangler exit ${code}: ${stderr}`));
      else resolve(stdout);
    });
  });
}

async function fetchReleases(): Promise<ReleaseRow[]> {
  const orgClause = orgs
    ? `AND LOWER(o.slug) IN (${orgs.map((o) => `'${o.replace(/'/g, "''")}'`).join(",")})`
    : "";
  const sql = `
    SELECT r.id, r.title, r.version, r.content, r.url,
           o.slug as org_slug,
           s.name as source_name,
           p.name as product_name
    FROM releases r
    JOIN sources s ON s.id = r.source_id
    JOIN organizations o ON o.id = s.org_id
    LEFT JOIN products p ON p.id = s.product_id
    WHERE r.suppressed = 0
      ${orgClause}
      AND r.fetched_at >= '${cutoffIso}'
    ORDER BY o.slug, r.fetched_at DESC;
  `.trim();

  const out = await runWrangler([
    "d1",
    "execute",
    "released-db",
    "--remote",
    "--config",
    "workers/api/wrangler.jsonc",
    "--command",
    sql,
    "--json",
  ]);

  const start = out.indexOf("[");
  if (start === -1) throw new Error(`No JSON in wrangler output: ${out}`);
  const parsed = JSON.parse(out.slice(start));
  return parsed[0].results as ReleaseRow[];
}

function escapeSql(s: string): string {
  return s.replace(/'/g, "''");
}

async function writeRow(
  id: string,
  summary: string | null,
  title: string | null,
  titleShort: string | null,
): Promise<void> {
  const lit = (v: string | null) => (v == null ? "NULL" : `'${escapeSql(v)}'`);
  const sql = `UPDATE releases SET content_summary = ${lit(summary)}, content_title = ${lit(title)}, content_title_short = ${lit(titleShort)} WHERE id = '${escapeSql(id)}';`;
  await runWrangler([
    "d1",
    "execute",
    "released-db",
    "--remote",
    "--config",
    "workers/api/wrangler.jsonc",
    "--command",
    sql,
  ]);
}

async function pool<T, R>(
  items: T[],
  concurrency: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const results: R[] = Array.from({ length: items.length });
  let cursor = 0;
  const workers = Array.from({ length: concurrency }, async () => {
    while (true) {
      const idx = cursor++;
      if (idx >= items.length) return;
      // eslint-disable-next-line no-await-in-loop -- worker-pool pattern; parallelism comes from multiple workers
      results[idx] = await fn(items[idx]!);
    }
  });
  await Promise.all(workers);
  return results;
}

const client = new Anthropic({ apiKey });

logger.info(`mode: ${apply ? "APPLY (writes to D1 prod)" : "DRY RUN"}`);
logger.info(`orgs: ${orgs ? orgs.join(",") : "all"}`);
logger.info(`since: past ${sinceDays} day${sinceDays === 1 ? "" : "s"} (cutoff ${cutoffIso})`);
logger.info("fetching candidate releases…");
const rows = await fetchReleases();
logger.info(`found ${rows.length} release${rows.length === 1 ? "" : "s"}`);

let totalInput = 0;
let totalOutput = 0;
let totalCacheCreate = 0;
let totalCacheRead = 0;
let written = 0;
let skippedEmpty = 0;
const samples: {
  org: string;
  sourceTitle: string;
  bodyLen: number;
  title: string | null;
  titleShort: string | null;
  summary: string | null;
}[] = [];

await pool(rows, CONCURRENCY, async (row) => {
  try {
    const { title, titleShort, summary, usage, skipped }: SummarizeReleaseResult =
      await summarizeRelease(client, {
        orgSlug: row.org_slug,
        sourceName: row.source_name,
        productName: row.product_name,
        title: row.title,
        version: row.version,
        url: row.url,
        content: row.content,
      });
    totalInput += usage.input;
    totalOutput += usage.output;
    totalCacheCreate += usage.cacheCreate;
    totalCacheRead += usage.cacheRead;
    // Empty-body rows surface as `skipped: true` with all-null fields. Don't
    // write them — leaving the columns NULL keeps the read path falling back
    // to `release.title` instead of stamping a placeholder into the DB.
    if (skipped) {
      skippedEmpty++;
    } else if (apply) {
      await writeRow(row.id, summary, title, titleShort);
      written++;
    }
    samples.push({
      org: row.org_slug,
      sourceTitle: row.title,
      bodyLen: row.content.length,
      title,
      titleShort,
      summary,
    });
  } catch (err) {
    logger.error(`failed for ${row.org_slug}/${row.title}: ${(err as Error).message}`);
    samples.push({
      org: row.org_slug,
      sourceTitle: row.title,
      bodyLen: row.content.length,
      title: null,
      titleShort: null,
      summary: `ERROR: ${(err as Error).message}`,
    });
  }
});

// Pricing: Haiku 4.5 list — $1/M input, $5/M output. Ephemeral cache write 1.25x, read 0.1x.
const inputCost = (totalInput * 1 + totalCacheCreate * 1.25 + totalCacheRead * 0.1) / 1_000_000;
const outputCost = (totalOutput * 5) / 1_000_000;

logger.info(
  `${apply ? "APPLIED" : "DRY RUN"}: processed ${rows.length} release${rows.length === 1 ? "" : "s"}${apply ? `, wrote ${written}` : ""}, skipped ${skippedEmpty} empty-body`,
);
logger.info(
  `tokens: ${totalInput} in (cache create ${totalCacheCreate}, cache read ${totalCacheRead}), ${totalOutput} out`,
);
logger.info(`est cost: $${(inputCost + outputCost).toFixed(4)} (Haiku 4.5 list price)`);

samples.sort((a, b) => a.bodyLen - b.bodyLen);
const report: string[] = ["", "## Samples (sorted by body length)", ""];
for (const s of samples) {
  report.push(`### ${s.org} · ${s.sourceTitle} (${s.bodyLen} chars)`);
  if (s.title) report.push(`**Title:** ${s.title}`);
  if (s.titleShort) report.push(`**Short:** ${s.titleShort}`);
  report.push(s.summary ?? "_(skipped — empty body)_", "");
}
logger.info(report.join("\n"));
