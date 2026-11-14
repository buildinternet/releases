import { describe, expect, it } from "bun:test";
import {
  feedback,
  orgClaims,
  organizations,
  recommendations,
  sources,
} from "@buildinternet/releases-core/schema";
import { user } from "../src/db/schema-auth.js";
import type { SubmissionsResponse } from "../src/routes/admin-submissions.js";
import {
  buildRecommendationPlan,
  type Evaluate,
  type RecommendationPlan,
} from "../src/lib/submissions/recommendation-plan.js";
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

describe("GET /v1/admin/submissions/recommendations/:id/plan", () => {
  it("plans a canonical github source under the org already tracking that owner", async () => {
    const { db, fetch } = await makeApp();
    await db.insert(organizations).values({ id: "org_acme", slug: "acme-inc", name: "Acme" });
    await db.insert(sources).values({
      id: "src_engine",
      orgId: "org_acme",
      slug: "engine",
      name: "Engine",
      type: "github",
      url: "https://github.com/acmehq/engine",
    });
    await db.insert(recommendations).values({
      id: "rec_gh",
      createdAt: 1,
      url: "https://github.com/acmehq/rocket-cli/releases/tag/v1.2.0",
    });

    const res = await fetch(
      new Request("http://x/v1/admin/submissions/recommendations/rec_gh/plan"),
    );
    expect(res.status).toBe(200);
    const plan = (await res.json()) as RecommendationPlan;
    expect(plan.source).toMatchObject({
      type: "github",
      name: "Rocket Cli",
      url: "https://github.com/acmehq/rocket-cli",
    });
    expect(plan.matchedOrg).toEqual({ slug: "acme-inc", name: "Acme" });
    expect(plan.existingSource).toBeNull();
  });

  it("404s an unknown recommendation", async () => {
    const { fetch } = await makeApp();
    const res = await fetch(
      new Request("http://x/v1/admin/submissions/recommendations/rec_nope/plan"),
    );
    expect(res.status).toBe(404);
  });
});

type PlanDb = Parameters<typeof buildRecommendationPlan>[0];

describe("buildRecommendationPlan", () => {
  const feedEval: Evaluate = async (url) => ({
    recommendedMethod: "feed",
    recommendedUrl: "https://docs.acme.test/changelog.xml",
    feedUrl: "https://docs.acme.test/changelog.xml",
    feedType: "rss",
    pageStructure: "unknown",
    alternatives: [],
    confidence: "high",
    notes: url,
  });

  it("matches the parent domain and keeps the page URL with the feed in metadata", async () => {
    const db = createTestDb();
    await db
      .insert(organizations)
      .values({ id: "org_acme", slug: "acme", name: "Acme", domain: "acme.test" });
    await db.insert(sources).values({
      id: "src_dup",
      orgId: "org_acme",
      slug: "changelog",
      name: "Acme Changelog",
      type: "feed",
      url: "https://docs.acme.test/changelog",
    });
    await db.insert(recommendations).values({
      id: "rec_feed",
      createdAt: 1,
      url: "https://docs.acme.test/changelog",
    });

    const plan = (await buildRecommendationPlan(db as unknown as PlanDb, "rec_feed", feedEval))!;
    expect(plan.matchedOrg?.slug).toBe("acme");
    expect(plan.source.type).toBe("feed");
    expect(plan.source.url).toBe("https://docs.acme.test/changelog");
    expect(plan.source.metadata.feedUrl).toBe("https://docs.acme.test/changelog.xml");
    expect(plan.existingSource).toEqual({
      orgSlug: "acme",
      slug: "changelog",
      name: "Acme Changelog",
    });
  });

  it("suggests a new org from the root domain when nothing matches", async () => {
    const db = createTestDb();
    await db.insert(recommendations).values({
      id: "rec_new",
      createdAt: 1,
      url: "https://updates.rocket-labs.co.uk/notes",
    });
    const plan = (await buildRecommendationPlan(db as unknown as PlanDb, "rec_new", feedEval))!;
    // Public-suffix aware: not "co.uk"-style truncation, and not the subdomain.
    expect(plan.matchedOrg).toBeNull();
    expect(plan.newOrg).toEqual({
      name: "Rocket Labs",
      slug: "rocket-labs",
      domain: "rocket-labs.co.uk",
    });
    expect(plan.source.name).toBe("Rocket Labs Changelog");
  });
});
