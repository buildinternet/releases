import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test";
import { Hono } from "hono";
import { eq, sql } from "drizzle-orm";
import { organizations, sources } from "@buildinternet/releases-core/schema";
import { DEFAULT_SOURCE_DATASETS } from "@releases/core-internal/source-dataset";
import { createTestDb, type TestDatabase } from "../../../tests/db-helper.js";
import { adminDatasetsRoutes } from "../src/routes/admin-datasets.js";
import { sourceRoutes } from "../src/routes/sources.js";
import { sitemapRoutes } from "../src/routes/sitemap.js";

let h: TestDatabase;
const pilot = DEFAULT_SOURCE_DATASETS[0];
const BASE = "https://api.example.com";
const headers = { Authorization: "Bearer root-secret", "Content-Type": "application/json" };
let pending: Promise<unknown>[] = [];
const ctx = {
  props: {},
  waitUntil: (promise: Promise<unknown>) => {
    pending.push(promise);
  },
  passThroughOnException() {},
};
function request(
  path: string,
  body?: unknown,
  auth = true,
  extraEnv: Record<string, unknown> = {},
) {
  const app = new Hono();
  app.route("/", adminDatasetsRoutes);
  app.route("/", sourceRoutes);
  app.route("/", sitemapRoutes);
  return app.request(
    `${BASE}${path}`,
    {
      method: body === undefined ? "GET" : "PATCH",
      headers: auth ? headers : { "Content-Type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    },
    { DB: h.db, RELEASES_API_KEY: { get: async () => "root-secret" }, ...extraEnv },
    ctx,
  );
}
async function state(q = "") {
  return (await (await request(`/admin/datasets?q=${q}`)).json()) as any;
}
beforeEach(async () => {
  h = createTestDb();
  pending = [];
  await h.db.insert(organizations).values({ id: "org_1", name: "Anthropic", slug: pilot.orgSlug });
  await h.db.insert(sources).values({
    id: pilot.id,
    orgId: "org_1",
    name: "Code",
    slug: pilot.slug,
    type: "github",
    url: "https://example.com",
    metadata: JSON.stringify({ fetchEtag: "keep", nested: { x: 1 } }),
  });
  await h.db.insert(sources).values({
    id: "src_other",
    orgId: "org_1",
    name: "Other",
    slug: "other",
    type: "feed",
    url: "https://example.com/other",
  });
});
afterEach(() => h.cleanup?.());

describe("dataset operator controls", () => {
  it("requires admin and returns bounded searchable rows with default and index eligibility", async () => {
    expect((await request("/admin/datasets", undefined, false)).status).toBe(403);
    const body = await state("Code");
    expect(body.sources).toHaveLength(1);
    expect(body.sources[0]).toMatchObject({
      id: pilot.id,
      defaultEnabled: true,
      settings: null,
      effective: { name: pilot.name },
    });
    expect(body.sources[0].blockedReasons.join(" ")).toContain("overview");
    const page = (await (await request("/admin/datasets?limit=1")).json()) as any;
    expect(page.pagination).toEqual({ page: 1, limit: 1, hasMore: true });
  });
  it("disables, resets and customizes datasets while preserving fetch metadata and projecting sitemap", async () => {
    const path = `/sources/${pilot.id}/metadata`;
    expect((await request(path, { dataset: { enabled: false } })).status).toBe(200);
    expect((await state("Code")).sources[0].effective).toBeNull();
    const sitemapResponse = await request("/sitemap");
    expect(sitemapResponse.headers.get("cache-control")).toBe("private, no-store");
    let sitemap = (await sitemapResponse.json()) as any;
    expect(sitemap.sources.find((s: any) => s.id === pilot.id).dataset).toBeNull();
    expect((await request(path, { dataset: null })).status).toBe(200);
    expect((await state("Code")).sources[0].effective.name).toBe(pilot.name);
    const dataset = {
      enabled: true,
      name: "Custom dataset",
      description:
        "Custom release history with structured dates, versions and links to the original public updates.",
    };
    expect((await request("/sources/src_other/metadata", { dataset })).status).toBe(200);
    sitemap = (await (await request("/sitemap")).json()) as any;
    expect(sitemap.sources.find((s: any) => s.id === "src_other").dataset).toEqual({
      name: dataset.name,
      description: dataset.description,
    });
    const row = await h.db.select().from(sources).where(eq(sources.id, pilot.id)).get();
    expect(JSON.parse(row!.metadata!)).toEqual({ fetchEtag: "keep", nested: { x: 1 } });
    // Stable pilot ID survives renaming; the current coordinate is not the default key.
    expect((await request(`/sources/${pilot.id}`, { slug: "renamed-code" })).status).toBe(200);
    expect((await state("Code")).sources[0].effective.name).toBe(pilot.name);
  });
  it("rejects reserved metadata writes without admin and validates both metadata write paths", async () => {
    const path = `/sources/${pilot.id}/metadata`;
    expect((await request(path, { dataset: { enabled: true } }, false)).status).toBe(403);
    for (const dataset of [
      { enabled: "yes" },
      { description: "too short" },
      { name: "" },
      { surprise: true },
      [],
    ]) {
      expect((await request(path, { dataset })).status).toBe(400);
      expect(
        (await request(`/sources/${pilot.id}`, { metadata: JSON.stringify({ dataset }) })).status,
      ).toBe(400);
    }
    await request(path, { dataset: { enabled: false } });
    expect((await request(`/sources/${pilot.id}`, { metadata: "{}" }, false)).status).toBe(403);
    expect((await state("Code")).sources[0].settings).toEqual({ enabled: false });
  });
  it("preserves metadata written after the handler read and revalidates public pages with the service credential", async () => {
    const handle = h.db as any;
    const originalBatch = handle.batch.bind(handle);
    const batch = spyOn(handle, "batch").mockImplementation(async (ops: unknown[]) => {
      // Models the fetch worker committing its headers between the operator read and write.
      await h.db
        .update(sources)
        .set({
          metadata: sql`json_set(metadata, '$.fetchEtag', 'new-header', '$.fetchLastModified', 'new-date')`,
        })
        .where(eq(sources.id, pilot.id));
      return originalBatch(ops);
    });
    const ping = spyOn(globalThis, "fetch").mockResolvedValue(new Response("ok"));
    try {
      const response = await request(
        `/sources/${pilot.id}/metadata`,
        { dataset: { enabled: false } },
        true,
        {
          WEB_SERVICE_KEY: { get: async () => "web-service-secret" },
          WEB_BASE_URL: "https://web.example.com",
        },
      );
      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({
        metadata: {
          fetchEtag: "new-header",
          fetchLastModified: "new-date",
          dataset: { enabled: false },
          nested: { x: 1 },
        },
      });
      await Promise.all(pending);
      expect(ping).toHaveBeenCalledTimes(1);
      const [url, init] = ping.mock.calls[0]!;
      expect(url).toBe("https://web.example.com/api/revalidate");
      expect(init?.headers).toMatchObject({ Authorization: "Bearer web-service-secret" });
      expect(JSON.parse(init?.body as string).paths).toEqual([
        "/sitemap-orgs.xml",
        `/${pilot.orgSlug}/${pilot.slug}`,
        `/${pilot.orgSlug}/${pilot.slug}/highlights`,
        `/${pilot.orgSlug}/${pilot.slug}/changelog`,
      ]);
    } finally {
      batch.mockRestore();
      ping.mockRestore();
    }
  });
  it("rejects malformed raw metadata and preserves a concurrent operator override during nonadmin replacement", async () => {
    for (const metadata of ["[]", "broken", "null", "42"]) {
      expect((await request(`/sources/${pilot.id}`, { metadata }, false)).status).toBe(400);
    }
    const handle = h.db as any;
    const originalUpdate = handle.update.bind(handle);
    let interleaved = false;
    const update = spyOn(handle, "update").mockImplementation((table: unknown) => {
      if (table === sources && !interleaved) {
        interleaved = true;
        // Real synchronous DB write after the handler read/authorization, before its UPDATE.
        originalUpdate(sources)
          .set({ metadata: JSON.stringify({ dataset: { enabled: false }, fetchEtag: "new" }) })
          .where(eq(sources.id, pilot.id))
          .run();
      }
      return originalUpdate(table);
    });
    try {
      expect(
        (
          await request(
            `/sources/${pilot.id}`,
            { metadata: JSON.stringify({ fetchEtag: "replacement" }) },
            false,
          )
        ).status,
      ).toBe(200);
      const row = await h.db.select().from(sources).where(eq(sources.id, pilot.id)).get();
      expect(JSON.parse(row!.metadata!)).toEqual({
        fetchEtag: "replacement",
        dataset: { enabled: false },
      });
    } finally {
      update.mockRestore();
    }
    expect((await state("Code")).sources[0].effective).toBeNull();
  });
  it("shallow-merges large metadata patches and recovers malformed stored metadata", async () => {
    const patch = Object.fromEntries(Array.from({ length: 60 }, (_, i) => [`key${i}`, i]));
    let response = await request(`/sources/${pilot.id}/metadata`, {
      ...patch,
      nested: { replaced: true },
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      metadata: { ...patch, nested: { replaced: true }, fetchEtag: "keep" },
    });
    await h.db.update(sources).set({ metadata: "invalid-json" }).where(eq(sources.id, pilot.id));
    expect((await request(`/sources/${pilot.id}`, { metadata: "{}" }, false)).status).toBe(403);
    expect(
      (await request(`/sources/${pilot.id}/metadata`, { recovered: true }, false)).status,
    ).toBe(403);
    response = await request(`/sources/${pilot.id}/metadata`, { recovered: true });
    expect(response.status).toBe(200);
    const recovered = (await response.json()) as { metadata: { recovered: boolean } };
    expect(recovered).toEqual({ metadata: { recovered: true } });
  });
  it("keeps hidden and on-demand sources out of public datasets and explains their status", async () => {
    await h.db.update(sources).set({ isHidden: true }).where(eq(sources.id, pilot.id));
    await h.db
      .update(sources)
      .set({ discovery: "on_demand", metadata: JSON.stringify({ dataset: { enabled: true } }) })
      .where(eq(sources.id, "src_other"));
    const body = await state();
    expect(body.sources.every((s: any) => s.effective === null)).toBe(true);
    expect(body.sources.find((s: any) => s.id === pilot.id).blockedReasons).toContain(
      "Source is hidden",
    );
    const sitemap = (await (await request("/sitemap")).json()) as any;
    expect(sitemap.sources).toEqual([]);
  });
});
