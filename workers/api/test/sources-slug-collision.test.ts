/**
 * POST /v1/sources — slug collision auto-suffix
 *
 * Verifies that when two sources with names that slugify to the same base slug
 * are created, the second one gets `<base>-2` and both return 201 with
 * distinct resolved slugs.
 */
import { describe, it, expect } from "bun:test";
import { Database } from "bun:sqlite";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { applyMigrations } from "../../../tests/db-helper";
import { organizations } from "@buildinternet/releases-core/schema";
import { Hono } from "hono";
import { sourceRoutes } from "../src/routes/sources.js";

// Embed + playbook-regen side effects in POST /sources are fire-and-forget via
// c.executionCtx.waitUntil. The no-op waitUntil stub below never runs them, so
// no module-level mocks are needed here. (Earlier version used mock.module,
// which leaks globally across bun:test files and poisoned embed-entities.test.ts.)

// Minimal DO stubs required by route internals (STATUS_HUB for fetch route,
// not used here but the route file references it at module level via getStatusHub).
const statusHubStub = {
  idFromName: () => "stub-id",
  get: () => ({
    fetch: async () => new Response("ok", { status: 200 }),
  }),
};

function mkDb() {
  const sqlite = new Database(":memory:");
  const db = drizzle(sqlite);
  applyMigrations(sqlite);
  return db;
}

function mkApp(db: ReturnType<typeof mkDb>) {
  const fakeEnv = { DB: db, STATUS_HUB: statusHubStub };
  const fakeCtx = {
    waitUntil: () => {},
    passThroughOnException: () => {},
  } as unknown as ExecutionContext;
  const app = new Hono();
  const v1 = new Hono();
  v1.route("/", sourceRoutes);
  app.route("/v1", v1);
  return (req: Request) => app.fetch(req, fakeEnv, fakeCtx);
}

describe("POST /v1/sources — slug auto-suffix on collision", () => {
  it("creates first source with the base slug", async () => {
    const db = mkDb();
    await db.insert(organizations).values({
      id: "org_x",
      slug: "acme-x",
      name: "Acme X",
      category: "cloud",
    });
    const fetch = mkApp(db);

    const res = await fetch(
      new Request("https://x.test/v1/sources", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: "Changelog",
          url: "https://acme-x.test/changelog",
          orgSlug: "acme-x",
        }),
      }),
    );

    expect(res.status).toBe(201);
    const body = (await res.json()) as { slug: string };
    expect(body.slug).toBe("changelog");
  });

  it("auto-suffixes to base-2 when base slug is taken, both return 201 with distinct slugs", async () => {
    const db = mkDb();
    await db.insert(organizations).values([
      { id: "org_a", slug: "org-a", name: "Org A", category: "cloud" },
      { id: "org_b", slug: "org-b", name: "Org B", category: "cloud" },
    ]);
    const fetch = mkApp(db);

    // First source — takes "changelog"
    const res1 = await fetch(
      new Request("https://x.test/v1/sources", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: "Changelog",
          url: "https://org-a.test/changelog",
          orgSlug: "org-a",
        }),
      }),
    );
    expect(res1.status).toBe(201);
    const body1 = (await res1.json()) as { slug: string };
    expect(body1.slug).toBe("changelog");

    // Second source with the same name — must get "changelog-2"
    const res2 = await fetch(
      new Request("https://x.test/v1/sources", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: "Changelog",
          url: "https://org-b.test/changelog",
          orgSlug: "org-b",
        }),
      }),
    );
    expect(res2.status).toBe(201);
    const body2 = (await res2.json()) as { slug: string };
    expect(body2.slug).toBe("changelog-2");

    // Both slugs are distinct
    expect(body1.slug).not.toBe(body2.slug);
  });

  it("continues suffixing when multiple prior entries occupy the base and -2", async () => {
    const db = mkDb();
    await db.insert(organizations).values([
      { id: "org_c1", slug: "org-c1", name: "Org C1", category: "cloud" },
      { id: "org_c2", slug: "org-c2", name: "Org C2", category: "cloud" },
      { id: "org_c3", slug: "org-c3", name: "Org C3", category: "cloud" },
    ]);
    const fetch = mkApp(db);

    for (const [orgSlug, url] of [
      ["org-c1", "https://c1.test/changelog"],
      ["org-c2", "https://c2.test/changelog"],
    ] as const) {
      // oxlint-disable-next-line no-await-in-loop -- sequential: each insert must land before next to drive slug collision
      const r = await fetch(
        new Request("https://x.test/v1/sources", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ name: "Changelog", url, orgSlug }),
        }),
      );
      expect(r.status).toBe(201);
    }

    // Third one should get "changelog-3"
    const res3 = await fetch(
      new Request("https://x.test/v1/sources", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: "Changelog",
          url: "https://c3.test/changelog",
          orgSlug: "org-c3",
        }),
      }),
    );
    expect(res3.status).toBe(201);
    const body3 = (await res3.json()) as { slug: string };
    expect(body3.slug).toBe("changelog-3");
  });
});
