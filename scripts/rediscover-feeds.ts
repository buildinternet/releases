#!/usr/bin/env bun
/**
 * Re-run feed discovery on scrape-type sources whose first evaluation didn't
 * surface a feed (`metadata.noFeedFound === true`). Some have added RSS/Atom
 * feeds since they were onboarded, and every one promoted to the cheap path
 * stops running crawl + AI on each fetch (~$9/mo per source per the #319
 * write-up).
 *
 * Flow:
 *   1. List scrape sources where metadata.feedUrl is null
 *   2. Run `discoverFeed(source.url)` on each (well-known probes + <link rel>)
 *   3. For any hit, fetch the first few entries and spot-check titles so we
 *      don't wire up a generic site-wide feed (per finding-changelogs skill).
 *   4. Print a table with verdicts; with --apply, PATCH source.metadata to
 *      set feedUrl/feedType/feedDiscoveredAt and clear noFeedFound.
 *
 * Usage:
 *   bun scripts/rediscover-feeds.ts                    # dry run (default)
 *   bun scripts/rediscover-feeds.ts --apply            # PATCH promoted ones
 *   bun scripts/rediscover-feeds.ts --json             # machine-readable
 *   bun scripts/rediscover-feeds.ts --slug <slug>      # limit to one source
 *
 * All progress/logs go to stderr. Only --json output goes to stdout.
 */

import { discoverFeed, fetchAndParseFeed } from "../packages/adapters/src/feed.js";

type SourceRow = {
  slug: string;
  name: string;
  type: string;
  url: string;
  metadata?: string | null;
};

type Verdict = {
  slug: string;
  name: string;
  pageUrl: string;
  status: "promoted" | "no-feed" | "empty-feed" | "error";
  feedUrl?: string;
  feedType?: string;
  sampleTitles?: string[];
  error?: string;
};

const API_URL = process.env.RELEASED_API_URL ?? "https://api.releases.sh";
const API_KEY = process.env.RELEASED_API_KEY;

const args = new Set(process.argv.slice(2));
const apply = args.has("--apply");
const jsonOut = args.has("--json");
const slugFilter = (() => {
  const i = process.argv.indexOf("--slug");
  return i > -1 ? process.argv[i + 1] : null;
})();

function log(msg: string): void {
  process.stderr.write(`${msg}\n`);
}

async function listCandidates(): Promise<SourceRow[]> {
  const res = await fetch(`${API_URL}/v1/sources?limit=500`);
  if (!res.ok) throw new Error(`list failed: ${res.status}`);
  const rows = (await res.json()) as SourceRow[];
  return rows.filter((r) => {
    if (r.type !== "scrape") return false;
    if (slugFilter && r.slug !== slugFilter) return false;
    let meta: Record<string, unknown> = {};
    try { meta = JSON.parse(r.metadata ?? "{}"); } catch { /* ignore */ }
    return meta.feedUrl == null;
  });
}

async function verifyFeed(
  feedUrl: string,
  feedType: "rss" | "atom" | "jsonfeed",
): Promise<{ ok: true; titles: string[] } | { ok: false; reason: string }> {
  try {
    const { releases } = await fetchAndParseFeed(feedUrl, feedType, { maxEntries: 5 });
    if (releases.length === 0) return { ok: false, reason: "feed parsed but returned 0 entries" };
    const titles = releases.slice(0, 3).map((r) => r.title).filter(Boolean) as string[];
    return { ok: true, titles };
  } catch (err) {
    return { ok: false, reason: err instanceof Error ? err.message : String(err) };
  }
}

async function patchSource(slug: string, patchedMetadata: Record<string, unknown>): Promise<void> {
  if (!API_KEY) throw new Error("RELEASED_API_KEY required to --apply");
  const res = await fetch(`${API_URL}/v1/sources/${encodeURIComponent(slug)}`, {
    method: "PATCH",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${API_KEY}`,
    },
    body: JSON.stringify({ metadata: JSON.stringify(patchedMetadata) }),
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`PATCH failed: ${res.status} ${body.slice(0, 200)}`);
  }
}

async function processOne(row: SourceRow): Promise<Verdict> {
  const base: Verdict = { slug: row.slug, name: row.name, pageUrl: row.url, status: "no-feed" };
  let discovered;
  try {
    discovered = await discoverFeed(row.url);
  } catch (err) {
    return { ...base, status: "error", error: err instanceof Error ? err.message : String(err) };
  }
  if (!discovered) return base;

  const verified = await verifyFeed(discovered.url, discovered.type);
  if (!verified.ok) {
    return {
      ...base,
      status: "empty-feed",
      feedUrl: discovered.url,
      feedType: discovered.type,
      error: verified.reason,
    };
  }

  const verdict: Verdict = {
    ...base,
    status: "promoted",
    feedUrl: discovered.url,
    feedType: discovered.type,
    sampleTitles: verified.titles,
  };

  if (apply) {
    let meta: Record<string, unknown> = {};
    try { meta = JSON.parse(row.metadata ?? "{}"); } catch { /* ignore */ }
    const patched = {
      ...meta,
      feedUrl: discovered.url,
      feedType: discovered.type,
      feedDiscoveredAt: new Date().toISOString(),
      noFeedFound: false,
    };
    try {
      await patchSource(row.slug, patched);
    } catch (err) {
      return { ...verdict, status: "error", error: err instanceof Error ? err.message : String(err) };
    }
  }

  return verdict;
}

async function main(): Promise<void> {
  const candidates = await listCandidates();
  log(`Evaluating ${candidates.length} scrape-no-feed source(s) via ${API_URL}...`);

  const verdicts: Verdict[] = [];
  for (const row of candidates) {
    log(`  ${row.slug} ← ${row.url}`);
    const v = await processOne(row);
    const statusLabel = v.status === "promoted" ? (apply ? "promoted" : "would promote") : v.status;
    log(`    → ${statusLabel}${v.feedUrl ? `: ${v.feedUrl} (${v.feedType})` : ""}${v.error ? ` — ${v.error}` : ""}`);
    if (v.sampleTitles?.length) {
      for (const t of v.sampleTitles) log(`      • ${t}`);
    }
    verdicts.push(v);
  }

  const promoted = verdicts.filter((v) => v.status === "promoted");
  const empty = verdicts.filter((v) => v.status === "empty-feed");
  const errors = verdicts.filter((v) => v.status === "error");

  log("");
  log(`${promoted.length} would promote · ${empty.length} empty-feed · ${errors.length} errors · ${verdicts.length - promoted.length - empty.length - errors.length} no feed`);
  if (!apply && promoted.length > 0) {
    log("Re-run with --apply to write metadata.");
  }

  if (jsonOut) {
    process.stdout.write(JSON.stringify({ verdicts, summary: { total: verdicts.length, promoted: promoted.length, empty: empty.length, errors: errors.length } }, null, 2) + "\n");
  }
}

main().catch((err) => {
  log(`FATAL: ${err instanceof Error ? err.message : err}`);
  process.exit(1);
});
