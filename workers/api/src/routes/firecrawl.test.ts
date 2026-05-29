import { describe, it, expect, beforeAll, afterAll, beforeEach } from "bun:test";
import { Hono } from "hono";
import { createTestDb, clearAllTables, type TestDatabase } from "../../../../tests/db-helper.js";
import { organizations, sources } from "@buildinternet/releases-core/schema";
import { firecrawlRoutes } from "./firecrawl.js";
import type { FirecrawlClient, FirecrawlMonitorSpec } from "@releases/adapters/firecrawl.js";

let capturedSpec: FirecrawlMonitorSpec | undefined;

const fakeClient: FirecrawlClient = {
  createMonitor: async (spec) => {
    capturedSpec = spec;
    return "mon_seeded";
  },
  deleteMonitor: async () => {},
  updateMonitor: async () => {},
  getMonitor: async () => ({ id: "mon_seeded" }),
  runMonitor: async () => {},
  scrapeOnce: async () => "",
};

let testDatabase: TestDatabase;
let fetchApi: (req: Request) => Response | Promise<Response>;

beforeAll(() => {
  testDatabase = createTestDb();
  const app = new Hono();
  app.route("/v1", firecrawlRoutes);
  fetchApi = (req) =>
    app.fetch(req, {
      DB: testDatabase.db,
      FIRECRAWL_WEBHOOK_SECRET: { get: async () => "hook" },
      _firecrawlClientOverride: fakeClient,
    } as never);
});

afterAll(() => {
  testDatabase.cleanup();
});

beforeEach(async () => {
  capturedSpec = undefined;
  clearAllTables(testDatabase.db);
  await testDatabase.db.insert(organizations).values({ id: "org_1", name: "Acme", slug: "acme" });
  await testDatabase.db.insert(sources).values({
    id: "src_1",
    orgId: "org_1",
    name: "Acme Blog",
    slug: "acme-blog",
    type: "scrape",
    url: "https://acme.example.com/blog",
  });
});

describe("POST /v1/sources/:slug/firecrawl/sync", () => {
  it("syncs a monitor and returns metadata with monitorId and enabled=true", async () => {
    // Addressed by typed `src_…` ID — `resolveSourceFromContext` rejects bare
    // slugs on this path (#698), mirroring POST /sources/:slug/fetch.
    const res = await fetchApi(
      new Request("http://test/v1/sources/src_1/firecrawl/sync", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ enabled: true }),
      }),
    );

    expect(res.status).toBe(200);
    const json = (await res.json()) as { firecrawl: { monitorId: string; enabled: boolean } };
    expect(json.firecrawl.monitorId).toBe("mon_seeded");
    expect(json.firecrawl.enabled).toBe(true);
  });

  it("stamps the webhook URL on the API origin, not the web frontend", async () => {
    // The test env sets no ADMIN_BASE_URL, so the fallback applies. Locks the
    // host against a regression to WEB_BASE_URL (https://releases.sh), which
    // would 404 the Phase 2 receiver.
    const res = await fetchApi(
      new Request("http://test/v1/sources/src_1/firecrawl/sync", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ enabled: true }),
      }),
    );

    expect(res.status).toBe(200);
    expect(capturedSpec?.webhook.url).toBe(
      "https://api.releases.sh/v1/integrations/firecrawl/webhook",
    );
  });

  it("returns 404 for a non-existent source id", async () => {
    const res = await fetchApi(
      new Request("http://test/v1/sources/src_nope/firecrawl/sync", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ enabled: true }),
      }),
    );

    expect(res.status).toBe(404);
    const json = (await res.json()) as { error: string };
    expect(json.error).toBe("not_found");
  });

  it("rejects a malformed JSON body with 400", async () => {
    const res = await fetchApi(
      new Request("http://test/v1/sources/src_1/firecrawl/sync", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "{",
      }),
    );

    // The validator raises an HTTPException for un-parseable bytes; the JSON
    // bad_request envelope is applied by the global onError (not wired into this
    // bare test app), so assert the 400 status here — the envelope shape is
    // covered by the invalid-types case below, which goes through the hook.
    expect(res.status).toBe(400);
  });

  it("rejects invalid field types with 400", async () => {
    const res = await fetchApi(
      new Request("http://test/v1/sources/src_1/firecrawl/sync", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ enabled: "yes", proxy: 123 }),
      }),
    );

    expect(res.status).toBe(400);
    const json = (await res.json()) as { error: string };
    expect(json.error).toBe("bad_request");
  });
});
