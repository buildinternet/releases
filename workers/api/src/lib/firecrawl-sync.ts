import type { Source } from "@buildinternet/releases-core/schema";
import { getSourceMeta } from "@releases/adapters/source-meta.js";
import type { FirecrawlMonitorSpec } from "@releases/adapters/firecrawl.js";

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
    schedule: fc.schedule ?? DEFAULT_SCHEDULE,
    targets: [{ type: "scrape", url: source.url }],
    proxy: fc.proxy ?? "auto",
    goal: fc.goal ?? DEFAULT_GOAL,
    judgeEnabled: fc.judgeEnabled ?? true,
    webhook: {
      url: opts.webhookUrl,
      headers: { "X-Firecrawl-Token": opts.webhookSecret },
      metadata: { sourceId: source.id },
      events: ["page"],
    },
  };
}
