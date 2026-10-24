// `?org=` on /v1/search: the same single-org scope as `?domain=`, keyed by
// slug or `org_…` id. A miss returns an empty envelope with
// `orgStatus: "not_found"`; sending both `org` and `domain` is a 400.
import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { createTestDb, type TestDatabase } from "../../../tests/db-helper.js";
import { searchRoutes } from "../src/routes/search.js";
import { organizations, releases, sources } from "@buildinternet/releases-core/schema";
import { makeCaller } from "./route-test-helpers.js";

let testDb: TestDatabase;

beforeEach(() => {
  testDb = createTestDb();
});

afterEach(() => {
  testDb.cleanup();
});

const call = makeCaller(searchRoutes, () => ({
  DB: testDb.db as unknown as never,
  MEDIA_ORIGIN: "",
}));

async function seed() {
  await testDb.db.insert(organizations).values([
    { id: "org_acme", slug: "acme", name: "Acme", domain: "acme.test" },
    { id: "org_beta", slug: "beta", name: "Beta", domain: "beta.test" },
  ]);
  for (const org of ["acme", "beta"]) {
    await testDb.db.insert(sources).values({
      id: `src_${org}`,
      orgId: `org_${org}`,
      slug: `${org}-changelog`,
      name: `${org} changelog`,
      type: "scrape",
      url: `https://${org}.test/changelog`,
    });
    await testDb.db.insert(releases).values({
      id: `rel_${org}`,
      sourceId: `src_${org}`,
      title: `${org} webhooks launch`,
      content: "Webhooks are here.",
      url: `https://${org}.test/changelog/webhooks`,
      publishedAt: "2026-05-01T00:00:00Z",
    });
  }
}

type Body = {
  org?: string;
  orgStatus?: string;
  releases: Array<{ orgSlug: string | null }>;
};

describe("GET /search — org scope", () => {
  test("scopes release hits to the org by slug and echoes it", async () => {
    await seed();
    const res = await call("/search?q=webhooks&mode=lexical&org=acme");
    expect(res.status).toBe(200);
    const body = (await res.json()) as Body;
    expect(body.orgStatus).toBe("matched");
    expect(body.org).toBe("acme");
    expect(body.releases.length).toBeGreaterThan(0);
    expect(body.releases.every((r) => r.orgSlug === "acme")).toBe(true);
  });

  test("accepts an org_ id and echoes the slug", async () => {
    await seed();
    const body = (await (
      await call("/search?q=webhooks&mode=lexical&org=org_beta")
    ).json()) as Body;
    expect(body.org).toBe("beta");
    expect(body.releases.every((r) => r.orgSlug === "beta")).toBe(true);
  });

  test("unscoped search sees both orgs", async () => {
    await seed();
    const body = (await (await call("/search?q=webhooks&mode=lexical")).json()) as Body;
    expect(new Set(body.releases.map((r) => r.orgSlug))).toEqual(new Set(["acme", "beta"]));
    expect(body.orgStatus).toBeUndefined();
  });

  test("unknown org returns an empty envelope with orgStatus not_found", async () => {
    await seed();
    const res = await call("/search?q=webhooks&mode=lexical&org=nope");
    expect(res.status).toBe(200);
    const body = (await res.json()) as Body;
    expect(body.orgStatus).toBe("not_found");
    expect(body.org).toBe("nope");
    expect(body.releases).toEqual([]);
  });

  test("org and domain together is a 400", async () => {
    await seed();
    const res = await call("/search?q=webhooks&mode=lexical&org=acme&domain=acme.test");
    expect(res.status).toBe(400);
  });
});
