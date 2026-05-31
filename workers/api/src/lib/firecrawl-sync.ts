import type { Source } from "@buildinternet/releases-core/schema";
import { getSourceMeta } from "@releases/adapters/source-meta.js";
import { FirecrawlError } from "@releases/lib/errors";
import type { FirecrawlClient, FirecrawlMonitorSpec } from "@releases/adapters/firecrawl.js";
import type { SourceMetadata } from "@releases/adapters/source-meta.js";

const DEFAULT_SCHEDULE = "every 6 hours";
const DEFAULT_GOAL =
  "Detect new product releases, version announcements, or changelog entries on this page.";

// Crawl-target defaults. A crawl monitor runs a full crawl of the index URL on
// every check (more credits than a single-URL scrape), so the page `limit` is
// deliberately modest — newest entry pages surface first in link-discovery
// order, so a small window keeps a daily-cadence monitor fresh without crawling
// deep history (use the backfill workflow for that). Depth mirrors the in-repo
// crawl adapter's `depth: 2` (index → entry pages).
const DEFAULT_CRAWL_LIMIT = 25;
const DEFAULT_CRAWL_DEPTH = 2;

export function deriveMonitorSpec(
  source: Source,
  opts: { webhookUrl: string; webhookSecret: string },
): FirecrawlMonitorSpec {
  const fc = getSourceMeta(source).firecrawl ?? { enabled: false };
  const proxy = fc.proxy ?? "auto";
  // A `crawl` monitor watches a multi-page changelog: Firecrawl crawls the index
  // (`source.url`) each check and reports each discovered per-entry page on its
  // own URL. Scrape targets use `urls: [url]`; crawl targets use a single `url`
  // plus `crawlOptions`. Both apply `scrapeOptions` (markdown + proxy) per page.
  const target: FirecrawlMonitorSpec["targets"][number] =
    fc.target === "crawl"
      ? {
          type: "crawl",
          url: source.url,
          crawlOptions: {
            limit: fc.crawl?.limit ?? DEFAULT_CRAWL_LIMIT,
            maxDiscoveryDepth: fc.crawl?.maxDiscoveryDepth ?? DEFAULT_CRAWL_DEPTH,
            ...(fc.crawl?.includePaths ? { includePaths: fc.crawl.includePaths } : {}),
            ...(fc.crawl?.excludePaths ? { excludePaths: fc.crawl.excludePaths } : {}),
            ...(fc.crawl?.sitemap ? { sitemap: fc.crawl.sitemap } : {}),
          },
          scrapeOptions: { formats: ["markdown"], proxy },
        }
      : {
          type: "scrape",
          urls: [source.url],
          scrapeOptions: { formats: ["markdown"], proxy },
        };
  return {
    name: `releases:${source.id}`,
    // Natural-language schedule → schedule.text; Firecrawl normalizes to cron.
    schedule: { text: fc.schedule ?? DEFAULT_SCHEDULE, timezone: "UTC" },
    targets: [target],
    goal: fc.goal ?? DEFAULT_GOAL,
    judgeEnabled: fc.judgeEnabled ?? true,
    webhook: {
      url: opts.webhookUrl,
      headers: { "X-Firecrawl-Token": opts.webhookSecret },
      metadata: { sourceId: source.id },
      events: ["monitor.page"],
    },
  };
}

/**
 * Reconcile a single source's Firecrawl monitor to match its desired state.
 * Idempotent + keyed on deriveMonitorSpec — a future reconcile sweep is just a
 * loop over this. Returns a metadata patch the caller persists (merge into the
 * existing metadata; only the `firecrawl` key is authoritative here).
 */
export async function syncFirecrawlMonitor(
  source: Source,
  client: FirecrawlClient,
  opts: { webhookUrl: string; webhookSecret: string },
): Promise<Pick<SourceMetadata, "firecrawl">> {
  const meta = getSourceMeta(source);
  const fc = meta.firecrawl ?? { enabled: false };

  if (!fc.enabled) {
    if (fc.monitorId) await client.deleteMonitor(fc.monitorId);
    const { monitorId: _drop, ...rest } = fc;
    return { firecrawl: { ...rest, enabled: false } };
  }

  const spec = deriveMonitorSpec(source, opts);
  if (fc.monitorId) {
    try {
      // Reconcile ONLY the app-owned webhook (URL + X-Firecrawl-Token + sourceId
      // + events). The PATCH merges, so schedule / proxy / goal / targets stay
      // exactly as the operator set them on the Firecrawl dashboard — sync never
      // fights dashboard config. Those tuning fields are established at create
      // time (below) and are dashboard-authoritative thereafter.
      await client.updateMonitor(fc.monitorId, { webhook: spec.webhook });
      return { firecrawl: { ...fc, enabled: true } };
    } catch (err) {
      // Self-heal: a 404 means the monitor was deleted upstream (e.g. via the
      // Firecrawl dashboard) — fall through to recreate and re-stamp the new id.
      // Any other error propagates; we don't mint duplicates on transient failures.
      if (!(err instanceof FirecrawlError) || err.status !== 404) throw err;
    }
  }
  const monitorId = await client.createMonitor(spec);
  return { firecrawl: { ...fc, enabled: true, monitorId } };
}
