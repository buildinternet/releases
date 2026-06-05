import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { eq } from "drizzle-orm";
import { organizations } from "@buildinternet/releases-core/schema";
import { createTestDb, createTestApp, type TestDb } from "./setup.js";
import { orgRoutes } from "../src/routes/orgs.js";

function fakeR2() {
  const store = new Map<string, unknown>();
  return {
    store,
    put: async (k: string, v: unknown) => void store.set(k, v),
    get: async () => null,
  } as any;
}

type SyncResult = {
  fetched: boolean;
  applied: boolean;
  skippedReason?: string;
  plan?: unknown;
};

describe("POST /v1/orgs/:slug/sync-well-known", () => {
  let db: TestDb;
  const realFetch = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  beforeEach(async () => {
    db = createTestDb();
    await db
      .insert(organizations)
      .values({ id: "org_a", slug: "acme", name: "Acme", domain: "acme.com" });
  });

  function app() {
    return createTestApp(db, orgRoutes, {
      env: { MEDIA: fakeR2(), MEDIA_ORIGIN: "https://media.test" },
    });
  }

  it("applies the owner file and returns the result", async () => {
    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ description: "CI for teams." }), {
        status: 200,
        headers: { "content-type": "application/json" },
      })) as unknown as typeof fetch;

    const res = await app()(
      new Request("http://x/v1/orgs/acme/sync-well-known", { method: "POST" }),
    );
    expect(res.status).toBe(200);
    const json = (await res.json()) as SyncResult;
    expect(json.applied).toBe(true);
    const [o] = await db.select().from(organizations).where(eq(organizations.id, "org_a"));
    expect(o!.description).toBe("CI for teams.");
  });

  it("dryRun=1 returns the plan and writes nothing", async () => {
    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ description: "preview" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      })) as unknown as typeof fetch;

    const res = await app()(
      new Request("http://x/v1/orgs/acme/sync-well-known?dryRun=1", { method: "POST" }),
    );
    expect(res.status).toBe(200);
    const json = (await res.json()) as SyncResult;
    expect(json.applied).toBe(false);
    const [o] = await db.select().from(organizations).where(eq(organizations.id, "org_a"));
    expect(o!.description ?? null).toBeNull();
  });

  it("returns a 200 skip result when the org has no domain", async () => {
    await db.insert(organizations).values({ id: "org_nd", slug: "nodom", name: "NoDom" });
    const res = await app()(
      new Request("http://x/v1/orgs/nodom/sync-well-known", { method: "POST" }),
    );
    expect(res.status).toBe(200);
    const json = (await res.json()) as SyncResult;
    expect(json.applied).toBe(false);
    expect(json.skippedReason).toBe("no_domain");
  });

  it("404 for an unknown org", async () => {
    const res = await app()(
      new Request("http://x/v1/orgs/nope/sync-well-known", { method: "POST" }),
    );
    expect(res.status).toBe(404);
  });
});
