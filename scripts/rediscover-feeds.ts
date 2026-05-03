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

import {
  type DiscoveredFeed,
  discoverFeed,
  fetchAndParseFeed,
} from "../packages/adapters/src/feed.js";

type SourceRow = {
  id: string;
  slug: string;
  name: string;
  type: string;
  url: string;
  // GET /v1/sources returns orgSlug (not orgId) — keep the field name in
  // sync with the wire shape so patchSource builds a real URL rather than
  // /v1/orgs/undefined/sources/...
  orgSlug: string;
  metadata?: string | null;
};

type Candidate = SourceRow & { parsedMetadata: Record<string, unknown> };

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

function parseMetadata(raw: string | null | undefined): Record<string, unknown> {
  try {
    return JSON.parse(raw ?? "{}");
  } catch {
    return {};
  }
}

async function listCandidates(): Promise<Candidate[]> {
  const res = await fetch(`${API_URL}/v1/sources?limit=500`);
  if (!res.ok) throw new Error(`list failed: ${res.status}`);
  const rows = (await res.json()) as SourceRow[];
  const candidates: Candidate[] = [];
  for (const r of rows) {
    if (r.type !== "scrape") continue;
    if (slugFilter && r.slug !== slugFilter) continue;
    const parsedMetadata = parseMetadata(r.metadata);
    if (parsedMetadata.feedUrl != null) continue;
    candidates.push({ ...r, parsedMetadata });
  }
  return candidates;
}

async function verifyFeed(
  feedUrl: string,
  feedType: "rss" | "atom" | "jsonfeed",
): Promise<{ ok: true; titles: string[] } | { ok: false; reason: string }> {
  try {
    const { releases } = await fetchAndParseFeed(feedUrl, feedType, { maxEntries: 5 });
    if (releases.length === 0) return { ok: false, reason: "feed parsed but returned 0 entries" };
    const titles = releases.slice(0, 3).map((r) => r.title);
    return { ok: true, titles };
  } catch (err) {
    return { ok: false, reason: err instanceof Error ? err.message : String(err) };
  }
}

async function patchSource(
  source: Pick<SourceRow, "id" | "slug" | "orgSlug">,
  patchedMetadata: Record<string, unknown>,
): Promise<void> {
  if (!API_KEY) throw new Error("RELEASED_API_KEY required to --apply");
  // The schema enforces sources.orgId NOT NULL post-#690 Phase C, so
  // orgSlug should always populate in GET /v1/sources. If it ever doesn't
  // (stale staging API, mid-migration row, etc.), fail loudly with the
  // offending source slug rather than building a URL like
  // /v1/orgs/undefined/sources/... that returns a confusing 404.
  if (!source.orgSlug) {
    throw new Error(
      `source ${source.slug} (${source.id}) is missing orgSlug — refusing to construct an org-scoped PATCH URL`,
    );
  }
  const path = `/v1/orgs/${encodeURIComponent(source.orgSlug)}/sources/${encodeURIComponent(source.id)}`;
  const res = await fetch(`${API_URL}${path}`, {
    method: "PATCH",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${API_KEY}`,
    },
    body: JSON.stringify({ metadata: JSON.stringify(patchedMetadata) }),
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`PATCH failed: ${res.status} ${body.slice(0, 200)}`);
  }
}

async function processOne(row: Candidate): Promise<Verdict> {
  const base: Verdict = { slug: row.slug, name: row.name, pageUrl: row.url, status: "no-feed" };

  let discovered: DiscoveredFeed | null;
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
    const patched = {
      ...row.parsedMetadata,
      feedUrl: discovered.url,
      feedType: discovered.type,
      feedDiscoveredAt: new Date().toISOString(),
      noFeedFound: false,
    };
    try {
      await patchSource(row, patched);
    } catch (err) {
      return {
        ...verdict,
        status: "error",
        error: err instanceof Error ? err.message : String(err),
      };
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
    // oxlint-disable-next-line no-await-in-loop -- sequential: external HTTP probes per source; rate limit applies
    const v = await processOne(row);
    let statusLabel: string = v.status;
    if (v.status === "promoted") statusLabel = apply ? "promoted" : "would promote";
    log(
      `    → ${statusLabel}${v.feedUrl ? `: ${v.feedUrl} (${v.feedType})` : ""}${v.error ? ` — ${v.error}` : ""}`,
    );
    if (v.sampleTitles?.length) {
      for (const t of v.sampleTitles) log(`      • ${t}`);
    }
    verdicts.push(v);
  }

  const promoted = verdicts.filter((v) => v.status === "promoted").length;
  const empty = verdicts.filter((v) => v.status === "empty-feed").length;
  const errors = verdicts.filter((v) => v.status === "error").length;
  const noFeed = verdicts.filter((v) => v.status === "no-feed").length;

  log("");
  log(`${promoted} would promote · ${empty} empty-feed · ${errors} errors · ${noFeed} no feed`);
  if (!apply && promoted > 0) {
    log("Re-run with --apply to write metadata.");
  }

  if (jsonOut) {
    const summary = { total: verdicts.length, promoted, empty, errors };
    process.stdout.write(`${JSON.stringify({ verdicts, summary }, null, 2)}\n`);
  }
}

main().catch((err) => {
  log(`FATAL: ${err instanceof Error ? err.message : err}`);
  process.exit(1);
});
