#!/usr/bin/env bun
/**
 * Export a tracked org's live registry data back into an owner-declared
 * `releases.json` v2 domain manifest (the inverse of the well-known
 * materializer / stub reconciler in `workers/api/src/lib/well-known/`).
 *
 * Purpose: produce a per-org baseline manifest that a human or agent can edit,
 * then feed back through the well-known sweep to ENRICH upstream data. Note the
 * reconciler is fill-if-empty / no-clobber — re-ingesting an edited manifest
 * fills MISSING fields (descriptions, categories, tags, extra products) but
 * will not overwrite values already populated. To correct existing values, use
 * the entity PATCH routes, not the manifest sweep.
 *
 * Data source: the public read surface `GET /v1/orgs/:slug`, which returns the
 * org header + `products[]` + `sources[]`. Reads only — no auth needed for
 * public orgs. Reconstruction projects from live sources+products, so it covers
 * every tracked org regardless of how it was onboarded (discovery / CLI /
 * manifest), unlike the `release_locations`-only path in promote.ts.
 *
 * Locator routing mirrors `resolveStrategy` in
 * `packages/adapters/src/fetch-plan.ts`:
 *   github  ← source.type === "github"  OR  metadata.githubUrl set
 *   appstore← source.type === "appstore"
 *   feed    ← metadata.feedUrl set
 *   url     ← everything else (scrape / agent / video / crawl)
 * A source is nested under its product (via `productSlug`) or, if unlinked,
 * rides the top-level releases[]. `isPrimary` → `canonical: true` (one per
 * array, which is all the schema allows).
 *
 * Usage:
 *   # one org, written to .context/manifests/<slug>.json (default)
 *   bun scripts/export-org-manifest.ts vercel
 *
 *   # print to stdout instead of writing a file
 *   bun scripts/export-org-manifest.ts vercel --stdout
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
import { isValidKind } from "@buildinternet/releases-core/kinds";
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

// ── Wire shapes (the subset of GET /v1/orgs/:slug we consume) ──

interface WireCategory {
  slug: string;
}
interface WireProduct {
  slug: string;
  name: string;
  url: string | null;
  description: string | null;
  kind?: string | null;
}
interface WireSource {
  slug: string;
  name: string;
  type: string;
  url?: string;
  isPrimary?: boolean;
  metadata?: string | null;
  productSlug?: string | null;
  kind?: string | null;
}
interface WireOrg {
  slug: string;
  name: string;
  domain: string | null;
  description?: string | null;
  category?: WireCategory | string | null;
  avatarUrl: string | null;
  tags?: string[];
  products: WireProduct[];
  sources: WireSource[];
}

// ── Manifest shapes (releases.json v2 domain scope) ──

interface Locator {
  url?: string;
  feed?: string;
  github?: string;
  appstore?: string;
  title?: string;
  canonical?: true;
}
interface ManifestProduct {
  name: string;
  slug?: string;
  kind?: string;
  description?: string;
  website?: string;
  releases?: Locator[];
}
interface Manifest {
  $schema?: string;
  version: 2;
  name?: string;
  description?: string;
  category?: string;
  avatar?: string;
  tags?: string[];
  products?: ManifestProduct[];
  releases?: Locator[];
}

function parseMeta(raw: string | null | undefined): Record<string, unknown> {
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

/** "https://github.com/owner/repo(.git)" | "owner/repo" → "owner/repo". */
function githubCoord(value: string): string | null {
  const m = value.match(/github\.com\/([^/]+)\/([^/#?]+)/i);
  const [owner, repo] = m ? [m[1], m[2]] : value.split("/");
  if (!owner || !repo) return null;
  return `${owner}/${repo.replace(/\.git$/i, "")}`;
}

/**
 * Project one source onto a single locator, following the same discriminator
 * precedence the fetch planner uses. Returns null when no usable target can be
 * derived (e.g. a github source with an unparseable coordinate and no url).
 */
function sourceToLocator(source: WireSource): Locator | null {
  const meta = parseMeta(source.metadata);
  const githubUrl = typeof meta.githubUrl === "string" ? meta.githubUrl : undefined;
  const feedUrl = typeof meta.feedUrl === "string" ? meta.feedUrl : undefined;

  let base: Locator | null = null;
  if (source.type === "github" || githubUrl) {
    const coord = githubCoord(githubUrl ?? source.url ?? "");
    if (coord) base = { github: coord };
    else if (source.url) base = { url: source.url }; // github override w/o parseable coord
  } else if (source.type === "appstore" && source.url) {
    base = { appstore: source.url };
  } else if (feedUrl) {
    base = { feed: feedUrl };
  } else if (source.url) {
    base = { url: source.url };
  }
  if (!base) return null;
  if (source.isPrimary) base.canonical = true;
  return base;
}

/** Enforce the schema's ≤1-canonical-per-array rule: keep the first, drop the rest. */
function dedupeCanonical(locators: Locator[]): Locator[] {
  let seen = false;
  return locators.map((loc) => {
    if (!loc.canonical) return loc;
    if (seen) {
      const { canonical: _drop, ...rest } = loc;
      return rest;
    }
    seen = true;
    return loc;
  });
}

function categorySlug(cat: WireOrg["category"]): string | undefined {
  if (!cat) return undefined;
  if (typeof cat === "string") return cat;
  return cat.slug;
}

function buildManifest(org: WireOrg): Manifest {
  const bySlug = new Map<string, Locator[]>();
  const topLevel: Locator[] = [];
  const productSlugs = new Set(org.products.map((p) => p.slug));

  for (const source of org.sources) {
    const locator = sourceToLocator(source);
    if (!locator) continue;
    const key = source.productSlug;
    if (key && productSlugs.has(key)) {
      const bucket = bySlug.get(key) ?? [];
      bucket.push(locator);
      bySlug.set(key, bucket);
    } else {
      topLevel.push(locator);
    }
  }

  const products: ManifestProduct[] = org.products.map((p) => {
    const releases = dedupeCanonical(bySlug.get(p.slug) ?? []);
    const kind = p.kind && isValidKind(p.kind) ? p.kind : undefined;
    return {
      name: p.name,
      slug: p.slug,
      ...(kind ? { kind } : {}),
      ...(p.description ? { description: p.description } : {}),
      ...(p.url ? { website: p.url } : {}),
      ...(releases.length > 0 ? { releases } : {}),
    };
  });

  const category = categorySlug(org.category);
  const avatar = org.avatarUrl && org.avatarUrl.startsWith("https://") ? org.avatarUrl : undefined;
  const dedupedTop = dedupeCanonical(topLevel);

  return {
    $schema: "https://releases.sh/schemas/releases.json",
    version: 2,
    ...(org.name ? { name: org.name } : {}),
    ...(org.description ? { description: org.description } : {}),
    ...(category ? { category } : {}),
    ...(avatar ? { avatar } : {}),
    ...(org.tags && org.tags.length > 0 ? { tags: org.tags } : {}),
    ...(products.length > 0 ? { products } : {}),
    ...(dedupedTop.length > 0 ? { releases: dedupedTop } : {}),
  };
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

/**
 * Fetch, reconstruct, write, and validate a single org's manifest. Never
 * throws — a fetch/parse failure is reported as `{ ok: false, error }` so an
 * `--all` sweep isn't aborted by one bad org.
 */
async function exportOrg(
  slug: string,
  api: string,
  headers: Record<string, string>,
  outDir: string,
): Promise<ExportResult> {
  const url = `${api}/v1/orgs/${encodeURIComponent(slug)}`;
  let org: WireOrg;
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
    org = (await res.json()) as WireOrg;
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

  const manifest = buildManifest(org);
  const json = `${JSON.stringify(manifest, null, 2)}\n`;
  mkdirSync(outDir, { recursive: true });
  const outPath = join(outDir, `${org.slug}.json`);
  writeFileSync(outPath, json);

  // Validate through the skill's bundled validator — the same contract the
  // well-known sweep enforces, so a passing export is round-trippable.
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

  return { slug: org.slug, ok: true, valid, productCount, locatorCount, outPath, json };
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
    logger.error(`GET ${args.api}/v1/orgs/${args.slug} → ${result.error}`);
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
