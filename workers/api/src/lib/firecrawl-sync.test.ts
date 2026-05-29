import { expect, it } from "bun:test";
import { deriveMonitorSpec } from "./firecrawl-sync.js";

const baseSource = {
  id: "src_123",
  slug: "chatgpt-release-notes",
  url: "https://help.openai.com/en/articles/6825453",
  metadata: JSON.stringify({ firecrawl: { enabled: true } }),
} as unknown as import("@buildinternet/releases-core/schema").Source;

it("derives a spec from source + metadata with defaults applied", () => {
  const spec = deriveMonitorSpec(baseSource, {
    webhookUrl: "https://api.releases.sh/v1/integrations/firecrawl/webhook",
    webhookSecret: "shh",
  });
  expect(spec.targets).toEqual([{ type: "scrape", url: baseSource.url }]);
  expect(spec.schedule).toBe("every 6 hours");
  expect(spec.proxy).toBe("auto");
  expect(spec.judgeEnabled).toBe(true);
  expect(spec.webhook.metadata.sourceId).toBe("src_123");
  expect(spec.webhook.headers["X-Firecrawl-Token"]).toBe("shh");
  expect(spec.webhook.events).toEqual(["page"]);
});

it("anchors the monitor name to the immutable source id, not the per-org slug", () => {
  // Source slugs are only unique per org (#690 dropped the global UNIQUE(slug)),
  // so two sources in different orgs can share a slug. The monitor name is our
  // idempotency anchor for matching a monitor back to a source, so it must use
  // the globally-unique, immutable id.
  const spec = deriveMonitorSpec(baseSource, { webhookUrl: "u", webhookSecret: "s" });
  expect(spec.name).toBe("releases:src_123");
});

it("honors explicit schedule/proxy/goal overrides", () => {
  const src = {
    ...baseSource,
    metadata: JSON.stringify({
      firecrawl: {
        enabled: true,
        schedule: "daily",
        proxy: "enhanced",
        goal: "x",
        judgeEnabled: false,
      },
    }),
  } as typeof baseSource;
  const spec = deriveMonitorSpec(src, { webhookUrl: "u", webhookSecret: "s" });
  expect(spec.schedule).toBe("daily");
  expect(spec.proxy).toBe("enhanced");
  expect(spec.goal).toBe("x");
  expect(spec.judgeEnabled).toBe(false);
});

it("is deterministic — same input yields identical spec", () => {
  const a = deriveMonitorSpec(baseSource, { webhookUrl: "u", webhookSecret: "s" });
  const b = deriveMonitorSpec(baseSource, { webhookUrl: "u", webhookSecret: "s" });
  expect(JSON.stringify(a)).toBe(JSON.stringify(b));
});
