#!/usr/bin/env bun
/**
 * Manual release-content generator. Populates `title_generated`,
 * `title_short`, and `summary` on `releases` rows that match a filter,
 * via Anthropic Haiku 4.5 + a single tuned system prompt.
 *
 * This is an operational tool — run as needed, not on a cron. Ingest
 * paths do not call it today. Use it for backfills, ad-hoc patch-ups of
 * specific orgs, or to regenerate after a prompt change.
 *
 * Usage:
 *   bun scripts/generate-release-content.ts                       # prints cost estimate and exits (no API calls)
 *   bun scripts/generate-release-content.ts --apply               # submit batch to Anthropic, write to D1 prod
 *   bun scripts/generate-release-content.ts --orgs=vercel         # one or more org slugs (comma-sep)
 *   bun scripts/generate-release-content.ts --orgs=all --since=30 # everything in past N days
 *   bun scripts/generate-release-content.ts --apply --since=1
 *   bun scripts/generate-release-content.ts --apply --max-cost=25 # override $10 default ceiling
 *   bun scripts/generate-release-content.ts --apply --no-batch    # fall back to real-time path
 *
 * Without --apply, the script fetches the candidate list, prints the cost estimate, and exits
 * without making any Anthropic API calls (neither batch nor real-time).
 *
 * Cost: by default this routes through the Anthropic Message Batches API
 * for a flat 50% discount on input + output (incl. cache). Trade-off is
 * up to ~24h latency — acceptable for a backfill, never for a live feed.
 * Pass `--no-batch` for fast iteration when comparing prompt revisions;
 * that path uses real-time `messages.create` with a CONCURRENCY=5 pool
 * (the historical behavior of this script). See issue #967.
 *
 * Budget guard: before any API calls, the script estimates total cost from
 * candidate count + body sizes and aborts if the estimate exceeds
 * `--max-cost` (default $10). Override per-run for deliberate larger backfills.
 */

import Anthropic from "@anthropic-ai/sdk";
import { spawn } from "node:child_process";
import { daysAgoIso } from "@buildinternet/releases-core/dates";
import { logger } from "@buildinternet/releases-lib/logger";
import { estimateCost } from "@releases/lib/anthropic-pricing";
import {
  buildReleaseBlock,
  isEmptyContent,
  MAX_OUTPUT_TOKENS,
  MODEL,
  parseReleaseContent,
  summarizeRelease,
  SYSTEM_PROMPT,
  type ReleaseContentUsage,
  type SummarizeReleaseInput,
  type SummarizeReleaseResult,
} from "@releases/ai-internal/release-content";
import { collectResults, pollBatch, submitBatch } from "@releases/ai-internal/batch";
import { adminPatch, adminPost } from "./lib/admin-client.js";

const argv = process.argv.slice(2);
const apply = argv.includes("--apply");
const noBatch = argv.includes("--no-batch");
const orgsArg = argv.find((a) => a.startsWith("--orgs="))?.split("=")[1];
const sinceArg = argv.find((a) => a.startsWith("--since="))?.split("=")[1];
const maxCostArg = argv.find((a) => a.startsWith("--max-cost="))?.split("=")[1];

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

const maxCostUsd = maxCostArg ? Number.parseFloat(maxCostArg) : 10;
if (maxCostArg && (Number.isNaN(maxCostUsd) || maxCostUsd <= 0)) {
  logger.error("--max-cost must be a positive number (dollars)");
  process.exit(1);
}

const apiKey = process.env.ANTHROPIC_API_KEY;
if (!apiKey) {
  logger.error("ANTHROPIC_API_KEY not set");
  process.exit(1);
}

// adminPost and adminPatch are imported from ./lib/admin-client.js.
// Both use best-effort semantics (throwOnError defaults to false) with a 3s
// timeout — writes are fire-and-forget; failure does NOT abort the run.

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

function rowToSummarizeInput(row: ReleaseRow): SummarizeReleaseInput {
  return {
    orgSlug: row.org_slug,
    sourceName: row.source_name,
    productName: row.product_name,
    title: row.title,
    version: row.version,
    url: row.url,
    content: row.content,
  };
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
  const sql = `UPDATE releases SET summary = ${lit(summary)}, title_generated = ${lit(title)}, title_short = ${lit(titleShort)} WHERE id = '${escapeSql(id)}';`;
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

type PerRow =
  | { row: ReleaseRow; kind: "ok"; result: SummarizeReleaseResult }
  | { row: ReleaseRow; kind: "err"; error: string };

function emptyUsage(): ReleaseContentUsage {
  return { input: 0, output: 0, cacheCreate: 0, cacheRead: 0 };
}

function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (typeof err === "string") return err;
  try {
    return JSON.stringify(err);
  } catch {
    return String(err);
  }
}

async function runRealtime(rows: ReleaseRow[]): Promise<PerRow[]> {
  return pool(rows, CONCURRENCY, async (row): Promise<PerRow> => {
    try {
      const result = await summarizeRelease(client, rowToSummarizeInput(row));
      return { row, kind: "ok", result };
    } catch (err) {
      return { row, kind: "err", error: errorMessage(err) };
    }
  });
}

async function runBatch(
  rows: ReleaseRow[],
  opts: { estCostUsd: number },
): Promise<{ perRow: PerRow[]; batchRunId: string | null }> {
  // Empty-body rows short-circuit on the local side: returning a `skipped`
  // result mirrors what `summarizeRelease` does on the real-time path, and
  // keeps us from paying for a batch slot on rows we'd skip anyway.
  const out: PerRow[] = [];
  const eligible: { row: ReleaseRow; input: SummarizeReleaseInput }[] = [];
  for (const row of rows) {
    const input = rowToSummarizeInput(row);
    if (isEmptyContent(input.content)) {
      out.push({
        row,
        kind: "ok",
        result: {
          title: null,
          titleShort: null,
          summary: null,
          usage: emptyUsage(),
          skipped: true,
        },
      });
      continue;
    }
    eligible.push({ row, input });
  }

  if (eligible.length === 0) return { perRow: out, batchRunId: null };

  logger.info(`submitting batch of ${eligible.length} request${eligible.length === 1 ? "" : "s"}…`);
  const submitted = await submitBatch(
    client,
    eligible.map(({ row, input }) => ({
      custom_id: row.id,
      params: {
        model: MODEL,
        max_tokens: MAX_OUTPUT_TOKENS,
        system: [
          {
            type: "text" as const,
            text: SYSTEM_PROMPT,
            cache_control: { type: "ephemeral" as const },
          },
        ],
        messages: [{ role: "user" as const, content: buildReleaseBlock(input) }],
      },
    })),
  );
  logger.info(`batch ${submitted.id} submitted (status: ${submitted.processing_status})`);

  // Persist the submission record. Best-effort — failure does not abort the run.
  const persistResult = await adminPost("/admin/batch-runs", {
    anthropicBatchId: submitted.id,
    caller: "script",
    model: MODEL,
    requestCountTotal: eligible.length,
    estCostUsd: opts.estCostUsd,
    callerContext: {
      orgs: orgs ?? "all",
      since_days: sinceDays,
    },
  });
  const batchRunId =
    persistResult && typeof persistResult === "object" && "id" in persistResult
      ? String((persistResult as { id: string }).id)
      : null;

  // Per-poll log throttle: skip when finished counts haven't moved. Counts
  // only populate when processing_status === "ended", so most in-flight polls
  // would be redundant heartbeats. The final "ended" state is logged once
  // unconditionally below, so we don't need to re-emit it here.
  let lastDone = -1;
  const finalBatch = await pollBatch(client, submitted.id, {
    onPoll: (b) => {
      const done =
        b.request_counts.succeeded +
        b.request_counts.errored +
        b.request_counts.canceled +
        b.request_counts.expired;
      if (done === lastDone) return;
      lastDone = done;
      logger.info(
        `batch ${b.id}: ${b.processing_status} (succeeded=${b.request_counts.succeeded}, errored=${b.request_counts.errored}, processing=${b.request_counts.processing})`,
      );
      // Persist progress update best-effort.
      if (batchRunId) {
        void adminPatch(`/admin/batch-runs/${batchRunId}`, {
          status: "in_progress",
          requestCountSucceeded: b.request_counts.succeeded,
          requestCountErrored: b.request_counts.errored,
          requestCountExpired: b.request_counts.expired,
          requestCountCanceled: b.request_counts.canceled,
        });
      }
    },
  });

  logger.info(
    `batch ${finalBatch.id} ended: succeeded=${finalBatch.request_counts.succeeded}, errored=${finalBatch.request_counts.errored}, expired=${finalBatch.request_counts.expired}, canceled=${finalBatch.request_counts.canceled}`,
  );

  // Pass the SDK's `Message` to a local parse that extracts the text + usage.
  // Wrapping the SDK type at the boundary keeps the parser exported from
  // release-content.ts free of the wider Anthropic namespace (see comment on
  // parseReleaseContent for the workspace dupe-install rationale).
  const parsed = await collectResults(client, submitted.id, (message) => {
    const raw = message.content
      .filter((b): b is Extract<typeof b, { type: "text" }> => b.type === "text")
      .map((b) => b.text)
      .join("");
    return {
      ...parseReleaseContent(raw, message.stop_reason),
      usage: {
        input: message.usage.input_tokens,
        output: message.usage.output_tokens,
        cacheCreate: message.usage.cache_creation_input_tokens ?? 0,
        cacheRead: message.usage.cache_read_input_tokens ?? 0,
      },
    };
  });

  for (const { row } of eligible) {
    const outcome = parsed.get(row.id);
    if (!outcome) {
      out.push({ row, kind: "err", error: "no result line returned from batch" });
      continue;
    }
    switch (outcome.kind) {
      case "succeeded":
        out.push({ row, kind: "ok", result: { ...outcome.value, skipped: false } });
        break;
      case "errored":
        out.push({ row, kind: "err", error: errorMessage(outcome.error) });
        break;
      case "canceled":
        out.push({ row, kind: "err", error: "request canceled" });
        break;
      case "expired":
        out.push({ row, kind: "err", error: "request expired" });
        break;
    }
  }
  return { perRow: out, batchRunId };
}

const client = new Anthropic({ apiKey });

const mode = `${apply ? "APPLY (writes to D1 prod)" : "DRY RUN"} (${noBatch ? "real-time" : "batched"})`;

logger.info(`mode: ${mode}`);
logger.info(`orgs: ${orgs ? orgs.join(",") : "all"}`);
logger.info(`since: past ${sinceDays} day${sinceDays === 1 ? "" : "s"} (cutoff ${cutoffIso})`);
logger.info(`budget ceiling: $${maxCostUsd.toFixed(2)} (override with --max-cost=N)`);
logger.info("fetching candidate releases…");
const rows = await fetchReleases();
logger.info(`found ${rows.length} release${rows.length === 1 ? "" : "s"}`);

// Pre-flight cost estimate. Per-row ≈ system prompt (~4k tok) + body/4 chars
// per token for input + ~300 output tokens. Worst-case (no-cache) input rate
// so the budget guard errs toward aborting; in practice the ephemeral cache
// activates after the first real-time call (~10× cheaper on reads), and
// requests inside one batch submission share the cached system prompt too.
const estInputTokens = rows.reduce((sum, r) => sum + 4000 + Math.ceil(r.content.length / 4), 0);
const estOutputTokens = rows.length * 300;
const estCost = estimateCost(
  { inputTokens: estInputTokens, outputTokens: estOutputTokens },
  MODEL,
  { batch: !noBatch },
);
const estCostUsd = estCost?.totalUsd ?? 0;
logger.info(
  `estimated cost: $${estCostUsd.toFixed(4)} (${estInputTokens.toLocaleString()} input + ${estOutputTokens.toLocaleString()} output tokens${noBatch ? "" : ", batch -50%"})`,
);
if (estCostUsd > maxCostUsd) {
  logger.error(
    `estimated cost $${estCostUsd.toFixed(2)} exceeds --max-cost $${maxCostUsd.toFixed(2)}; re-run with a higher --max-cost or narrow --orgs/--since`,
  );
  process.exit(1);
}

if (!apply) {
  logger.info(`pass --apply to run (${noBatch ? "real-time" : "batch"} path); no API calls made`);
  process.exit(0);
}

let batchRunId: string | null = null;
let perRow: PerRow[];
if (noBatch) {
  perRow = await runRealtime(rows);
} else {
  const result = await runBatch(rows, { estCostUsd });
  perRow = result.perRow;
  batchRunId = result.batchRunId;
}

let totalInput = 0;
let totalOutput = 0;
let totalCacheCreate = 0;
let totalCacheRead = 0;
let written = 0;
let skippedEmpty = 0;
let failed = 0;
const samples: {
  org: string;
  sourceTitle: string;
  bodyLen: number;
  title: string | null;
  titleShort: string | null;
  summary: string | null;
}[] = [];

interface WritePayload {
  id: string;
  summary: string | null;
  title: string | null;
  titleShort: string | null;
}
const pendingWrites: WritePayload[] = [];

for (const entry of perRow) {
  const { row } = entry;
  if (entry.kind === "err") {
    failed++;
    logger.error(`failed for ${row.org_slug}/${row.title}: ${entry.error}`);
    samples.push({
      org: row.org_slug,
      sourceTitle: row.title,
      bodyLen: row.content.length,
      title: null,
      titleShort: null,
      summary: `ERROR: ${entry.error}`,
    });
    continue;
  }
  const { result } = entry;
  totalInput += result.usage.input;
  totalOutput += result.usage.output;
  totalCacheCreate += result.usage.cacheCreate;
  totalCacheRead += result.usage.cacheRead;
  if (result.skipped) {
    skippedEmpty++;
  } else if (apply) {
    pendingWrites.push({
      id: row.id,
      summary: result.summary,
      title: result.title,
      titleShort: result.titleShort,
    });
  }
  samples.push({
    org: row.org_slug,
    sourceTitle: row.title,
    bodyLen: row.content.length,
    title: result.title,
    titleShort: result.titleShort,
    summary: result.summary,
  });
}

// Pooled to cap concurrent wrangler subprocesses; sequential `await` here
// would dominate wall-clock on large batch runs.
await pool(pendingWrites, CONCURRENCY, (w) => writeRow(w.id, w.summary, w.title, w.titleShort));
written = pendingWrites.length;

const finalCost = estimateCost(
  {
    inputTokens: totalInput,
    cacheWriteTokens: totalCacheCreate,
    cacheReadTokens: totalCacheRead,
    outputTokens: totalOutput,
  },
  MODEL,
  { batch: !noBatch },
);

logger.info(
  `${apply ? "APPLIED" : "DRY RUN"}: processed ${rows.length} release${rows.length === 1 ? "" : "s"}${apply ? `, wrote ${written}` : ""}, skipped ${skippedEmpty} empty-body, failed ${failed}`,
);
logger.info(
  `tokens: ${totalInput} in (cache create ${totalCacheCreate}, cache read ${totalCacheRead}), ${totalOutput} out`,
);
logger.info(
  `est cost: $${(finalCost?.totalUsd ?? 0).toFixed(4)} (Haiku 4.5${noBatch ? " list price" : " batch price = list × 0.5"})`,
);

// Finalize the batch_runs row. actualCostUsd = null when zero requests ran
// (batch expired/canceled entirely); otherwise sum of succeeded requests' cost.
if (batchRunId) {
  const succeededCount = perRow.filter((e) => e.kind === "ok" && !e.result.skipped).length;
  const erroredEntries = perRow.filter(
    (e): e is Extract<typeof e, { kind: "err" }> => e.kind === "err",
  );
  const actualCostUsd =
    succeededCount === 0 && erroredEntries.length === 0 ? null : (finalCost?.totalUsd ?? null);
  const errorSummary =
    erroredEntries.length > 0
      ? {
          count: erroredEntries.length,
          sample: erroredEntries.slice(0, 10).map((e) => ({
            id: e.row.id,
            error: e.error,
          })),
        }
      : null;
  await adminPatch(`/admin/batch-runs/${batchRunId}`, {
    status: "ended",
    endedAt: new Date().toISOString(),
    requestCountSucceeded: succeededCount,
    requestCountErrored: erroredEntries.length,
    requestCountExpired: finalBatch.request_counts.expired,
    requestCountCanceled: finalBatch.request_counts.canceled,
    actualCostUsd,
    errorSummary,
  });
}

samples.sort((a, b) => a.bodyLen - b.bodyLen);
const report: string[] = ["", "## Samples (sorted by body length)", ""];
for (const s of samples) {
  report.push(`### ${s.org} · ${s.sourceTitle} (${s.bodyLen} chars)`);
  if (s.title) report.push(`**Title:** ${s.title}`);
  if (s.titleShort) report.push(`**Short:** ${s.titleShort}`);
  report.push(s.summary ?? "_(skipped — empty body)_", "");
}
logger.info(report.join("\n"));
