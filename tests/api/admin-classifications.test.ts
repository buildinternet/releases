import { describe, expect, it } from "bun:test";
import { Database } from "bun:sqlite";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { Hono } from "hono";
import { organizations, releases, sources } from "@buildinternet/releases-core/schema";
import { applyMigrations } from "../db-helper";
import { adminClassificationsRoutes } from "../../workers/api/src/routes/admin-classifications";

const AFTER = "2026-09-14T00:00:00.000Z";
const BEFORE = "2026-09-21T00:00:00.000Z";
const TOKEN = "super-secret-token";

function mkDb() {
  const sqlite = new Database(":memory:");
  applyMigrations(sqlite);
  return drizzle(sqlite);
}

function creds(extra: Record<string, unknown> = {}) {
  return {
    CLOUDFLARE_API_TOKEN: { get: async () => TOKEN },
    CLOUDFLARE_ACCOUNT_ID: { get: async () => "acct_123" },
    ENVIRONMENT: "production",
    ...extra,
  };
}

function mkApp(db: ReturnType<typeof mkDb>, env: Record<string, unknown>, fetchImpl: typeof fetch) {
  const app = new Hono();
  app.use("*", async (c, next) => {
    (c as any).set("db", db);
    (c as any).set("aeFetch", fetchImpl);
    await next();
  });
  app.route("/", adminClassificationsRoutes);
  return (path: string) => app.request(path, undefined, env);
}

function jsonResponse(data: unknown, status = 200): Response {
  return new Response(
    JSON.stringify({ meta: [], data, rows: Array.isArray(data) ? data.length : 0 }),
    {
      status,
      headers: { "content-type": "application/json" },
    },
  );
}

function summaryFetch(calls: Array<{ url: string; sql: string; authorization: string | null }>) {
  const fetchImpl: typeof fetch = async (input, init) => {
    const sql = String(init?.body ?? "");
    const headers = new Headers(init?.headers);
    calls.push({
      url: String(input),
      sql,
      authorization: headers.get("authorization"),
    });
    if (sql.includes("AS selected_0")) {
      return jsonResponse([
        {
          selected_8: 4,
          selected_9: 1,
          selected_missing: 2,
          confidence_9: 6,
          confidence_missing: 1,
        },
      ]);
    }
    if (sql.includes("blob9 AS choice") && sql.includes("toStartOfInterval")) {
      return jsonResponse([
        { t: "2026-09-20 00:00:00", choice: "case_study", samples: 1 },
        { t: "2026-09-20 00:00:00", choice: "", samples: 5 },
      ]);
    }
    if (sql.includes("blob9 AS choice")) {
      return jsonResponse([
        { choice: "case_study", samples: 3 },
        { choice: "", samples: 9 },
      ]);
    }
    if (sql.includes("blob7 AS provider")) {
      return jsonResponse([
        { provider: "openrouter", model: "typesafe/jev-1.13", samples: 5, cost_usd: 0.02 },
      ]);
    }
    if (sql.includes("toStartOfInterval")) {
      return jsonResponse([
        { t: "2026-09-20 00:00:00", disposition: "kept", samples: 4 },
        { t: "2026-09-20 00:00:00", disposition: "suppressed", samples: 1 },
      ]);
    }
    return jsonResponse([
      { disposition: "kept", samples: 4, cost_usd: 0.25 },
      { disposition: "suppressed", samples: 1, cost_usd: 0.25 },
      { disposition: "failed", samples: 2, cost_usd: 0 },
      { disposition: "skipped", samples: 3, cost_usd: 0 },
    ]);
  };
  return fetchImpl;
}

describe("GET /admin/classifications/summary", () => {
  const path = `/admin/classifications/summary?after=${encodeURIComponent(AFTER)}&before=${encodeURIComponent(BEFORE)}`;

  it("returns 503 when Analytics Engine credentials are missing", async () => {
    let called = false;
    const request = mkApp(mkDb(), {}, async () => {
      called = true;
      return jsonResponse([]);
    });
    const res = await request(path);
    expect(res.status).toBe(503);
    const body = (await res.json()) as { error: { code: string; type: string } };
    expect(body.error.code).toBe("deliveries_unavailable");
    expect(body.error.type).toBe("unavailable");
    expect(called).toBe(false);
  });

  it("returns 502 when Analytics Engine responds 500 and does not cache it", async () => {
    const kv = memoryKv();
    let calls = 0;
    const request = mkApp(mkDb(), creds({ LATEST_CACHE: kv }), async () => {
      calls += 1;
      return new Response("nope", { status: 500 });
    });
    const first = await request(path);
    expect(first.status).toBe(502);
    const body = (await first.json()) as { error: { code: string; type: string } };
    expect(body.error.code).toBe("ae_query_failed");
    expect(body.error.type).toBe("upstream");
    const second = await request(path);
    expect(second.status).toBe(502);
    expect(calls).toBeGreaterThan(1);
    expect(kv.store.size).toBe(0);
  });

  it("shapes a summary from Analytics Engine data rows", async () => {
    const calls: Array<{ url: string; sql: string; authorization: string | null }> = [];
    const request = mkApp(mkDb(), creds(), summaryFetch(calls));
    const res = await request(path);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      after: string;
      before: string;
      bucket: string;
      origin: string;
      totals: {
        classified: number;
        kept: number;
        suppressed: number;
        failed: number;
        skipped: number;
        costUsd: number;
        suppressionRate: number | null;
      };
      series: Array<{ t: string; kept: number; suppressed: number }>;
      choices: Array<{ choice: string; count: number }>;
      choiceSeries: Array<{ t: string; choices: Record<string, number> }>;
      models: Array<{ provider: string; model: string; count: number; costUsd: number }>;
      probability: {
        threshold: number;
        selected: { bins: Array<{ start: number; count: number }>; missing: number };
        confidence: { bins: Array<{ count: number }>; missing: number };
      };
      meta: { dataset: string; retentionDays: number; sampled: boolean };
    };
    expect(body.after).toBe(AFTER);
    expect(body.before).toBe(BEFORE);
    expect(body.bucket).toBe("day");
    expect(body.origin).toBe("ingest");
    expect(body.totals).toEqual({
      classified: 10,
      kept: 4,
      suppressed: 1,
      failed: 2,
      skipped: 3,
      costUsd: 0.5,
      suppressionRate: 0.2,
    });
    expect(body.series[0]).toMatchObject({
      t: "2026-09-20T00:00:00.000Z",
      kept: 4,
      suppressed: 1,
      failed: 0,
      skipped: 0,
    });
    expect(body.choices).toEqual([{ choice: "case_study", count: 3 }]);
    expect(body.choiceSeries).toEqual([
      { t: "2026-09-20T00:00:00.000Z", choices: { case_study: 1 } },
    ]);
    expect(body.models).toEqual([
      { provider: "openrouter", model: "typesafe/jev-1.13", count: 5, costUsd: 0.02 },
    ]);
    expect(body.probability.threshold).toBe(0.8);
    expect(body.probability.selected.bins).toHaveLength(10);
    expect(body.probability.selected.bins[8]).toMatchObject({ start: 0.8, count: 4 });
    expect(body.probability.selected.missing).toBe(2);
    expect(body.probability.confidence.missing).toBe(1);
    expect(body.probability.confidence.bins[8]?.count).toBe(0);
    expect(body.meta).toEqual({
      dataset: "release_classifications",
      retentionDays: 90,
      sampled: true,
    });

    expect(calls).toHaveLength(6);
    const sql = calls.map((call) => call.sql).join("\n");
    expect(sql).toContain("SUM(_sample_interval)");
    expect(sql).toContain("SUM(if(double4 >= 0, _sample_interval * double4, 0))");
    expect(sql).toContain("blob3 = 'ingest'");
    expect(sql).toContain("blob1 = '1'");
    expect(sql).toContain("blob4 = 'marketing'");
    expect(sql).toContain("toDateTime('2026-09-14 00:00:00')");
    expect(sql).toContain("toDateTime('2026-09-21 00:00:00')");
    expect(sql).toContain("INTERVAL '1' DAY");
    expect(sql).toContain("FROM release_classifications ");
    expect(sql).not.toContain(TOKEN);
    expect(calls.every((call) => call.authorization === `Bearer ${TOKEN}`)).toBe(true);
    expect(
      calls.every((call) => call.url.includes("/accounts/acct_123/analytics_engine/sql")),
    ).toBe(true);
  });

  it("serves a second summary from KV without querying again", async () => {
    const calls: Array<{ url: string; sql: string; authorization: string | null }> = [];
    const kv = memoryKv();
    const request = mkApp(mkDb(), creds({ LATEST_CACHE: kv }), summaryFetch(calls));
    const first = await request(path);
    expect(first.status).toBe(200);
    const second = await request(path);
    expect(second.status).toBe(200);
    expect(calls).toHaveLength(6);
    expect(kv.ttl).toBe(60);
    const again = (await second.json()) as { totals: { classified: number } };
    expect(again.totals.classified).toBe(10);
  });

  it("rejects an injected origin before querying", async () => {
    let called = false;
    const request = mkApp(mkDb(), creds(), async () => {
      called = true;
      return jsonResponse([]);
    });
    const res = await request(
      `/admin/classifications/summary?origin=${encodeURIComponent("ingest' OR 1=1")}`,
    );
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("bad_request");
    expect(called).toBe(false);
  });
});

describe("GET /admin/classifications/recent", () => {
  it("hydrates a release title and leaves a dangling release id null", async () => {
    const db = mkDb();
    await db.insert(organizations).values({ id: "org_acme", name: "Acme", slug: "acme" });
    await db.insert(sources).values({
      id: "src_acme",
      name: "Acme Changelog",
      slug: "acme-cl",
      type: "feed",
      url: "https://leak.example/feed",
      orgId: "org_acme",
    });
    await db.insert(releases).values([
      {
        id: "rel_shipped",
        sourceId: "src_acme",
        title: "Widgets 2.0",
        content: "DO_NOT_LEAK_BODY",
        url: "https://leak.example/post",
      },
      {
        id: "rel_hidden",
        sourceId: "src_acme",
        title: "Hidden launch",
        content: "DO_NOT_LEAK_BODY",
        url: "https://leak.example/hidden",
        suppressed: true,
      },
    ]);

    const calls: string[] = [];
    const request = mkApp(db, creds(), async (_input, init) => {
      const sql = String(init?.body ?? "");
      calls.push(sql);
      return jsonResponse([
        {
          timestamp: "2026-09-21 11:00:00",
          origin: "ingest",
          release_id: "rel_shipped",
          source_id: "src_acme",
          provider: "openrouter",
          model: "typesafe/jev-1.13",
          choice: "real_product_news",
          selected_probability: 1,
          provider_confidence: 0.4,
          disposition: "kept",
          reason: "",
          failure_category: "",
          cost_usd: 0.001,
          duration_ms: 20,
        },
        {
          timestamp: "2026-09-21 10:30:00",
          origin: "ingest",
          release_id: "rel_hidden",
          source_id: "src_acme",
          provider: "openrouter",
          model: "typesafe/jev-1.13",
          choice: "case_study",
          selected_probability: 0.99,
          provider_confidence: 0.5,
          disposition: "suppressed",
          reason: "case_study",
          failure_category: "",
          cost_usd: 0.001,
          duration_ms: 18,
        },
        {
          timestamp: "2026-09-21 10:00:00",
          origin: "ingest",
          release_id: "rel_missing",
          source_id: "src_acme",
          provider: "openrouter",
          model: "typesafe/jev-1.13",
          choice: "unclear_other",
          selected_probability: -1,
          provider_confidence: -1,
          disposition: "failed",
          reason: "transport",
          failure_category: "upstream",
          cost_usd: -1,
          duration_ms: -1,
        },
      ]);
    });

    const res = await request(
      `/admin/classifications/recent?after=${encodeURIComponent(AFTER)}&before=${encodeURIComponent(BEFORE)}`,
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      items: Array<{
        releaseId: string | null;
        releaseTitle: string | null;
        sourceName: string | null;
        sourceSlug: string | null;
        orgSlug: string | null;
        selectedChoiceProbability: number | null;
        costUsd: number | null;
      }>;
      nextCursor: string | null;
    };
    expect(body.items.map((item) => [item.releaseId, item.releaseTitle])).toEqual([
      ["rel_shipped", "Widgets 2.0"],
      ["rel_hidden", "Hidden launch"],
      ["rel_missing", null],
    ]);
    expect(body.items[0]).toMatchObject({
      sourceName: "Acme Changelog",
      sourceSlug: "acme-cl",
      orgSlug: "acme",
    });
    expect(body.items[2]).toMatchObject({
      sourceName: "Acme Changelog",
      selectedChoiceProbability: null,
      costUsd: null,
    });
    expect(body.nextCursor).toBeNull();
    const encoded = JSON.stringify(body);
    expect(encoded).not.toContain("DO_NOT_LEAK_BODY");
    expect(encoded).not.toContain("leak.example");
    expect(calls[0]).not.toContain("_sample_interval");
    expect(calls[0]).toContain("ORDER BY timestamp DESC LIMIT 51");
  });

  it("rejects a non-numeric limit", async () => {
    let called = false;
    const request = mkApp(mkDb(), creds(), async () => {
      called = true;
      return jsonResponse([]);
    });
    const res = await request("/admin/classifications/recent?limit=1;%20DROP");
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("bad_request");
    expect(called).toBe(false);
  });
});

function memoryKv() {
  const store = new Map<string, string>();
  return {
    store,
    ttl: undefined as number | undefined,
    async get(key: string, type?: string) {
      const value = store.get(key);
      if (value === undefined) return null;
      return type === "json" ? JSON.parse(value) : value;
    },
    async put(key: string, value: string, options?: { expirationTtl?: number }) {
      store.set(key, value);
      this.ttl = options?.expirationTtl;
    },
  };
}
