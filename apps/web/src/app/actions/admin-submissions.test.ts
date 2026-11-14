import { afterEach, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import { enableLocalAdminEnv, restoreFetch, stubFetch } from "./test-helpers.test";

// Loaded dynamically — see test-helpers.test.ts for why a static import races
// the server-only mock.
let approve: (typeof import("./admin-submissions"))["approveRecommendationAction"];
let promote: (typeof import("./admin-submissions"))["promoteOrgAction"];

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });

const SOURCE = {
  name: "Acme Changelog",
  url: "https://acme.test/changelog",
  type: "feed" as const,
  metadata: { feedUrl: "https://acme.test/feed.xml" },
};

describe("approveRecommendationAction", () => {
  beforeAll(async () => {
    ({ approveRecommendationAction: approve, promoteOrgAction: promote } =
      await import("./admin-submissions"));
  });
  beforeEach(() => enableLocalAdminEnv());
  afterEach(() => restoreFetch());

  it("creates the org and source, then closes and emails in order", async () => {
    const recorded = stubFetch([
      json({ slug: "acme" }, 201),
      json({ id: "src_1", slug: "acme-changelog" }, 201),
      json({}),
      json({ sent: true }),
    ]);

    const res = await approve({
      recommendationId: "rec_1",
      org: { create: { name: "Acme", slug: "acme", domain: "acme.test" } },
      source: SOURCE,
      fetchNow: true,
      notify: true,
    });

    expect(res).toEqual({
      ok: true,
      data: { orgSlug: "acme", sourceSlug: "acme-changelog", warnings: [] },
    });
    expect(
      recorded.map((r) => `${r.method} ${r.url.replace("http://api.test.local", "")}`),
    ).toEqual([
      "POST /v1/orgs",
      "POST /v1/sources",
      "PATCH /v1/recommendations/rec_1",
      "POST /v1/admin/recommendations/rec_1/notify-added",
    ]);
    expect(JSON.parse(recorded[1]!.body!)).toEqual({
      name: "Acme Changelog",
      url: "https://acme.test/changelog",
      type: "feed",
      orgSlug: "acme",
      metadata: JSON.stringify(SOURCE.metadata),
    });
    expect(JSON.parse(recorded[3]!.body!)).toEqual({
      orgSlug: "acme",
      sourceSlug: "acme-changelog",
    });
  });

  it("skips the onboarding backfill when fetchNow is off", async () => {
    const recorded = stubFetch([json({ id: "src_1", slug: "changelog" }, 201), json({})]);
    await approve({
      recommendationId: "rec_1",
      org: { slug: "acme" },
      source: SOURCE,
      fetchNow: false,
      notify: false,
    });
    expect(recorded[0]?.headers["x-onboard-mode"]).toBe("manual");
    expect(recorded[0]?.headers.authorization).toBe("Bearer test-admin-key");
  });

  it("stops before anything else when the source create fails", async () => {
    const recorded = stubFetch([json({ error: { message: "nope" } }, 400)]);
    const res = await approve({
      recommendationId: "rec_1",
      org: { slug: "acme" },
      source: SOURCE,
      fetchNow: true,
      notify: false,
    });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toContain("Creating source failed");
    expect(recorded).toHaveLength(1);
  });

  it("reports follow-up failures as warnings once the source exists", async () => {
    stubFetch([json({ id: "src_1", slug: "changelog" }, 201), json({}, 500)]);
    const res = await approve({
      recommendationId: "rec_1",
      org: { slug: "acme" },
      source: SOURCE,
      fetchNow: false,
      notify: false,
    });
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.data.warnings[0]).toContain("Closing the suggestion failed");
  });
});

describe("promoteOrgAction", () => {
  beforeEach(() => enableLocalAdminEnv());
  afterEach(() => restoreFetch());

  it("hits the promote route, with dryRun for the preview", async () => {
    const recorded = stubFetch([json({ promoted: false, sourcesCreated: 0, sourcesMatched: 0 })]);
    await promote("stub-co", true);
    expect(recorded[0]?.method).toBe("POST");
    expect(recorded[0]?.url).toBe("http://api.test.local/v1/orgs/stub-co/promote?dryRun=1");
  });
});
