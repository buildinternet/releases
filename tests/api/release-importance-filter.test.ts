/**
 * Tests for the `importance` field and `minImportance` filter on
 * `GET /v1/releases/latest`.
 *
 * `importance` is a nullable 1–5 AI score (`releases.importance`), scored at
 * ingest. `minImportance` restricts the feed to releases scored at or above
 * a threshold; out-of-range or non-integer values 400 rather than silently
 * falling through (same rationale as the `exclude` param — a silent
 * fallthrough would return an unfiltered feed and could cache-collide with
 * the default homepage shape).
 */
import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { organizations, sources, releases } from "@buildinternet/releases-core/schema";
import { releaseRoutes } from "../../workers/api/src/routes/releases.js";
import { createTestDb, type TestDatabase } from "../db-helper.js";
import { makeCaller } from "./route-test-helpers.js";

let testDb: TestDatabase;

beforeEach(() => {
  testDb = createTestDb();
});

afterEach(() => {
  testDb.cleanup();
});

function makeEnv() {
  return {
    DB: testDb.db as unknown as never,
    MEDIA_ORIGIN: "",
  };
}

const callRelease = makeCaller(releaseRoutes, makeEnv);

async function seedOrgAndSource() {
  await testDb.db
    .insert(organizations)
    .values({ id: "org_acme", slug: "acme", name: "Acme", discovery: "curated" });
  await testDb.db.insert(sources).values({
    id: "src_acme",
    orgId: "org_acme",
    slug: "acme-feed",
    name: "Acme Feed",
    url: "https://acme.test/feed",
    type: "feed",
    metadata: "{}",
  });
}

async function seedRelease(opts: {
  id: string;
  title: string;
  importance: number | null;
  publishedAt?: string;
}) {
  await testDb.db.insert(releases).values({
    id: opts.id,
    sourceId: "src_acme",
    title: opts.title,
    content: "",
    url: `https://acme.test/${opts.id}`,
    publishedAt: opts.publishedAt ?? "2024-01-01T00:00:00Z",
    importance: opts.importance,
  });
}

describe("GET /v1/releases/latest — importance", () => {
  it("carries importance through the projection, including null for unscored rows", async () => {
    await seedOrgAndSource();
    await seedRelease({ id: "rel_scored", title: "Scored release", importance: 4 });
    await seedRelease({ id: "rel_unscored", title: "Unscored release", importance: null });

    const res = await callRelease("/releases/latest");
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      releases: Array<{ title: string; importance?: number | null }>;
    };
    const scored = body.releases.find((r) => r.title === "Scored release");
    const unscored = body.releases.find((r) => r.title === "Unscored release");
    expect(scored?.importance).toBe(4);
    expect(unscored?.importance).toBeNull();
  });

  it("?minImportance= filters out releases scored below the threshold", async () => {
    await seedOrgAndSource();
    await seedRelease({
      id: "rel_low",
      title: "Low importance",
      importance: 2,
      publishedAt: "2024-01-01T00:00:00Z",
    });
    await seedRelease({
      id: "rel_high",
      title: "High importance",
      importance: 5,
      publishedAt: "2024-01-02T00:00:00Z",
    });
    await seedRelease({
      id: "rel_null",
      title: "Unscored",
      importance: null,
      publishedAt: "2024-01-03T00:00:00Z",
    });

    const res = await callRelease("/releases/latest?minImportance=4");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { releases: Array<{ title: string }> };
    const titles = body.releases.map((r) => r.title);
    expect(titles).toContain("High importance");
    expect(titles).not.toContain("Low importance");
    expect(titles).not.toContain("Unscored");
  });

  it("?minImportance=1 is inclusive of every scored release", async () => {
    await seedOrgAndSource();
    await seedRelease({ id: "rel_min", title: "Min importance", importance: 1 });

    const res = await callRelease("/releases/latest?minImportance=1");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { releases: Array<{ title: string }> };
    expect(body.releases.map((r) => r.title)).toContain("Min importance");
  });

  it("rejects an out-of-range minImportance with 400", async () => {
    await seedOrgAndSource();

    const tooHigh = await callRelease("/releases/latest?minImportance=6");
    expect(tooHigh.status).toBe(400);
    const tooHighBody = (await tooHigh.json()) as { error: { message: string } };
    expect(tooHighBody.error.message).toMatch(/minImportance/);

    const tooLow = await callRelease("/releases/latest?minImportance=0");
    expect(tooLow.status).toBe(400);
  });

  it("rejects a non-integer minImportance with 400", async () => {
    await seedOrgAndSource();

    const res = await callRelease("/releases/latest?minImportance=abc");
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { message: string } };
    expect(body.error.message).toMatch(/minImportance/);
  });
});
