import { describe, it, expect, beforeEach } from "bun:test";
import { Database } from "bun:sqlite";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { eq } from "drizzle-orm";
import { Hono } from "hono";
import { applyMigrations } from "../db-helper";
import {
  organizations,
  sources,
  releases,
  knowledgePageCitations,
} from "@buildinternet/releases-core/schema";
import overview from "../../workers/api/src/routes/overview";

function mkDb() {
  const sqlite = new Database(":memory:");
  sqlite.run("PRAGMA foreign_keys=ON");
  applyMigrations(sqlite);
  return drizzle(sqlite);
}

function mkApp(db: ReturnType<typeof mkDb>) {
  const app = new Hono();
  app.use("*", async (c, next) => {
    (c as any).set("db", db);
    await next();
  });
  app.route("/", overview);
  return app;
}

const RELEASE_MATCHED = "https://acme.com/blog/v2-launch";
const RELEASE_MIXED_CASE = "https://acme.com/blog/Foo-Bar-Baz";
const RELEASE_ORPHAN = "https://acme.com/blog/never-stored";

describe("POST/GET /v1/orgs/:slug/overview citations", () => {
  let db: ReturnType<typeof mkDb>;
  let orgId: string;
  let matchedReleaseId: string;
  let mixedCaseReleaseId: string;
  let app: ReturnType<typeof mkApp>;

  beforeEach(async () => {
    db = mkDb();
    app = mkApp(db);

    const [org] = await db.insert(organizations).values({ name: "Acme", slug: "acme" }).returning();
    orgId = org.id;

    const [src] = await db
      .insert(sources)
      .values({
        orgId,
        name: "Acme Blog",
        slug: "acme-blog",
        type: "feed",
        url: "https://acme.com/blog.xml",
      })
      .returning();

    const [r1] = await db
      .insert(releases)
      .values({
        sourceId: src.id,
        url: RELEASE_MATCHED,
        title: "v2 launch",
        content: "v2 ships",
        publishedAt: "2026-05-01T00:00:00.000Z",
      })
      .returning();
    matchedReleaseId = r1.id;

    const [r2] = await db
      .insert(releases)
      .values({
        sourceId: src.id,
        url: RELEASE_MIXED_CASE,
        title: "Foo Bar",
        content: "foo bar",
        publishedAt: "2026-05-02T00:00:00.000Z",
      })
      .returning();
    mixedCaseReleaseId = r2.id;
  });

  async function postOverview(body: unknown): Promise<Response> {
    return app.request("/orgs/acme/overview", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
  }

  async function getOverview(): Promise<Response> {
    return app.request("/orgs/acme/overview");
  }

  it("stores citations and resolves release_id by URL (case-insensitive)", async () => {
    const content =
      "Acme shipped v2 with major improvements. Foo Bar was also rebranded last week.";
    // Cite RELEASE_MATCHED with exact URL, RELEASE_MIXED_CASE via lowercased
    // URL — both must resolve to a release_id via the case-insensitive
    // lookup.
    const res = await postOverview({
      content,
      releaseCount: 2,
      lastContributingReleaseAt: "2026-05-02T00:00:00.000Z",
      citations: [
        {
          startIndex: 0,
          endIndex: 40,
          sourceUrl: RELEASE_MATCHED,
          title: "v2 launch",
          citedText: "v2 ships",
        },
        {
          startIndex: 41,
          endIndex: 78,
          sourceUrl: RELEASE_MIXED_CASE.toLowerCase(),
          title: "Foo Bar",
          citedText: "foo bar",
        },
      ],
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, citations: 2 });

    const get = await getOverview();
    const body = (await get.json()) as { citations: Array<Record<string, unknown>> };
    expect(body.citations).toHaveLength(2);
    expect(body.citations[0]).toMatchObject({
      startIndex: 0,
      endIndex: 40,
      sourceUrl: RELEASE_MATCHED,
      releaseId: matchedReleaseId,
      citedText: "v2 ships",
    });
    expect(body.citations[1]).toMatchObject({
      sourceUrl: RELEASE_MIXED_CASE.toLowerCase(),
      releaseId: mixedCaseReleaseId,
    });
  });

  it("stores citation for orphan source_url with null release_id", async () => {
    const content = "Acme also discontinued the legacy product.";
    const res = await postOverview({
      content,
      releaseCount: 0,
      citations: [
        {
          startIndex: 0,
          endIndex: 41,
          sourceUrl: RELEASE_ORPHAN,
          citedText: "discontinued the legacy product",
        },
      ],
    });
    expect(res.status).toBe(200);

    const get = await getOverview();
    const body = (await get.json()) as { citations: Array<Record<string, unknown>> };
    expect(body.citations).toHaveLength(1);
    expect(body.citations[0]).toMatchObject({
      sourceUrl: RELEASE_ORPHAN,
      releaseId: null,
    });
  });

  it("replace-all: omitting citations on subsequent write clears them", async () => {
    await postOverview({
      content: "First write with a citation.",
      releaseCount: 1,
      citations: [
        {
          startIndex: 0,
          endIndex: 20,
          sourceUrl: RELEASE_MATCHED,
          citedText: "v2 ships",
        },
      ],
    });
    // Second write — no citations field. Should clear the previous set.
    await postOverview({
      content: "Second write with no citations.",
      releaseCount: 1,
    });

    const get = await getOverview();
    const body = (await get.json()) as { citations: unknown[] };
    expect(body.citations).toEqual([]);
  });

  it("replace-all: explicit empty citations array clears them", async () => {
    await postOverview({
      content: "First write.",
      releaseCount: 1,
      citations: [
        {
          startIndex: 0,
          endIndex: 5,
          sourceUrl: RELEASE_MATCHED,
          citedText: "First",
        },
      ],
    });
    await postOverview({
      content: "Second write.",
      releaseCount: 1,
      citations: [],
    });
    const body = (await (await getOverview()).json()) as { citations: unknown[] };
    expect(body.citations).toEqual([]);
  });

  it("rejects malformed citation spans", async () => {
    const r1 = await postOverview({
      content: "short",
      releaseCount: 1,
      citations: [{ startIndex: 0, endIndex: 99, sourceUrl: RELEASE_MATCHED, citedText: "x" }],
    });
    expect(r1.status).toBe(400);

    const r2 = await postOverview({
      content: "short",
      releaseCount: 1,
      citations: [{ startIndex: 5, endIndex: 3, sourceUrl: RELEASE_MATCHED, citedText: "x" }],
    });
    expect(r2.status).toBe(400);

    const r3 = await postOverview({
      content: "short",
      releaseCount: 1,
      citations: [{ startIndex: 0, endIndex: 4, sourceUrl: "", citedText: "x" }],
    });
    expect(r3.status).toBe(400);
  });

  it("cascades citation deletes when the page row is removed", async () => {
    await postOverview({
      content: "Acme launched v2.",
      releaseCount: 1,
      citations: [
        {
          startIndex: 0,
          endIndex: 17,
          sourceUrl: RELEASE_MATCHED,
          citedText: "Acme launched v2",
        },
      ],
    });
    // Drop the org row — knowledge_pages cascade off org, citations cascade
    // off knowledge_pages.
    await db.delete(organizations).where(eq(organizations.id, orgId));
    const remaining = await db.select().from(knowledgePageCitations);
    expect(remaining).toHaveLength(0);
  });
});
