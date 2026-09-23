import { describe, it, expect, afterEach } from "bun:test";
import { organizations, sources, releases } from "@buildinternet/releases-core/schema";
import { eq } from "drizzle-orm";
import { fetchOne } from "../src/cron/poll-fetch.js";
import { createTestDb } from "./setup";
import { restoreGlobalFetch } from "../../../tests/global-fetch";

afterEach(() => {
  restoreGlobalFetch();
});

const FEED_URL =
  "https://support.zendesk.com/api/v2/help_center/en-us/sections/4405298847002/articles.json?per_page=100&sort_by=created_at&sort_order=desc";

function articlesJson() {
  return JSON.stringify({
    count: 1,
    articles: [
      {
        id: 108,
        title: "Release notes through 2026-05-22",
        html_url:
          "https://support.zendesk.com/hc/en-us/articles/108-Release-notes-through-2026-05-22",
        body: '<h2>Copilot</h2><p>New: <a href="/hc/en-us/articles/999">admin copilot</a></p>',
        created_at: "2026-05-25T00:36:41Z",
        edited_at: "2026-05-25T00:40:12Z",
      },
    ],
    next_page: null,
  });
}

async function seedHelpCenterSource(db: ReturnType<typeof createTestDb>) {
  await db.insert(organizations).values({ id: "org_z", name: "Zendesk", slug: "zendesk" });
  await db.insert(sources).values({
    id: "src_z",
    name: "Release notes",
    slug: "release-notes",
    type: "feed",
    url: "https://support.zendesk.com/hc/en-us/sections/4405298847002-Release-notes",
    orgId: "org_z",
    metadata: JSON.stringify({
      feedUrl: FEED_URL,
      feedType: "jsonfeed",
      helpCenter: { provider: "zendesk", releaseType: "rollup" },
    }),
  });
  return (await db.select().from(sources).where(eq(sources.id, "src_z")))[0]!;
}

describe("help-center (zendesk) fetchOne", () => {
  it("routes a feed source with metadata.helpCenter to the Content API parser, inserts a rollup, and dedups", async () => {
    const db = createTestDb();
    const source = await seedHelpCenterSource(db);
    globalThis.fetch = (async () =>
      new Response(articlesJson(), { status: 200 })) as unknown as typeof fetch;

    // oxlint-disable-next-line no-explicit-any -- BunSQLiteDatabase vs DrizzleD1Database; works at runtime via the shim
    const first = await fetchOne(db as any, source, {} as never, { skipSideEffects: true });
    expect(first.releasesInserted).toBe(1);

    const rows = await db.select().from(releases).where(eq(releases.sourceId, "src_z"));
    expect(rows).toHaveLength(1);
    expect(rows[0]!.url).toBe(
      "https://support.zendesk.com/hc/en-us/articles/108-Release-notes-through-2026-05-22",
    );
    expect(rows[0]!.type).toBe("rollup");
    // body HTML was converted to markdown and root-relative links absolutized
    expect(rows[0]!.content).toContain("## Copilot");
    expect(rows[0]!.content).toContain("https://support.zendesk.com/hc/en-us/articles/999");

    // oxlint-disable-next-line no-explicit-any -- BunSQLiteDatabase vs DrizzleD1Database; works at runtime via the shim
    const second = await fetchOne(db as any, source, {} as never, { skipSideEffects: true });
    expect(second.releasesInserted).toBe(0);
    expect(await db.select().from(releases).where(eq(releases.sourceId, "src_z"))).toHaveLength(1);
  });
});
