#!/usr/bin/env bun
/**
 * Survey release volume for orgs with `auto_generate_content = 1` plus
 * candidate orgs being considered for opt-in. Flags burst patterns
 * (high releases-per-source or peak-day count) that are likely to drive
 * cost overruns when the auto-gen flag is flipped on — auth0 was the
 * canonical case: one source, 800 releases in 7d.
 *
 * Usage:
 *   bun scripts/audit-content-gen-volume.ts                  # currently-enabled orgs
 *   bun scripts/audit-content-gen-volume.ts --candidates=foo,bar
 *   bun scripts/audit-content-gen-volume.ts --window=30
 */

import { spawn } from "node:child_process";
import { logger } from "@buildinternet/releases-lib/logger";

const argv = process.argv.slice(2);
const candidatesArg = argv.find((a) => a.startsWith("--candidates="))?.split("=")[1];
const windowArg = argv.find((a) => a.startsWith("--window="))?.split("=")[1];

const windowDays = windowArg ? Number.parseInt(windowArg, 10) : 7;
if (Number.isNaN(windowDays) || windowDays <= 0) {
  logger.error("--window must be a positive integer (days)");
  process.exit(1);
}

const candidates = candidatesArg
  ? candidatesArg
      .split(",")
      .map((s) => s.trim().toLowerCase())
      .filter(Boolean)
  : [];

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

interface Row {
  slug: string;
  enabled: number;
  n_releases: number;
  n_sources: number;
  releases_per_source: number;
  peak_day: number;
  avg_body_chars: number;
  est_weekly_cost: number;
}

const candidateClause =
  candidates.length > 0
    ? `OR LOWER(o.slug) IN (${candidates.map((s) => `'${s.replace(/'/g, "''")}'`).join(",")})`
    : "";

const sql = `
  WITH per_day AS (
    SELECT s.org_id, s.id AS source_id, DATE(r.published_at) AS d, COUNT(*) AS n
    FROM releases r
    JOIN sources s ON s.id = r.source_id
    WHERE r.published_at >= datetime('now','-${windowDays} day') AND r.suppressed = 0
    GROUP BY s.org_id, s.id, DATE(r.published_at)
  )
  SELECT
    o.slug,
    o.auto_generate_content AS enabled,
    COUNT(r.id)                                       AS n_releases,
    COUNT(DISTINCT s.id)                              AS n_sources,
    COUNT(r.id) * 1.0 / MAX(1, COUNT(DISTINCT s.id))  AS releases_per_source,
    COALESCE(MAX(pd.n), 0)                            AS peak_day,
    AVG(LENGTH(COALESCE(r.content,'')))               AS avg_body_chars
  FROM organizations o
  JOIN sources s ON s.org_id = o.id
  JOIN releases r ON r.source_id = s.id
  LEFT JOIN per_day pd ON pd.source_id = s.id
  WHERE r.published_at >= datetime('now','-${windowDays} day')
    AND r.suppressed = 0
    AND (o.auto_generate_content = 1 ${candidateClause})
  GROUP BY o.id, o.slug, o.auto_generate_content
  ORDER BY n_releases DESC;
`.trim();

logger.info(`window: past ${windowDays} day${windowDays === 1 ? "" : "s"}`);
logger.info(
  candidates.length > 0
    ? `auditing enabled orgs + candidates: ${candidates.join(", ")}`
    : "auditing currently-enabled orgs only (pass --candidates=foo,bar to include more)",
);

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
const rawRows = parsed[0].results as Array<{
  slug: string;
  enabled: number;
  n_releases: number;
  n_sources: number;
  releases_per_source: number;
  peak_day: number;
  avg_body_chars: number;
}>;

// Per-release cost ≈ $0.005 base + body chars * 2.5e-7 (input only).
// Scale to a weekly rate for an apples-to-apples comparison across windows.
const rows: Row[] = rawRows.map((r) => {
  const perRelease = 0.005 + (r.avg_body_chars ?? 0) * 2.5e-7;
  const weeklyVolume = (r.n_releases / windowDays) * 7;
  return {
    ...r,
    est_weekly_cost: weeklyVolume * perRelease,
  };
});

// Heuristic flags: anything that would have caught auth0/mastra in advance.
function flagsFor(r: Row): string {
  const flags: string[] = [];
  if (r.peak_day >= 50) flags.push(`peak-day=${r.peak_day}`);
  if (r.releases_per_source >= 50) flags.push(`per-source=${r.releases_per_source.toFixed(0)}`);
  if (r.avg_body_chars >= 30_000) flags.push(`avg-body=${Math.round(r.avg_body_chars / 1000)}k`);
  if (r.est_weekly_cost >= 1) flags.push(`weekly≈$${r.est_weekly_cost.toFixed(2)}`);
  return flags.length === 0 ? "ok" : flags.join(", ");
}

const header = `${"slug".padEnd(20)} ${"on".padStart(3)} ${"n".padStart(6)} ${"src".padStart(5)} ${"r/src".padStart(7)} ${"peak".padStart(5)} ${"avg_body".padStart(9)} ${"weekly$".padStart(8)}  flags`;
const lines = [header, "-".repeat(header.length)];
for (const r of rows) {
  lines.push(
    [
      r.slug.padEnd(20),
      (r.enabled ? "✓" : " ").padStart(3),
      String(r.n_releases).padStart(6),
      String(r.n_sources).padStart(5),
      r.releases_per_source.toFixed(1).padStart(7),
      String(r.peak_day).padStart(5),
      `${Math.round((r.avg_body_chars ?? 0) / 1000)}k`.padStart(9),
      `$${r.est_weekly_cost.toFixed(2)}`.padStart(8),
      " ",
      flagsFor(r),
    ].join(" "),
  );
}
logger.info("\n" + lines.join("\n"));
