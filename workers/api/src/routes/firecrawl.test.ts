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

// ---------------------------------------------------------------------------
// Webhook receiver tests (Phase 2)
// ---------------------------------------------------------------------------

type SpawnedWorkflow = { id: string; params: Record<string, unknown> };

let spawns: SpawnedWorkflow[] = [];
let cacheStore: Record<string, string> = {};

const makeEnv = (overrides?: Partial<Record<string, unknown>>) => ({
  DB: testDatabase.db,
  FIRECRAWL_WEBHOOK_SECRET: { get: async () => "testhook" },
  _firecrawlClientOverride: fakeClient,
  LATEST_CACHE: {
    get: async (key: string) => cacheStore[key] ?? null,
    put: async (key: string, value: string) => {
      cacheStore[key] = value;
    },
  },
  FIRECRAWL_INGEST_WORKFLOW: {
    create: async (o: SpawnedWorkflow) => {
      spawns.push(o);
    },
  },
  ...overrides,
});

// Separate Hono app that injects the extended env for webhook tests.
let webhookFetchApi: (req: Request) => Response | Promise<Response>;

const makeWebhookBody = (
  sourceId: string,
  dataItems: Array<{
    checkId?: string;
    url?: string;
    status?: string;
    judgment?: { meaningful?: boolean; confidence?: string };
  }>,
) =>
  JSON.stringify({
    success: true,
    type: "monitor.page",
    id: "evt_1",
    webhookId: "wh_1",
    metadata: { sourceId },
    data: dataItems,
  });

describe("POST /v1/integrations/firecrawl/webhook", () => {
  beforeEach(async () => {
    spawns = [];
    cacheStore = {};
    clearAllTables(testDatabase.db);
    await testDatabase.db.insert(organizations).values({ id: "org_1", name: "Acme", slug: "acme" });
    // Phase 1 sync tests use src_1 without firecrawl; webhook tests use src_fc
    // which has firecrawl enabled so the two sets don't interfere.
    await testDatabase.db.insert(sources).values({
      id: "src_fc",
      orgId: "org_1",
      name: "Acme Changelog",
      slug: "acme-changelog",
      type: "scrape",
      url: "https://acme.example.com/changelog",
      metadata: JSON.stringify({ firecrawl: { enabled: true } }),
    });
    // Rebuild the app with extended env each time so env overrides per-test work.
    const app = new Hono();
    app.route("/v1", firecrawlRoutes);
    webhookFetchApi = (req) => app.fetch(req, makeEnv() as never);
  });

  it("1. returns 401 when X-Firecrawl-Token header is missing", async () => {
    const res = await webhookFetchApi(
      new Request("http://test/v1/integrations/firecrawl/webhook", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: makeWebhookBody("src_fc", [
          { checkId: "c1", url: "https://acme.example.com/changelog", status: "new" },
        ]),
      }),
    );
    expect(res.status).toBe(401);
    expect(spawns).toHaveLength(0);
  });

  it("2. returns 401 when token is wrong", async () => {
    const res = await webhookFetchApi(
      new Request("http://test/v1/integrations/firecrawl/webhook", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Firecrawl-Token": "wrongtoken",
        },
        body: makeWebhookBody("src_fc", [
          { checkId: "c1", url: "https://acme.example.com/changelog", status: "new" },
        ]),
      }),
    );
    expect(res.status).toBe(401);
    expect(spawns).toHaveLength(0);
  });

  it("3. spawns a workflow for status=new with correct params", async () => {
    const res = await webhookFetchApi(
      new Request("http://test/v1/integrations/firecrawl/webhook", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Firecrawl-Token": "testhook",
        },
        body: makeWebhookBody("src_fc", [
          { checkId: "c1", url: "https://acme.example.com/changelog", status: "new" },
        ]),
      }),
    );
    expect(res.status).toBe(200);
    expect(spawns).toHaveLength(1);
    expect(spawns[0].id).toContain("c1");
    expect(spawns[0].params).toMatchObject({
      sourceId: "src_fc",
      url: "https://acme.example.com/changelog",
      checkId: "c1",
      status: "new",
    });
  });

  it("4. spawns a workflow for status=changed + judgment.meaningful=true", async () => {
    const res = await webhookFetchApi(
      new Request("http://test/v1/integrations/firecrawl/webhook", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Firecrawl-Token": "testhook",
        },
        body: makeWebhookBody("src_fc", [
          {
            checkId: "c2",
            url: "https://acme.example.com/changelog",
            status: "changed",
            judgment: { meaningful: true, confidence: "high" },
          },
        ]),
      }),
    );
    expect(res.status).toBe(200);
    expect(spawns).toHaveLength(1);
  });

  it("5. skips workflow for status=changed + judgment.meaningful=false", async () => {
    const res = await webhookFetchApi(
      new Request("http://test/v1/integrations/firecrawl/webhook", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Firecrawl-Token": "testhook",
        },
        body: makeWebhookBody("src_fc", [
          {
            checkId: "c3",
            url: "https://acme.example.com/changelog",
            status: "changed",
            judgment: { meaningful: false, confidence: "high" },
          },
        ]),
      }),
    );
    expect(res.status).toBe(200);
    expect(spawns).toHaveLength(0);
  });

  it("6. spawns workflow for status=changed with no judgment (fail-open)", async () => {
    const res = await webhookFetchApi(
      new Request("http://test/v1/integrations/firecrawl/webhook", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Firecrawl-Token": "testhook",
        },
        body: makeWebhookBody("src_fc", [
          {
            checkId: "c4",
            url: "https://acme.example.com/changelog",
            status: "changed",
          },
        ]),
      }),
    );
    expect(res.status).toBe(200);
    expect(spawns).toHaveLength(1);
  });

  it("7. skips workflow for status=same", async () => {
    const res = await webhookFetchApi(
      new Request("http://test/v1/integrations/firecrawl/webhook", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Firecrawl-Token": "testhook",
        },
        body: makeWebhookBody("src_fc", [
          { checkId: "c5", url: "https://acme.example.com/changelog", status: "same" },
        ]),
      }),
    );
    expect(res.status).toBe(200);
    expect(spawns).toHaveLength(0);
  });

  it("8. returns 200 with no spawn for unknown sourceId", async () => {
    const res = await webhookFetchApi(
      new Request("http://test/v1/integrations/firecrawl/webhook", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Firecrawl-Token": "testhook",
        },
        body: makeWebhookBody("src_notexist", [
          { checkId: "c6", url: "https://acme.example.com/changelog", status: "new" },
        ]),
      }),
    );
    expect(res.status).toBe(200);
    expect(spawns).toHaveLength(0);
  });

  it("9. idempotency: skips spawn when checkId+url already in cache", async () => {
    const app = new Hono();
    app.route("/v1", firecrawlRoutes);
    const idempotentFetchApi = (req: Request) =>
      app.fetch(
        req,
        makeEnv({
          LATEST_CACHE: {
            get: async () => "1", // always returns hit
            put: async () => {},
          },
        }) as never,
      );

    const res = await idempotentFetchApi(
      new Request("http://test/v1/integrations/firecrawl/webhook", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Firecrawl-Token": "testhook",
        },
        body: makeWebhookBody("src_fc", [
          { checkId: "c7", url: "https://acme.example.com/changelog", status: "new" },
        ]),
      }),
    );
    expect(res.status).toBe(200);
    expect(spawns).toHaveLength(0);
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
