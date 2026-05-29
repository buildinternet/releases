import type { Source } from "@buildinternet/releases-core/schema";
import { getSourceMeta } from "@releases/adapters/source-meta.js";
import { FirecrawlError } from "@releases/lib/errors";
import type { FirecrawlClient, FirecrawlMonitorSpec } from "@releases/adapters/firecrawl.js";
import type { SourceMetadata } from "@releases/adapters/source-meta.js";

const DEFAULT_SCHEDULE = "every 6 hours";
const DEFAULT_GOAL =
  "Detect new product releases, version announcements, or changelog entries on this page.";

export function deriveMonitorSpec(
  source: Source,
  opts: { webhookUrl: string; webhookSecret: string },
): FirecrawlMonitorSpec {
  const fc = getSourceMeta(source).firecrawl ?? { enabled: false };
  return {
    name: `releases:${source.id}`,
    // Natural-language schedule → schedule.text; Firecrawl normalizes to cron.
    schedule: { text: fc.schedule ?? DEFAULT_SCHEDULE, timezone: "UTC" },
    // Scrape targets use `urls`; the proxy tier lives in scrapeOptions, not top-level.
    targets: [
      {
        type: "scrape",
        urls: [source.url],
        scrapeOptions: { formats: ["markdown"], proxy: fc.proxy ?? "auto" },
      },
    ],
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
      await client.updateMonitor(fc.monitorId, spec);
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
