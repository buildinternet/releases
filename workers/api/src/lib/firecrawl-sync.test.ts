import { expect, it } from "bun:test";
import { deriveMonitorSpec, syncFirecrawlMonitor } from "./firecrawl-sync.js";
import type { FirecrawlClient } from "@releases/adapters/firecrawl.js";

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

function fakeClient(over: Partial<FirecrawlClient> = {}): FirecrawlClient {
  return {
    createMonitor: async () => "mon_new",
    getMonitor: async () => ({ id: "mon_existing" }),
    updateMonitor: async () => {},
    deleteMonitor: async () => {},
    runMonitor: async () => {},
    scrapeOnce: async () => "",
    ...over,
  } as FirecrawlClient;
}

const syncOpts = { webhookUrl: "u", webhookSecret: "s" };

it("creates a monitor when enabled and no monitorId", async () => {
  const src = {
    id: "src_1",
    slug: "s",
    url: "https://x.com",
    metadata: JSON.stringify({ firecrawl: { enabled: true } }),
  } as any;
  let created = false;
  const patch = await syncFirecrawlMonitor(
    src,
    fakeClient({
      createMonitor: async () => {
        created = true;
        return "mon_new";
      },
    }),
    syncOpts,
  );
  expect(created).toBe(true);
  expect(patch.firecrawl?.monitorId).toBe("mon_new");
  expect(patch.firecrawl?.enabled).toBe(true);
});

it("deletes and clears monitorId when disabled", async () => {
  const src = {
    id: "src_1",
    slug: "s",
    url: "https://x.com",
    metadata: JSON.stringify({ firecrawl: { enabled: false, monitorId: "mon_existing" } }),
  } as any;
  let deleted: string | null = null;
  const patch = await syncFirecrawlMonitor(
    src,
    fakeClient({
      deleteMonitor: async (id: string) => {
        deleted = id;
      },
    }),
    syncOpts,
  );
  expect(deleted!).toBe("mon_existing");
  expect(patch.firecrawl?.monitorId).toBeUndefined();
});

it("updates the monitor when enabled with an existing id", async () => {
  const src = {
    id: "src_1",
    slug: "s",
    url: "https://x.com",
    metadata: JSON.stringify({ firecrawl: { enabled: true, monitorId: "mon_existing" } }),
  } as any;
  let updated: string | null = null;
  const patch = await syncFirecrawlMonitor(
    src,
    fakeClient({
      updateMonitor: async (id: string) => {
        updated = id;
      },
    }),
    syncOpts,
  );
  expect(updated!).toBe("mon_existing");
  expect(patch.firecrawl?.monitorId).toBe("mon_existing");
});

it("no-ops when disabled and no monitorId", async () => {
  const src = {
    id: "src_1",
    slug: "s",
    url: "https://x.com",
    metadata: JSON.stringify({ firecrawl: { enabled: false } }),
  } as any;
  let calledDelete = false;
  const patch = await syncFirecrawlMonitor(
    src,
    fakeClient({
      deleteMonitor: async () => {
        calledDelete = true;
      },
    }),
    syncOpts,
  );
  expect(calledDelete).toBe(false);
  expect(patch.firecrawl?.monitorId).toBeUndefined();
});
