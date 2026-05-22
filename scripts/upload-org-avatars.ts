#!/usr/bin/env bun
/**
 * One-off backfill: upload org avatar images to R2 and write the resulting
 * `media.releases.sh` URL to `organizations.avatar_url` via the REST API.
 *
 * Input is the manifest produced by the avatar-collection agent — a CSV with
 * `slug`, `filename`, `status` columns (plus metadata). See `--help` for the
 * full argument list.
 *
 * For each row with `status=ok`:
 *   1. PUT  /v1/media/orgs/{slug}.{ext}        (R2 upload, auth: Bearer)
 *   2. PATCH /v1/orgs/{slug} { avatarUrl }     (DB write,   auth: Bearer)
 *
 * Both steps are idempotent — re-running overwrites the R2 object and re-sets
 * the same avatar_url. Skipped rows: status != ok, 0-byte files, missing
 * files, unknown extensions.
 *
 * Usage:
 *   # dry run against prod
 *   bun scripts/upload-org-avatars.ts \
 *     --manifest /path/to/manifest.csv
 *
 *   # apply against staging (sets X-Releases-Staging-Key from env)
 *   RELEASES_API_URL=https://api-staging.releases.sh \
 *   RELEASES_API_KEY=... \
 *   STAGING_ACCESS_KEY=... \
 *   bun scripts/upload-org-avatars.ts --manifest /path/to/manifest.csv --apply
 *
 *   # apply against prod (media URL defaults to https://media.releases.sh)
 *   RELEASES_API_URL=https://api.releases.sh \
 *   RELEASES_API_KEY=... \
 *   bun scripts/upload-org-avatars.ts --manifest /path/to/manifest.csv --apply
 *
 * Env:
 *   RELEASES_API_URL      Required when --apply (e.g. https://api.releases.sh)
 *   RELEASES_API_KEY      Required when --apply (Bearer token)
 *   STAGING_ACCESS_KEY    Optional; if set, sent as X-Releases-Staging-Key
 *   MEDIA_ORIGIN          Optional; defaults to https://media.releases.sh
 */

import { readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, extname, join, resolve } from "node:path";
import { logger } from "@buildinternet/releases-lib/logger";

type UploadStatus = "uploaded" | "dry_run" | "tombstoned" | "failed" | "skipped" | "missing";

interface Args {
  manifest: string;
  rawDir: string | null; // resolved from manifest dir if null
  apply: boolean;
  only: string | null; // comma-separated slugs, filter to these
}

function parseArgs(argv: string[]): Args {
  const args: Args = { manifest: "", rawDir: null, apply: false, only: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--manifest") args.manifest = argv[++i] ?? "";
    else if (a?.startsWith("--manifest=")) args.manifest = a.slice("--manifest=".length);
    else if (a === "--raw-dir") args.rawDir = argv[++i] ?? null;
    else if (a?.startsWith("--raw-dir=")) args.rawDir = a.slice("--raw-dir=".length);
    else if (a === "--only") args.only = argv[++i] ?? null;
    else if (a?.startsWith("--only=")) args.only = a.slice("--only=".length);
    else if (a === "--apply") args.apply = true;
    else if (a === "--help" || a === "-h") {
      process.stdout.write(
        [
          "Usage: bun scripts/upload-org-avatars.ts --manifest <path> [options]",
          "",
          "Options:",
          "  --manifest <path>   Path to manifest.csv (required)",
          "  --raw-dir  <path>   Directory containing image files (default: <manifest dir>/raw)",
          "  --only     <slugs>  Comma-separated slug filter (e.g. --only=anthropic,linear)",
          "  --apply             Actually upload + PATCH (default: dry run)",
          "  -h, --help          Show this help",
          "",
          "Env: RELEASES_API_URL, RELEASES_API_KEY, STAGING_ACCESS_KEY?, MEDIA_ORIGIN?",
          "",
        ].join("\n"),
      );
      process.exit(0);
    } else if (a?.startsWith("--")) {
      logger.error(`Unknown flag: ${a}`);
      process.exit(1);
    }
  }
  if (!args.manifest) {
    logger.error("--manifest <path> is required (try --help)");
    process.exit(1);
  }
  return args;
}

type Row = Record<string, string>;

function parseCsv(text: string): Row[] {
  const lines = text.split(/\r?\n/).filter((l) => l.length > 0);
  if (lines.length === 0) return [];
  const headers = splitCsvLine(lines[0]!);
  const rows: Row[] = [];
  for (let i = 1; i < lines.length; i++) {
    const fields = splitCsvLine(lines[i]!);
    const row: Row = {};
    for (let j = 0; j < headers.length; j++) row[headers[j]!] = fields[j] ?? "";
    rows.push(row);
  }
  return rows;
}

// Minimal RFC-4180-ish CSV splitter — handles double-quoted fields with
// embedded commas. The manifest doesn't use embedded newlines.
function splitCsvLine(line: string): string[] {
  const out: string[] = [];
  let cur = "";
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i]!;
    if (inQuotes) {
      if (ch === '"' && line[i + 1] === '"') {
        cur += '"';
        i++;
      } else if (ch === '"') {
        inQuotes = false;
      } else {
        cur += ch;
      }
    } else if (ch === '"') {
      inQuotes = true;
    } else if (ch === ",") {
      out.push(cur);
      cur = "";
    } else {
      cur += ch;
    }
  }
  out.push(cur);
  return out;
}

const CONTENT_TYPES: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  svg: "image/svg+xml",
  webp: "image/webp",
  gif: "image/gif",
};

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const manifestPath = resolve(args.manifest);
  const rawDir = args.rawDir ? resolve(args.rawDir) : join(dirname(manifestPath), "raw");
  const mediaOrigin = (process.env.MEDIA_ORIGIN ?? "https://media.releases.sh").replace(/\/+$/, "");
  const apiUrl = (process.env.RELEASES_API_URL ?? process.env.RELEASED_API_URL ?? "").replace(
    /\/+$/,
    "",
  );
  const apiKey = process.env.RELEASES_API_KEY ?? process.env.RELEASED_API_KEY ?? "";
  const stagingKey = process.env.STAGING_ACCESS_KEY ?? "";
  const only = args.only ? new Set(args.only.split(",").map((s) => s.trim())) : null;

  if (args.apply) {
    if (!apiUrl) {
      logger.error("RELEASES_API_URL is required when --apply is set");
      process.exit(1);
    }
    if (!apiKey) {
      logger.error("RELEASES_API_KEY is required when --apply is set");
      process.exit(1);
    }
  }

  const csv = readFileSync(manifestPath, "utf8");
  const rows = parseCsv(csv);

  logger.info(
    `Loaded ${rows.length} rows from ${manifestPath}` +
      `\n  raw dir:     ${rawDir}` +
      `\n  media origin: ${mediaOrigin}` +
      `\n  api url:     ${apiUrl || "(dry run, not contacting API)"}` +
      `\n  staging key: ${stagingKey ? "set" : "unset"}` +
      `\n  mode:        ${args.apply ? "APPLY" : "DRY RUN"}` +
      `${only ? `\n  filter:      ${[...only].join(",")}` : ""}` +
      "\n",
  );

  const outcomes = new Map<number, { uploadedUrl: string; uploadStatus: UploadStatus }>();

  let ok = 0;
  let skipped = 0;
  let failed = 0;
  let tombstoned = 0;

  const recordOutcome = (rowIdx: number, uploadStatus: UploadStatus, uploadedUrl = ""): void => {
    outcomes.set(rowIdx, { uploadedUrl, uploadStatus });
  };

  for (let i = 0; i < rows.length; i++) {
    const r = rows[i]!;
    const slug = r.slug ?? "";
    const filename = r.filename ?? "";
    const status = r.status ?? "";
    if (!slug || !filename) {
      logger.warn(`SKIP row=${r.row} (missing slug/filename)`);
      recordOutcome(i, "skipped");
      skipped++;
      continue;
    }
    if (status !== "ok") {
      logger.warn(`SKIP ${slug} (status=${status})`);
      recordOutcome(i, "skipped");
      skipped++;
      continue;
    }
    if (only && !only.has(slug)) continue;

    const path = join(rawDir, filename);
    let size: number;
    try {
      size = statSync(path).size;
    } catch {
      logger.error(`MISS ${slug}: ${filename} not found at ${path}`);
      recordOutcome(i, "missing");
      failed++;
      continue;
    }
    if (size === 0) {
      logger.warn(`SKIP ${slug}: ${filename} is 0 bytes (vestige file)`);
      recordOutcome(i, "skipped");
      skipped++;
      continue;
    }

    const ext = extname(filename).slice(1).toLowerCase();
    const contentType = CONTENT_TYPES[ext];
    if (!contentType) {
      logger.error(`SKIP ${slug}: unsupported extension .${ext}`);
      recordOutcome(i, "skipped");
      skipped++;
      continue;
    }

    // R2 key uses the FULL slug (matches `organizations.slug`). Slugs with
    // `--org_<id>` disambiguators stay as-is so the key is unique-by-design.
    const r2Key = `orgs/${slug}.${ext}`;
    const avatarUrl = `${mediaOrigin}/${r2Key}`;

    if (!args.apply) {
      logger.info(`DRY  ${slug}  ${size}B ${contentType}  →  ${avatarUrl}`);
      recordOutcome(i, "dry_run", avatarUrl);
      ok++;
      continue;
    }

    const body = readFileSync(path);
    const commonHeaders: Record<string, string> = {
      authorization: `Bearer ${apiKey}`,
    };
    if (stagingKey) commonHeaders["x-releases-staging-key"] = stagingKey;

    // oxlint-disable no-await-in-loop -- sequential by design: don't fan out
    // PUT/PATCH against R2 + D1, the bottleneck is the API not local CPU.
    const putRes = await fetch(`${apiUrl}/v1/media/${r2Key}`, {
      method: "PUT",
      headers: { ...commonHeaders, "content-type": contentType },
      body: new Uint8Array(body),
    });
    if (!putRes.ok) {
      logger.error(`FAIL ${slug}: PUT ${r2Key} → ${putRes.status} ${await putRes.text()}`);
      recordOutcome(i, "failed");
      failed++;
      continue;
    }

    const patchRes = await fetch(`${apiUrl}/v1/orgs/${encodeURIComponent(slug)}`, {
      method: "PATCH",
      headers: { ...commonHeaders, "content-type": "application/json" },
      body: JSON.stringify({ avatarUrl }),
    });
    if (!patchRes.ok) {
      // 404 means the org row is soft-deleted (`--org_<id>` mangled-rename
      // pattern). R2 PUT already succeeded; the DB pointer just can't be set.
      if (patchRes.status === 404) {
        patchRes.body?.cancel();
        logger.warn(`TOMB ${slug}: org tombstoned, R2 file uploaded but avatar_url not set`);
        recordOutcome(i, "tombstoned", avatarUrl);
        tombstoned++;
        continue;
      }
      logger.error(`FAIL ${slug}: PATCH org → ${patchRes.status} ${await patchRes.text()}`);
      recordOutcome(i, "failed");
      failed++;
      continue;
    }
    // oxlint-enable no-await-in-loop

    logger.info(`OK   ${slug}  ${size}B  →  ${avatarUrl}`);
    recordOutcome(i, "uploaded", avatarUrl);
    ok++;
  }

  writeManifest(manifestPath, csv, rows, outcomes);

  logger.info(
    `\nSummary: ${ok} ok, ${skipped} skipped, ${tombstoned} tombstoned, ${failed} failed`,
  );
  logger.info(`Manifest updated in place: ${manifestPath}`);
  if (failed > 0) process.exit(1);
}

// Rewrite the manifest CSV with two trailing columns: `uploaded_url` and
// `upload_status`. Preserves all existing rows verbatim (including any rows
// not touched in this run — `--only` filters leave their previous outcome
// intact in the artifact).
function writeManifest(
  manifestPath: string,
  originalCsv: string,
  rows: Row[],
  outcomes: Map<number, { uploadedUrl: string; uploadStatus: UploadStatus }>,
): void {
  const originalLines = originalCsv.split(/\r?\n/);
  const trailingNewline = originalCsv.endsWith("\n") ? "\n" : "";
  const header = splitCsvLine(originalLines[0]!);

  const existingUrlIdx = header.indexOf("uploaded_url");
  const existingStatusIdx = header.indexOf("upload_status");

  const newHeader = [...header];
  if (existingUrlIdx === -1) newHeader.push("uploaded_url");
  if (existingStatusIdx === -1) newHeader.push("upload_status");

  const urlIdx = existingUrlIdx === -1 ? newHeader.length - 2 : existingUrlIdx;
  const statusIdx = existingStatusIdx === -1 ? newHeader.length - 1 : existingStatusIdx;

  const outputLines: string[] = [newHeader.map(csvEscape).join(",")];
  for (let i = 0; i < rows.length; i++) {
    const r = rows[i]!;
    // Reconstruct fields from the parsed row using the (possibly extended)
    // header order. Falls back to "" for any new columns.
    const fields = newHeader.map((col) => r[col] ?? "");
    const outcome = outcomes.get(i);
    if (outcome) {
      fields[urlIdx] = outcome.uploadedUrl;
      fields[statusIdx] = outcome.uploadStatus;
    }
    outputLines.push(fields.map(csvEscape).join(","));
  }

  writeFileSync(manifestPath, outputLines.join("\n") + trailingNewline, "utf8");
}

function csvEscape(value: string): string {
  if (value.includes(",") || value.includes('"') || value.includes("\n")) {
    return `"${value.replace(/"/g, '""')}"`;
  }
  return value;
}

await main();
