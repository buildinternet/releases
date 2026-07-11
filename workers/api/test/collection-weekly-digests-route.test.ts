import { describe, it, expect } from "bun:test";
import {
  organizations,
  sources,
  releases,
  collections,
  collectionWeeklyDigests,
} from "@buildinternet/releases-core/schema";
import { collectionRoutes } from "../src/routes/collections.js";
import { createTestDb as mkDb, createTestApp } from "./setup";

const mkApp = (db: ReturnType<typeof mkDb>) => createTestApp(db, collectionRoutes);

async function seed(db: ReturnType<typeof mkDb>) {
  await db
    .insert(organizations)
    .values([{ id: "org_wd_anth", slug: "wd-anthropic", name: "Anthropic", category: "ai" }]);
  await db.insert(sources).values([
    {
      id: "src_wd_anth",
      slug: "news",
      name: "News",
      type: "feed",
      url: "https://www.anthropic.com/news",
      orgId: "org_wd_anth",
    },
  ]);
  await db.insert(releases).values([
    {
      id: "rel_wd_a1",
      sourceId: "src_wd_anth",
      title: "Claude 4.7",
      titleShort: "Claude 4.7",
      content: "Released Claude 4.7.",
      url: "https://www.anthropic.com/news/claude-4-7",
      publishedAt: "2026-06-08T18:00:00.000Z",
    },
    {
      id: "rel_wd_a2",
      sourceId: "src_wd_anth",
      title: "Claude 4.6",
      titleShort: "Claude 4.6",
      content: "Released Claude 4.6.",
      url: "https://www.anthropic.com/news/claude-4-6",
      publishedAt: "2026-06-09T18:00:00.000Z",
    },
  ]);
  await db
    .insert(collections)
    .values([{ id: "col_wd_test", slug: "wd-test-collection", name: "WD Test Collection" }]);
  await db.insert(collectionWeeklyDigests).values([
    {
      id: "cwd_test_w1",
      collectionId: "col_wd_test",
      weekStart: "2026-06-08",
      title: "A big week for frontier models",
      intro: "Two major releases landed this week.",
      body: "### Highlights\n\nAnthropic shipped [Claude 4.7](rel:rel_wd_a1) and [Claude 4.6](rel:rel_wd_a2).",
      releaseIds: JSON.stringify(["rel_wd_a1", "rel_wd_a2", "rel_wd_deleted"]),
      releaseCount: 2,
      modelId: "openrouter:deepseek/deepseek-chat",
      generatedAt: "2026-06-15T05:00:00.000Z",
      updatedAt: "2026-06-15T05:00:00.000Z",
    },
    {
      id: "cwd_test_w2",
      collectionId: "col_wd_test",
      weekStart: "2026-06-01",
      title: "A quieter week",
      intro: "Fewer releases, but notable polish work.",
      body: "### Recap\n\nA quieter week overall.",
      releaseIds: JSON.stringify([]),
      releaseCount: 0,
      modelId: "openrouter:deepseek/deepseek-chat",
      generatedAt: "2026-06-08T05:00:00.000Z",
      updatedAt: "2026-06-08T05:00:00.000Z",
    },
  ]);
}

describe("GET /v1/collections/:slug/digests", () => {
  it("returns digests newest-first, without body/releaseIds", async () => {
    const db = mkDb();
    await seed(db);
    const fetch = mkApp(db);

    const res = await fetch(new Request("http://test/v1/collections/wd-test-collection/digests"));
    expect(res.status).toBe(200);
    const body = (await res.json()) as any;
    expect(body.digests.map((d: any) => d.weekStart)).toEqual(["2026-06-08", "2026-06-01"]);
    expect(body.digests[0].title).toBe("A big week for frontier models");
    expect(body.digests[0].body).toBeUndefined();
    expect(body.digests[0].releaseIds).toBeUndefined();
    expect(body.pagination.limit).toBe(20);
  });

  it("paginates with a cursor", async () => {
    const db = mkDb();
    await seed(db);
    const fetch = mkApp(db);

    const first = await fetch(
      new Request("http://test/v1/collections/wd-test-collection/digests?limit=1"),
    );
    const firstBody = (await first.json()) as any;
    expect(firstBody.digests).toHaveLength(1);
    expect(firstBody.digests[0].weekStart).toBe("2026-06-08");
    expect(firstBody.pagination.nextCursor).toBeTruthy();

    const second = await fetch(
      new Request(
        `http://test/v1/collections/wd-test-collection/digests?limit=1&cursor=${firstBody.pagination.nextCursor}`,
      ),
    );
    const secondBody = (await second.json()) as any;
    expect(secondBody.digests).toHaveLength(1);
    expect(secondBody.digests[0].weekStart).toBe("2026-06-01");
    expect(secondBody.pagination.nextCursor).toBeNull();
  });

  it("returns 404 for an unknown collection slug", async () => {
    const db = mkDb();
    await seed(db);
    const fetch = mkApp(db);

    const res = await fetch(new Request("http://test/v1/collections/nope/digests"));
    expect(res.status).toBe(404);
  });
});

describe("GET /v1/collections/:slug/digests/:weekStart", () => {
  it("returns the full row with resolved covered releases, dropping unresolvable ids", async () => {
    const db = mkDb();
    await seed(db);
    const fetch = mkApp(db);

    const res = await fetch(
      new Request("http://test/v1/collections/wd-test-collection/digests/2026-06-08"),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as any;
    expect(body.title).toBe("A big week for frontier models");
    expect(body.body).toContain("Claude 4.7");
    expect(body.releaseIds).toEqual(["rel_wd_a1", "rel_wd_a2", "rel_wd_deleted"]);
    // rel_wd_deleted never existed — dropped from the resolved list, not a dead link.
    expect(body.releases).toHaveLength(2);
    expect(body.releases.map((r: any) => r.id)).toEqual(["rel_wd_a1", "rel_wd_a2"]);
    expect(body.releases[0].org).toEqual({ slug: "wd-anthropic", name: "Anthropic" });
    expect(body.releases[0].path).toContain("rel_wd_a1");
  });

  it("returns 404 for a week with no digest", async () => {
    const db = mkDb();
    await seed(db);
    const fetch = mkApp(db);

    const res = await fetch(
      new Request("http://test/v1/collections/wd-test-collection/digests/2026-05-25"),
    );
    expect(res.status).toBe(404);
  });

  it("returns 400 for a malformed weekStart", async () => {
    const db = mkDb();
    await seed(db);
    const fetch = mkApp(db);

    const res = await fetch(
      new Request("http://test/v1/collections/wd-test-collection/digests/not-a-date"),
    );
    expect(res.status).toBe(400);
  });

  it("returns 404 for an unknown collection slug", async () => {
    const db = mkDb();
    await seed(db);
    const fetch = mkApp(db);

    const res = await fetch(new Request("http://test/v1/collections/nope/digests/2026-06-08"));
    expect(res.status).toBe(404);
  });
});
