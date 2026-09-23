import { describe, it, expect } from "bun:test";
import { organizations, sources } from "@buildinternet/releases-core/schema";
import { sourceRoutes } from "../src/routes/sources.js";
import { createTestDb, createTestApp } from "./setup";

const statusHubStub = {
  idFromName: () => "stub-id",
  get: () => ({
    fetch: async () => new Response("ok", { status: 200 }),
  }),
};

describe("GET /v1/orgs/:orgSlug/sources/:sourceSlug — stars", () => {
  it("returns the stored stargazer count for a github source", async () => {
    const db = createTestDb();
    await db.insert(organizations).values({ id: "org_a", slug: "acme", name: "Acme" });
    await db.insert(sources).values({
      id: "src_g",
      slug: "widget",
      name: "widget",
      type: "github",
      url: "https://github.com/acme/widget",
      orgId: "org_a",
      stargazersCount: 4321,
      starsFetchedAt: "2026-06-02T00:00:00.000Z",
    });

    const app = createTestApp(db, [sourceRoutes], { env: { STATUS_HUB: statusHubStub } });
    const res = await app(new Request("https://x.test/v1/orgs/acme/sources/widget"));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { stars?: number; starsFetchedAt?: string };
    expect(body.stars).toBe(4321);
    expect(body.starsFetchedAt).toBe("2026-06-02T00:00:00.000Z");
  });
});
