#!/usr/bin/env bun
/**
 * Export tracked orgs to owner-declared `releases.json` v2 domain manifests by
 * calling the backend reconstruction endpoint `GET /v1/orgs/:slug/manifest`
 * (the inverse of the well-known materializer). The endpoint is the single
 * source of truth for the source→locator mapping — shared with the
 * `releases json export` CLI command — so this script is a thin bulk driver.
 *
 * Purpose: produce a per-org baseline manifest a human or agent can edit, then
 * feed back through the well-known sweep to ENRICH upstream data. Note the
 * reconciler is fill-if-empty / no-clobber — re-ingesting an edited manifest
 * fills MISSING fields (descriptions, categories, tags, extra products) but
 * will not overwrite values already populated. To correct existing values, use
 * the entity PATCH routes, not the manifest sweep.
 *
 * Each exported file is re-validated locally through the skill's bundled
 * validator (`skills/creating-releases-json/scripts/validate.mjs`) — the same
 * contract the sweep enforces — so a passing export is round-trippable.
 *
 * Usage:
 *   # one org, written to .context/manifests/<slug>.json (default)
 *   bun scripts/export-org-manifest.ts vercel
 *
 *   # print to stdout instead of writing a file
 *   bun scripts/export-org-manifest.ts vercel --stdout
 *
 *   # every org, bounded concurrency
 *   bun scripts/export-org-manifest.ts --all [--include-empty] [--concurrency N]
 *
 *   # against staging (sends X-Releases-Staging-Key from env)
 *   RELEASES_API_URL=https://api-staging.releases.sh \
 *   STAGING_ACCESS_KEY=... \
 *   bun scripts/export-org-manifest.ts vercel
 *
 * Env:
 *   RELEASES_API_URL      API base (default https://api.releases.sh)
 *   STAGING_ACCESS_KEY    Optional; if set, sent as X-Releases-Staging-Key
 */

import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { logger } from "@buildinternet/releases-lib/logger";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, "..");
const VALIDATOR = join(REPO_ROOT, "skills/creating-releases-json/scripts/validate.mjs");

interface Args {
  slug: string;
  out: string;
  stdout: boolean;
  api: string;
  all: boolean;
  includeEmpty: boolean;
  concurrency: number;
}

function parseArgs(argv: string[]): Args {
  const args: Args = {
    slug: "",
    out: join(REPO_ROOT, ".context/manifests"),
    stdout: false,
    api: (process.env.RELEASES_API_URL ?? "https://api.releases.sh").replace(/\/+$/, ""),
    all: false,
    includeEmpty: false,
    concurrency: 6,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--help" || a === "-h") {
      logger.info(
        "Usage:\n" +
          "  bun scripts/export-org-manifest.ts <org-slug> [--out <dir>] [--stdout] [--api <url>]\n" +
          "  bun scripts/export-org-manifest.ts --all [--include-empty] [--concurrency N] [--out <dir>]\n" +
          "Env: RELEASES_API_URL (default https://api.releases.sh), STAGING_ACCESS_KEY?",
      );
      process.exit(0);
    } else if (a === "--out") args.out = argv[++i] ?? args.out;
    else if (a?.startsWith("--out=")) args.out = a.slice("--out=".length);
    else if (a === "--stdout") args.stdout = true;
    else if (a === "--all") args.all = true;
    else if (a === "--include-empty") args.includeEmpty = true;
    else if (a === "--concurrency") args.concurrency = Number(argv[++i]) || args.concurrency;
    else if (a?.startsWith("--concurrency="))
      args.concurrency = Number(a.slice("--concurrency=".length)) || args.concurrency;
    else if (a === "--api") args.api = (argv[++i] ?? "").replace(/\/+$/, "");
    else if (a?.startsWith("--api=")) args.api = a.slice("--api=".length).replace(/\/+$/, "");
    else if (a && !a.startsWith("-")) args.slug = a;
  }
  return args;
}

interface ExportResult {
  slug: string;
  ok: boolean;
  valid: boolean;
  productCount: number;
  locatorCount: number;
  outPath?: string;
  json?: string;
  error?: string;
}

interface Manifest {
  products?: { releases?: unknown[] }[];
  releases?: unknown[];
}

/**
 * Fetch one org's reconstructed manifest from the backend, write it, and
 * re-validate locally. Never throws — a fetch/parse failure is reported as
 * `{ ok: false, error }` so an `--all` sweep isn't aborted by one bad org.
 */
async function exportOrg(
  slug: string,
  api: string,
  headers: Record<string, string>,
  outDir: string,
): Promise<ExportResult> {
  const url = `${api}/v1/orgs/${encodeURIComponent(slug)}/manifest`;
  let manifest: Manifest;
  let json: string;
  try {
    const res = await fetch(url, { headers });
    if (!res.ok) {
      return {
        slug,
        ok: false,
        valid: false,
        productCount: 0,
        locatorCount: 0,
        error: `${res.status} ${res.statusText}`,
      };
    }
    manifest = (await res.json()) as Manifest;
    json = `${JSON.stringify(manifest, null, 2)}\n`;
  } catch (e) {
    return {
      slug,
      ok: false,
      valid: false,
      productCount: 0,
      locatorCount: 0,
      error: (e as Error).message,
    };
  }

  mkdirSync(outDir, { recursive: true });
  const outPath = join(outDir, `${slug}.json`);
  writeFileSync(outPath, json);

  let valid = true;
  try {
    execFileSync("node", [VALIDATOR, outPath, "--scope", "domain"], { encoding: "utf8" });
  } catch {
    valid = false;
  }

  const productCount = manifest.products?.length ?? 0;
  const locatorCount =
    (manifest.releases?.length ?? 0) +
    (manifest.products ?? []).reduce((s, p) => s + (p.releases?.length ?? 0), 0);

  return { slug, ok: true, valid, productCount, locatorCount, outPath, json };
}

/** Enumerate every org slug via the offset-paginated `/v1/orgs` list. */
async function listOrgSlugs(
  api: string,
  headers: Record<string, string>,
  includeEmpty: boolean,
): Promise<string[]> {
  const slugs: string[] = [];
  const pageSize = 100;
  for (let page = 1; ; page++) {
    const qs = new URLSearchParams({ page: String(page), limit: String(pageSize) });
    if (includeEmpty) qs.set("includeEmpty", "1");
    // oxlint-disable-next-line no-await-in-loop -- sequential pagination; each page depends on the prior's hasMore
    const res = await fetch(`${api}/v1/orgs?${qs}`, { headers });
    if (!res.ok) throw new Error(`GET /v1/orgs?${qs} → ${res.status} ${res.statusText}`);
    const body = (await res.json()) as {
      items: { slug: string }[];
      pagination: { hasMore: boolean };
    };
    for (const item of body.items) slugs.push(item.slug);
    if (!body.pagination.hasMore || body.items.length === 0) break;
  }
  return slugs;
}

/** Run `worker` over `items` with at most `limit` in flight at once. */
async function pool<T, R>(
  items: T[],
  limit: number,
  worker: (item: T) => Promise<R>,
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;
  async function run(): Promise<void> {
    while (next < items.length) {
      const i = next++;
      results[i] = await worker(items[i]);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, run));
  return results;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const headers: Record<string, string> = { accept: "application/json" };
  if (process.env.STAGING_ACCESS_KEY) {
    headers["X-Releases-Staging-Key"] = process.env.STAGING_ACCESS_KEY;
  }

  if (args.all) {
    const slugs = await listOrgSlugs(args.api, headers, args.includeEmpty);
    logger.info(`Exporting ${slugs.length} orgs → ${args.out} (concurrency ${args.concurrency})`);
    const results = await pool(slugs, args.concurrency, (slug) =>
      exportOrg(slug, args.api, headers, args.out),
    );

    const failed = results.filter((r) => !r.ok);
    const invalid = results.filter((r) => r.ok && !r.valid);
    const valid = results.filter((r) => r.ok && r.valid);
    const totalLocators = valid.reduce((s, r) => s + r.locatorCount, 0);

    for (const r of invalid) logger.warn(`INVALID  ${r.slug}`);
    for (const r of failed) logger.error(`FAILED   ${r.slug}  (${r.error})`);
    logger.info(
      `Done: ${valid.length} valid, ${invalid.length} invalid, ${failed.length} failed ` +
        `(${totalLocators} locators total) → ${args.out}`,
    );
    if (failed.length > 0 || invalid.length > 0) process.exit(1);
    return;
  }

  if (!args.slug) {
    logger.error("Missing <org-slug> (or pass --all). Run with --help for usage.");
    process.exit(1);
  }

  const result = await exportOrg(args.slug, args.api, headers, args.out);
  if (!result.ok) {
    logger.error(`GET ${args.api}/v1/orgs/${args.slug}/manifest → ${result.error}`);
    process.exit(1);
  }
  if (args.stdout && result.json) process.stdout.write(result.json);
  logger.info(
    `${result.valid ? "VALID" : "INVALID"}  ${result.slug}  ` +
      `(${result.productCount} products, ${result.locatorCount} locators)  → ${result.outPath}`,
  );
  if (!result.valid) process.exit(1);
}

void main();
