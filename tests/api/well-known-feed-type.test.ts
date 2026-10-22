import { describe, expect, it } from "bun:test";
import { eq } from "drizzle-orm";
import { organizations, sources } from "@buildinternet/releases-core/schema";
import { createTestDb } from "../db-helper";
import { reconcileDomainEntities } from "../../apps/api/src/lib/well-known/materialize";

describe("well-known feed probe", () => {
  it("stores the feed type sniffed while probing a declared feed", async () => {
    const { db } = createTestDb();
    await db.insert(organizations).values({ id: "org_a", slug: "acme", name: "Acme" });
    const atom = `<?xml version="1.0"?><feed xmlns="http://www.w3.org/2005/Atom"><title>Acme</title></feed>`;
    const { plan } = await reconcileDomainEntities(
      db as never,
      "org_a",
      { version: 2, releases: [{ feed: "https://acme.com/feed.xml" }] },
      {
        dryRun: false,
        enabled: true,
        source: "well-known",
        fetchImpl: (async () => new Response(atom, { status: 200 })) as unknown as typeof fetch,
        resolveCategory: async () => null,
      },
    );
    expect(plan.sources[0]).toMatchObject({ action: "create" });
    const [row] = await db.select().from(sources).where(eq(sources.orgId, "org_a"));
    const meta = JSON.parse(row!.metadata!);
    expect(meta.feedUrl).toBe("https://acme.com/feed.xml");
    expect(meta.feedType).toBe("atom");
  });
});
