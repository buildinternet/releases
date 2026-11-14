import { describe, expect, it } from "bun:test";
import {
  feedback,
  orgClaims,
  organizations,
  recommendations,
} from "@buildinternet/releases-core/schema";
import { user } from "../src/db/schema-auth.js";
import type { SubmissionsResponse } from "../src/routes/admin-submissions.js";
import { createTestApp, createTestDb } from "./setup";

async function makeApp() {
  const db = createTestDb();
  const { adminSubmissionRoutes } = await import("../src/routes/admin-submissions.js");
  return { db, fetch: createTestApp(db, adminSubmissionRoutes) };
}

async function seed(db: ReturnType<typeof createTestDb>) {
  await db.insert(recommendations).values([
    { id: "rec_open", createdAt: 1000, url: "https://a.test/changelog", status: "new" },
    { id: "rec_closed", createdAt: 5000, url: "https://b.test/changelog", status: "closed" },
    {
      id: "rec_arch",
      createdAt: 6000,
      url: "https://c.test/changelog",
      status: "new",
      archived: true,
    },
  ]);
  await db.insert(feedback).values([
    {
      id: "fb_open",
      createdAt: 3000,
      message: "Search is slow",
      type: "bug",
      contact: "x@example.com",
    },
    { id: "fb_closed", createdAt: 7000, message: "Done", status: "closed" },
  ]);
  await db.insert(organizations).values([
    {
      id: "org_stub",
      slug: "stubco",
      name: "Stub Co",
      domain: "stub.test",
      tier: "stub",
      trackingRequestedAt: new Date(4000).toISOString(),
    },
    {
      id: "org_tracked",
      slug: "trackedco",
      name: "Tracked Co",
      domain: "tracked.test",
      tier: "tracked",
      trackingRequestedAt: new Date(8000).toISOString(),
    },
    { id: "org_plain", slug: "plain", name: "Plain" },
  ]);
  await db.insert(user).values({
    id: "u_1",
    name: "Owner",
    email: "owner@example.com",
    createdAt: new Date(0),
    updatedAt: new Date(0),
  });
  await db.insert(orgClaims).values([
    {
      id: "clm_pending",
      orgId: "org_plain",
      userId: "u_1",
      token: "relv_a",
      status: "pending",
      createdAt: new Date(2000).toISOString(),
      expiresAt: new Date(99_999_999).toISOString(),
    },
    {
      id: "clm_expired",
      orgId: "org_plain",
      userId: "u_1",
      token: "relv_b",
      status: "expired",
      createdAt: new Date(9000).toISOString(),
      expiresAt: new Date(9001).toISOString(),
    },
  ]);
}

async function get(fetch: (r: Request) => Response | Promise<Response>, qs = "") {
  const res = await fetch(new Request(`http://x/v1/admin/submissions${qs}`));
  expect(res.status).toBe(200);
  return (await res.json()) as SubmissionsResponse;
}

describe("GET /v1/admin/submissions", () => {
  it("returns open items of every kind, newest first, with open counts", async () => {
    const { db, fetch } = await makeApp();
    await seed(db);

    const body = await get(fetch);
    expect(body.items.map((i) => i.id)).toEqual(["org_stub", "fb_open", "clm_pending", "rec_open"]);
    expect(body.openCounts).toEqual({
      recommendation: 1,
      feedback: 1,
      "tracking-request": 1,
      claim: 1,
    });

    const claim = body.items.find((i) => i.kind === "claim")!;
    expect(claim.contact).toBe("owner@example.com");
    expect(claim.org).toEqual({ slug: "plain", name: "Plain", domain: null });
    const tracking = body.items.find((i) => i.kind === "tracking-request")!;
    expect(tracking.createdAt).toBe(4000);
    expect(tracking.url).toBe("https://stub.test");
  });

  it("state=all includes closed, archived, promoted and expired items", async () => {
    const { db, fetch } = await makeApp();
    await seed(db);

    const body = await get(fetch, "?state=all");
    expect(body.items.map((i) => i.id)).toEqual([
      "clm_expired",
      "org_tracked",
      "fb_closed",
      "rec_arch",
      "rec_closed",
      "org_stub",
      "fb_open",
      "clm_pending",
      "rec_open",
    ]);
    expect(body.items.find((i) => i.id === "rec_arch")!.open).toBe(false);
    // Counts stay "open" regardless of the state filter.
    expect(body.openCounts.recommendation).toBe(1);
  });

  it("filters by kind and caps at limit", async () => {
    const { db, fetch } = await makeApp();
    await seed(db);

    const onlyFb = await get(fetch, "?kind=feedback&state=all");
    expect(onlyFb.items.map((i) => i.id)).toEqual(["fb_closed", "fb_open"]);

    const capped = await get(fetch, "?state=all&limit=2");
    expect(capped.items.map((i) => i.id)).toEqual(["clm_expired", "org_tracked"]);
  });

  it("ignores an unknown kind and hides soft-deleted orgs", async () => {
    const { db, fetch } = await makeApp();
    await seed(db);
    await db.insert(organizations).values({
      id: "org_gone",
      slug: "gone--org_gone",
      name: "Gone",
      tier: "stub",
      trackingRequestedAt: new Date(10_000).toISOString(),
      deletedAt: new Date(10_001).toISOString(),
    });

    const body = await get(fetch, "?kind=nope");
    expect(body.items.some((i) => i.id === "org_gone")).toBe(false);
    expect(body.items).toHaveLength(4);
  });
});
