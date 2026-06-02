import { afterEach, describe, expect, it } from "bun:test";
import { organizations, sources } from "@buildinternet/releases-core/schema";
import { eq } from "drizzle-orm";
import { fetchOne } from "../src/cron/poll-fetch.js";
import { createTestDb } from "./setup";

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

describe("github fetchOne — star capture", () => {
  it("writes stargazers_count to the source after a github poll", async () => {
    const db = createTestDb();
    await db.insert(organizations).values({ id: "org_a", slug: "acme", name: "Acme" });
    await db.insert(sources).values({
      id: "src_g",
      slug: "widget",
      name: "widget",
      type: "github",
      url: "https://github.com/acme/widget",
      orgId: "org_a",
    });

    globalThis.fetch = (async (input: string) => {
      const url = String(input);
      if (url.includes("/repos/acme/widget/releases")) {
        return new Response(
          JSON.stringify([
            {
              tag_name: "v1.0.0",
              name: "v1.0.0",
              body: "notes",
              html_url: "https://github.com/acme/widget/releases/tag/v1.0.0",
              published_at: "2026-06-01T00:00:00Z",
              prerelease: false,
            },
          ]),
          { status: 200 },
        );
      }
      if (url.endsWith("/repos/acme/widget")) {
        return new Response(JSON.stringify({ stargazers_count: 8675 }), { status: 200 });
      }
      return new Response("[]", { status: 200 });
    }) as unknown as typeof fetch;

    const [source] = await db.select().from(sources).where(eq(sources.id, "src_g"));
    // skipSideEffects:true avoids the changelog-refresh network calls; star
    // capture lives in the successOps batch, which runs regardless.
    // oxlint-disable-next-line no-explicit-any -- BunSQLiteDatabase vs DrizzleD1Database; works via the shim
    await fetchOne(db as any, source!, {} as never, { skipSideEffects: true });

    const [row] = await db.select().from(sources).where(eq(sources.id, "src_g"));
    expect(row?.stargazersCount).toBe(8675);
    expect(row?.starsFetchedAt).toBeTruthy();
  });
});
