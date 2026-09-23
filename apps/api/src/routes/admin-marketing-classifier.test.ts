import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { Hono } from "hono";
import { organizations, sources } from "@buildinternet/releases-core/schema";
import { createTestDb, type TestDatabase } from "../../../../tests/db-helper.js";
import { adminMarketingClassifierRoutes } from "./admin-marketing-classifier.js";
import { putStoredMarketingThreshold } from "../queries/site-settings.js";
import { clearMarketingThresholdCache } from "../lib/marketing-classifier-settings.js";

let h: TestDatabase;

function secretBinding(value: string) {
  return { get: async () => value };
}

function app(extra: Record<string, unknown> = {}) {
  const a = new Hono();
  a.route("/", adminMarketingClassifierRoutes);
  const env = {
    DB: h.db,
    RELEASES_API_KEY: secretBinding("root-secret"),
    ...extra,
  };
  return { a, env };
}

const BASE = "https://api.releases.sh";
const auth = { Authorization: "Bearer root-secret" };

beforeEach(() => {
  h = createTestDb();
  clearMarketingThresholdCache();
});

afterEach(() => {
  clearMarketingThresholdCache();
  h.cleanup?.();
});

describe("GET /admin/marketing-classifier", () => {
  it("403s without admin auth", async () => {
    const { a, env } = app();
    const res = await a.request(`${BASE}/admin/marketing-classifier`, {}, env);
    expect(res.status).toBe(403);
  });

  it("returns the default threshold with no stored override", async () => {
    const { a, env } = app();
    const res = await a.request(`${BASE}/admin/marketing-classifier`, { headers: auth }, env);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      threshold: number;
      defaultThreshold: number;
      updatedAt: string | null;
      sources: unknown[];
    };
    expect(body.threshold).toBe(0.65);
    expect(body.defaultThreshold).toBe(0.65);
    expect(body.updatedAt).toBeNull();
    expect(body.sources).toEqual([]);
    expect(res.headers.get("cache-control")).toBe("private, no-store");
  });

  it("surfaces a stored override and opted-in sources", async () => {
    await putStoredMarketingThreshold(h.db, 0.72);
    await h.db.insert(organizations).values({ id: "org_1", name: "Acme", slug: "acme" });
    await h.db.insert(sources).values({
      id: "src_1",
      orgId: "org_1",
      name: "Acme Blog",
      slug: "acme-blog",
      type: "scrape",
      url: "https://acme.example.com/blog",
      metadata: JSON.stringify({ marketingFilter: true, marketingFilterHint: "Watch for x" }),
    });
    await h.db.insert(sources).values({
      id: "src_2",
      orgId: "org_1",
      name: "Acme Docs",
      slug: "acme-docs",
      type: "feed",
      url: "https://acme.example.com/docs",
      metadata: JSON.stringify({ marketingFilter: false }),
    });

    const { a, env } = app();
    const res = await a.request(`${BASE}/admin/marketing-classifier`, { headers: auth }, env);
    const body = (await res.json()) as {
      threshold: number;
      sources: Array<{ id: string; slug: string; hint: string | null; orgSlug: string | null }>;
    };
    expect(body.threshold).toBe(0.72);
    expect(body.sources).toHaveLength(1);
    expect(body.sources[0]).toMatchObject({
      id: "src_1",
      slug: "acme-blog",
      hint: "Watch for x",
      orgSlug: "acme",
    });
  });
});

describe("PUT /admin/marketing-classifier", () => {
  it("403s without admin auth", async () => {
    const { a, env } = app();
    const res = await a.request(
      `${BASE}/admin/marketing-classifier`,
      {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ threshold: 0.7 }),
      },
      env,
    );
    expect(res.status).toBe(403);
  });

  it("sets a new threshold", async () => {
    const { a, env } = app();
    const res = await a.request(
      `${BASE}/admin/marketing-classifier`,
      {
        method: "PUT",
        headers: { ...auth, "content-type": "application/json" },
        body: JSON.stringify({ threshold: 0.75 }),
      },
      env,
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { threshold: number };
    expect(body.threshold).toBe(0.75);

    const refetch = await a.request(`${BASE}/admin/marketing-classifier`, { headers: auth }, env);
    expect(((await refetch.json()) as { threshold: number }).threshold).toBe(0.75);
  });

  it("400s on an out-of-range threshold", async () => {
    const { a, env } = app();
    const res = await a.request(
      `${BASE}/admin/marketing-classifier`,
      {
        method: "PUT",
        headers: { ...auth, "content-type": "application/json" },
        body: JSON.stringify({ threshold: 0.3 }),
      },
      env,
    );
    expect(res.status).toBe(400);
  });

  it("400s on a malformed body", async () => {
    const { a, env } = app();
    const res = await a.request(
      `${BASE}/admin/marketing-classifier`,
      {
        method: "PUT",
        headers: { ...auth, "content-type": "application/json" },
        body: JSON.stringify({ threshold: "0.7" }),
      },
      env,
    );
    expect(res.status).toBe(400);
  });
});
