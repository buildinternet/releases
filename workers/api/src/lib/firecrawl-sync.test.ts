import { expect, it } from "bun:test";
import { deriveMonitorSpec, syncFirecrawlMonitor } from "./firecrawl-sync.js";
import { FirecrawlError } from "@releases/lib/errors";
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
  expect(spec.targets).toEqual([
    {
      type: "scrape",
      urls: [baseSource.url],
      scrapeOptions: { formats: ["markdown"], proxy: "auto" },
    },
  ]);
  expect(spec.schedule).toEqual({ text: "every 6 hours", timezone: "UTC" });
  expect(spec.judgeEnabled).toBe(true);
  expect(spec.webhook?.metadata?.sourceId).toBe("src_123");
  expect(spec.webhook?.headers?.["X-Firecrawl-Token"]).toBe("shh");
  expect(spec.webhook?.events).toEqual(["monitor.page"]);
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
  expect(spec.schedule).toEqual({ text: "daily", timezone: "UTC" });
  expect(spec.targets[0]?.scrapeOptions?.proxy).toBe("enhanced");
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

function makeSource(fc: Record<string, unknown>) {
  return {
    id: "src_1",
    slug: "s",
    url: "https://x.com",
    metadata: JSON.stringify({ firecrawl: fc }),
  } as any;
}

it("creates a monitor when enabled and no monitorId", async () => {
  const src = makeSource({ enabled: true });
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
  const src = makeSource({ enabled: false, monitorId: "mon_existing" });
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
  const src = makeSource({ enabled: true, monitorId: "mon_existing" });
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

it("on update sends ONLY the app-owned webhook — never the dashboard-tunable fields", async () => {
  // The Firecrawl dashboard is a second writer: an operator can retune frequency,
  // proxy, or goal there. PATCH merges, so we reconcile only the webhook (URL +
  // X-Firecrawl-Token + sourceId + events) and leave schedule/proxy/goal/targets
  // exactly as the dashboard has them — sync must never fight dashboard config.
  const src = makeSource({
    enabled: true,
    monitorId: "mon_existing",
    schedule: "every 6 hours",
    proxy: "enhanced",
    goal: "old goal",
  });
  let sentSpec: Record<string, unknown> | undefined;
  await syncFirecrawlMonitor(
    src,
    fakeClient({
      updateMonitor: async (_id: string, spec: Record<string, unknown>) => {
        sentSpec = spec;
      },
    }),
    syncOpts,
  );
  const webhook = sentSpec?.webhook as {
    metadata?: { sourceId?: string };
    headers?: Record<string, string>;
  };
  expect(webhook?.metadata?.sourceId).toBe("src_1");
  expect(webhook?.headers?.["X-Firecrawl-Token"]).toBe("s");
  // Nothing that would clobber operator changes in the dashboard.
  expect(sentSpec?.schedule).toBeUndefined();
  expect(sentSpec?.proxy).toBeUndefined();
  expect(sentSpec?.goal).toBeUndefined();
  expect(sentSpec?.targets).toBeUndefined();
  expect(sentSpec?.judgeEnabled).toBeUndefined();
});

it("no-ops when disabled and no monitorId", async () => {
  const src = makeSource({ enabled: false });
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

it("recreates the monitor when update returns 404 (stale id) and re-stamps the new id", async () => {
  const src = makeSource({ enabled: true, monitorId: "mon_stale" });
  let createdId: string | null = null;
  const patch = await syncFirecrawlMonitor(
    src,
    fakeClient({
      updateMonitor: async () => {
        throw new FirecrawlError(404, "PATCH", "/monitor/mon_stale", "not found");
      },
      createMonitor: async () => {
        createdId = "mon_recreated";
        return createdId;
      },
    }),
    syncOpts,
  );
  expect(createdId!).toBe("mon_recreated");
  expect(patch.firecrawl?.monitorId).toBe("mon_recreated");
});

it("rethrows a non-404 update error without recreating", async () => {
  const src = makeSource({ enabled: true, monitorId: "mon_x" });
  let created = false;
  await expect(
    syncFirecrawlMonitor(
      src,
      fakeClient({
        updateMonitor: async () => {
          throw new FirecrawlError(500, "PATCH", "/monitor/mon_x", "server error");
        },
        createMonitor: async () => {
          created = true;
          return "nope";
        },
      }),
      syncOpts,
    ),
  ).rejects.toThrow();
  expect(created).toBe(false);
});
