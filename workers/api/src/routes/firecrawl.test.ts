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
  // getMonitor isn't exercised by the sync route; stub satisfies the type only.
  getMonitor: (async () => ({ id: "mon_seeded" })) as unknown as FirecrawlClient["getMonitor"],
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
    diff?: { text?: string; json?: unknown };
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

  it("10. passes the diff's added content as the `delta` workflow param on a changed event", async () => {
    const diffText = [
      "--- previous",
      "+++ current",
      "@@ -1,1 +1,4 @@",
      " # Release Notes",
      "+## March 1, 2026",
      "+- Shipped feature Z",
    ].join("\n");

    const res = await webhookFetchApi(
      new Request("http://test/v1/integrations/firecrawl/webhook", {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-Firecrawl-Token": "testhook" },
        body: makeWebhookBody("src_fc", [
          {
            checkId: "c10",
            url: "https://acme.example.com/changelog",
            status: "changed",
            judgment: { meaningful: true, confidence: "high" },
            diff: { text: diffText },
          },
        ]),
      }),
    );

    expect(res.status).toBe(200);
    expect(spawns).toHaveLength(1);
    // Only the added lines reach the workflow — the page is never re-scraped.
    expect(spawns[0].params.delta).toBe("## March 1, 2026\n- Shipped feature Z");
  });

  it("10b. passes a delta for Firecrawl's live hunkless diff (no @@ headers)", async () => {
    // The live monitor.page webhook sends a whole-document diff with no @@ hunk
    // headers and no ---/+++ file headers (every line prefixed space/+/-). The
    // receiver must still extract the added lines rather than fall back to a
    // full-page re-scrape. Shape mirrors the real OpenAI release-notes payload.
    const diffText = [
      " # ChatGPT — Release Notes",
      "-Updated: 7 hours ago",
      "+Updated: 5 hours ago",
      "+# May 29, 2026",
      "+## Codex updates: Computer use on Windows",
      " # May 28, 2026",
    ].join("\n");

    const res = await webhookFetchApi(
      new Request("http://test/v1/integrations/firecrawl/webhook", {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-Firecrawl-Token": "testhook" },
        body: makeWebhookBody("src_fc", [
          {
            checkId: "c10b",
            url: "https://acme.example.com/changelog",
            status: "changed",
            judgment: { meaningful: true, confidence: "high" },
            diff: { text: diffText },
          },
        ]),
      }),
    );

    expect(res.status).toBe(200);
    expect(spawns).toHaveLength(1);
    expect(spawns[0].params.delta).toBe(
      ["Updated: 5 hours ago", "# May 29, 2026", "## Codex updates: Computer use on Windows"].join(
        "\n",
      ),
    );
  });

  it("11. omits `delta` on a new event so the workflow scrapes the baseline page", async () => {
    const res = await webhookFetchApi(
      new Request("http://test/v1/integrations/firecrawl/webhook", {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-Firecrawl-Token": "testhook" },
        body: makeWebhookBody("src_fc", [
          { checkId: "c11", url: "https://acme.example.com/changelog", status: "new" },
        ]),
      }),
    );

    expect(res.status).toBe(200);
    expect(spawns).toHaveLength(1);
    expect(spawns[0].params.delta).toBeUndefined();
  });

  it("12. omits `delta` when a changed event's diff adds nothing (falls back to re-scrape)", async () => {
    const removalOnly = ["--- previous", "+++ current", "@@ -1,2 +1,1 @@", " keep", "-gone"].join(
      "\n",
    );

    const res = await webhookFetchApi(
      new Request("http://test/v1/integrations/firecrawl/webhook", {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-Firecrawl-Token": "testhook" },
        body: makeWebhookBody("src_fc", [
          {
            checkId: "c12",
            url: "https://acme.example.com/changelog",
            status: "changed",
            judgment: { meaningful: true, confidence: "high" },
            diff: { text: removalOnly },
          },
        ]),
      }),
    );

    expect(res.status).toBe(200);
    expect(spawns).toHaveLength(1);
    expect(spawns[0].params.delta).toBeUndefined();
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

  // ── Spawn-failure handling (#1287) ───────────────────────────────────────
  // The KV idempotency key must be written ONLY after a durable spawn, and the
  // catch must distinguish a benign duplicate-instance error (the work is
  // already durable) from a genuine transient create() failure (must stay
  // retryable). create() exposes no stable error code, so the handler probes
  // FIRECRAWL_INGEST_WORKFLOW.get(): it resolves iff the instance exists.

  it("13. transient spawn failure leaves the KV key clean and returns 503", async () => {
    const app = new Hono();
    app.route("/v1", firecrawlRoutes);
    const failingFetchApi = (req: Request) =>
      app.fetch(
        req,
        makeEnv({
          FIRECRAWL_INGEST_WORKFLOW: {
            // create() throws (CF Workflows API blip) and the instance never
            // came into existence, so get() also throws.
            create: async () => {
              throw new Error("workflows API unavailable");
            },
            get: async () => {
              throw new Error("instance.not_found");
            },
          },
        }) as never,
      );

    const res = await failingFetchApi(
      new Request("http://test/v1/integrations/firecrawl/webhook", {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-Firecrawl-Token": "testhook" },
        body: makeWebhookBody("src_fc", [
          { checkId: "c13", url: "https://acme.example.com/changelog", status: "new" },
        ]),
      }),
    );

    // Non-2xx so Firecrawl redelivers (it retries on non-2xx).
    expect(res.status).toBe(503);
    // The dedup gate must NOT be poisoned — a retry can re-process the event.
    expect(cacheStore["firecrawl:webhook:c13:https://acme.example.com/changelog"]).toBeUndefined();
  });

  it("14. duplicate-instance error is benign: seals the KV key and returns 200", async () => {
    const app = new Hono();
    app.route("/v1", firecrawlRoutes);
    const duplicateFetchApi = (req: Request) =>
      app.fetch(
        req,
        makeEnv({
          FIRECRAWL_INGEST_WORKFLOW: {
            // create() throws because the deterministic id already exists, but
            // get() resolves — the instance is real and the work is durable.
            create: async () => {
              throw new Error("instance with id fc-c14 already exists");
            },
            get: async () => ({ id: "fc-c14" }),
          },
        }) as never,
      );

    const res = await duplicateFetchApi(
      new Request("http://test/v1/integrations/firecrawl/webhook", {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-Firecrawl-Token": "testhook" },
        body: makeWebhookBody("src_fc", [
          { checkId: "c14", url: "https://acme.example.com/changelog", status: "new" },
        ]),
      }),
    );

    expect(res.status).toBe(200);
    // The work exists, so the KV gate is sealed to short-circuit future redeliveries.
    expect(cacheStore["firecrawl:webhook:c14:https://acme.example.com/changelog"]).toBe("1");
  });

  it("15. KV key is written only after a successful spawn", async () => {
    const res = await webhookFetchApi(
      new Request("http://test/v1/integrations/firecrawl/webhook", {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-Firecrawl-Token": "testhook" },
        body: makeWebhookBody("src_fc", [
          { checkId: "c15", url: "https://acme.example.com/changelog", status: "new" },
        ]),
      }),
    );

    expect(res.status).toBe(200);
    expect(spawns).toHaveLength(1);
    expect(cacheStore["firecrawl:webhook:c15:https://acme.example.com/changelog"]).toBe("1");
  });

  it("16. crawl monitor: two pages in one check (shared checkId, distinct urls) spawn distinct workflow instances", async () => {
    // A crawl check can report several changed pages in one webhook, all sharing
    // the check id. The workflow instance id must be unique per (checkId, url) —
    // the same granularity as the KV gate — or the real CF Workflows binding
    // rejects the second page's create() as a duplicate of the first and the
    // page is silently dropped (#1302).
    const url1 = "https://acme.example.com/changelog/2026/05/15/a";
    const url2 = "https://acme.example.com/changelog/2026/05/16/b";
    const res = await webhookFetchApi(
      new Request("http://test/v1/integrations/firecrawl/webhook", {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-Firecrawl-Token": "testhook" },
        body: makeWebhookBody("src_fc", [
          { checkId: "cc", url: url1, status: "new" },
          { checkId: "cc", url: url2, status: "new" },
        ]),
      }),
    );

    expect(res.status).toBe(200);
    expect(spawns).toHaveLength(2);
    // Distinct instance ids → a real binding spawns both, not one.
    expect(spawns[0].id).not.toBe(spawns[1].id);
    const urls = spawns.map((s) => s.params.url);
    expect(urls).toContain(url1);
    expect(urls).toContain(url2);
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

  it("onboards a crawl-target monitor when body.target is 'crawl'", async () => {
    // The unlock: an operator enables a multi-page changelog as a crawl monitor
    // in one call. body.target is merged into metadata.firecrawl.target, and the
    // created monitor spec carries a crawl target rather than a scrape target.
    const res = await fetchApi(
      new Request("http://test/v1/sources/src_1/firecrawl/sync", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ enabled: true, target: "crawl" }),
      }),
    );

    expect(res.status).toBe(200);
    expect(capturedSpec?.targets[0].type).toBe("crawl");
    const json = (await res.json()) as { firecrawl: { target?: string } };
    expect(json.firecrawl.target).toBe("crawl");
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
    expect(capturedSpec?.webhook?.url).toBe(
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
