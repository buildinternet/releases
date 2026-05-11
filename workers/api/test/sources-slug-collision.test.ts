/**
 * POST /v1/sources — slug collision auto-suffix
 *
 * Verifies that when two sources with names that slugify to the same base slug
 * are created, the second one gets `<base>-2` and both return 201 with
 * distinct resolved slugs.
 */
import { describe, it, expect } from "bun:test";
import { organizations } from "@buildinternet/releases-core/schema";
import { sourceRoutes } from "../src/routes/sources.js";
import { createTestDb as mkDb, createTestApp } from "./setup";

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

const mkApp = (db: ReturnType<typeof mkDb>) =>
  createTestApp(db, sourceRoutes, { env: { STATUS_HUB: statusHubStub } });

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
          name: "Release Notes",
          url: "https://acme-x.test/changelog",
          orgSlug: "acme-x",
        }),
      }),
    );

    expect(res.status).toBe(201);
    const body = (await res.json()) as { slug: string };
    expect(body.slug).toBe("release-notes");
  });

  it("auto-suffixes to base-2 when base slug is taken within the same org", async () => {
    // Per-org uniqueness (#690 Phase C) means slug collisions only happen
    // inside one org. Same slug in two different orgs is fine and lands
    // un-suffixed in each — that case is covered by the cross-org test below.
    const db = mkDb();
    await db.insert(organizations).values({
      id: "org_a",
      slug: "org-a",
      name: "Org A",
      category: "cloud",
    });
    const fetch = mkApp(db);

    const res1 = await fetch(
      new Request("https://x.test/v1/sources", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: "Release Notes",
          url: "https://org-a.test/changelog",
          orgSlug: "org-a",
        }),
      }),
    );
    expect(res1.status).toBe(201);
    const body1 = (await res1.json()) as { slug: string };
    expect(body1.slug).toBe("release-notes");

    // Same name in the *same* org — must get "release-notes-2".
    const res2 = await fetch(
      new Request("https://x.test/v1/sources", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: "Release Notes",
          url: "https://org-a.test/v2/changelog",
          orgSlug: "org-a",
        }),
      }),
    );
    expect(res2.status).toBe(201);
    const body2 = (await res2.json()) as { slug: string };
    expect(body2.slug).toBe("release-notes-2");
    expect(body1.slug).not.toBe(body2.slug);
  });

  it("same slug across different orgs lands un-suffixed in each", async () => {
    const db = mkDb();
    await db.insert(organizations).values([
      { id: "org_a", slug: "org-a", name: "Org A", category: "cloud" },
      { id: "org_b", slug: "org-b", name: "Org B", category: "cloud" },
    ]);
    const fetch = mkApp(db);

    const res1 = await fetch(
      new Request("https://x.test/v1/sources", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: "Release Notes",
          url: "https://org-a.test/changelog",
          orgSlug: "org-a",
        }),
      }),
    );
    expect(res1.status).toBe(201);
    expect(((await res1.json()) as { slug: string }).slug).toBe("release-notes");

    const res2 = await fetch(
      new Request("https://x.test/v1/sources", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: "Release Notes",
          url: "https://org-b.test/changelog",
          orgSlug: "org-b",
        }),
      }),
    );
    expect(res2.status).toBe(201);
    expect(((await res2.json()) as { slug: string }).slug).toBe("release-notes");
  });

  it("continues suffixing when multiple prior entries in the same org occupy the base and -2", async () => {
    const db = mkDb();
    await db.insert(organizations).values({
      id: "org_c",
      slug: "org-c",
      name: "Org C",
      category: "cloud",
    });
    const fetch = mkApp(db);

    for (const url of ["https://c.test/v1/changelog", "https://c.test/v2/changelog"] as const) {
      // oxlint-disable-next-line no-await-in-loop -- sequential: each insert must land before next to drive slug collision
      const r = await fetch(
        new Request("https://x.test/v1/sources", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ name: "Release Notes", url, orgSlug: "org-c" }),
        }),
      );
      expect(r.status).toBe(201);
    }

    const res3 = await fetch(
      new Request("https://x.test/v1/sources", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: "Release Notes",
          url: "https://c.test/v3/changelog",
          orgSlug: "org-c",
        }),
      }),
    );
    expect(res3.status).toBe(201);
    const body3 = (await res3.json()) as { slug: string };
    expect(body3.slug).toBe("release-notes-3");
  });
});
