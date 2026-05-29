import { expect, it } from "bun:test";
import { createFirecrawlClient, type FirecrawlMonitorSpec } from "./firecrawl.js";

const spec: FirecrawlMonitorSpec = {
  name: "test-monitor",
  schedule: "every 6 hours",
  targets: [{ type: "scrape", url: "https://example.com/changelog" }],
  proxy: "auto",
  goal: "Detect new releases",
  judgeEnabled: true,
  webhook: {
    url: "https://api.example.com/hook",
    headers: { "X-Firecrawl-Token": "secret" },
    metadata: { sourceId: "src_123" },
    events: ["monitor.page"],
  },
};

it("createMonitor POSTs the spec and returns the monitor id", async () => {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const fakeFetch = (async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    return new Response(JSON.stringify({ success: true, monitor: { id: "mon_abc" } }), {
      status: 200,
    });
  }) as unknown as typeof fetch;

  const client = createFirecrawlClient({ apiKey: "k", fetch: fakeFetch });
  const id = await client.createMonitor(spec);

  expect(id).toBe("mon_abc");
  expect(calls[0].url).toBe("https://api.firecrawl.dev/v2/monitor");
  expect(calls[0].init.method).toBe("POST");
  expect((calls[0].init.headers as Record<string, string>).Authorization).toBe("Bearer k");
});

it("deleteMonitor DELETEs the monitor id", async () => {
  const calls: string[] = [];
  const fakeFetch = (async (url: string) => {
    calls.push(url);
    return new Response(JSON.stringify({ success: true }), { status: 200 });
  }) as unknown as typeof fetch;
  const client = createFirecrawlClient({ apiKey: "k", fetch: fakeFetch });
  await client.deleteMonitor("mon_abc");
  expect(calls[0]).toBe("https://api.firecrawl.dev/v2/monitor/mon_abc");
});

it("throws on non-2xx", async () => {
  const fakeFetch = (async () => new Response("nope", { status: 401 })) as unknown as typeof fetch;
  const client = createFirecrawlClient({ apiKey: "k", fetch: fakeFetch });
  await expect(client.createMonitor(spec)).rejects.toThrow();
});

it("createMonitor throws when a 200 response has no monitor id", async () => {
  const fakeFetch = (async () =>
    new Response(JSON.stringify({ success: true }), { status: 200 })) as unknown as typeof fetch;
  const client = createFirecrawlClient({ apiKey: "k", fetch: fakeFetch });
  await expect(client.createMonitor(spec)).rejects.toThrow();
});
