/**
 * Wiring test for the changesets-cascade demotion path inside
 * `postReleasesBatchHandler`. Posts a small Vercel-AI-SDK-shaped batch and
 * asserts that the dependency-bump siblings end up in `release_coverage`
 * with the substantive root release as canonical — and therefore
 * disappear from `releases_visible`.
 *
 * The clusterer logic itself is unit-tested in
 * `packages/core-internal/src/changesets-cluster.test.ts` against the
 * full screenshot fixtures; this file verifies the route handler invokes
 * it and writes coverage rows.
 */
import { describe, it, expect } from "bun:test";
import { organizations, sources, releasesVisible } from "@buildinternet/releases-core/schema";
import { releaseCoverage } from "@releases/db/schema-coverage.js";
import { eq } from "drizzle-orm";
import { sourceRoutes } from "../src/routes/sources.js";
import { createTestDb as mkDb, createTestApp } from "./setup";

const statusHubStub = {
  idFromName: () => "stub-id",
  get: () => ({
    fetch: async () => new Response("ok", { status: 200 }),
  }),
};

const mkApp = (db: ReturnType<typeof mkDb>) =>
  createTestApp(db, [sourceRoutes], { env: { STATUS_HUB: statusHubStub } });

async function seed(db: ReturnType<typeof mkDb>) {
  await db
    .insert(organizations)
    .values([{ id: "org_vercel", slug: "vercel", name: "Vercel", category: "cloud" }]);
  await db.insert(sources).values([
    {
      id: "src_ai_sdk",
      slug: "ai-sdk",
      name: "AI SDK",
      type: "github",
      url: "https://github.com/vercel/ai",
      orgId: "org_vercel",
    },
  ]);
}

describe("POST /v1/sources/:id/releases/batch — changesets cascade demotion", () => {
  it("links the AI SDK Updated-dependencies siblings to ai@6.0.182 as coverage", async () => {
    const db = mkDb();
    await seed(db);
    const fetch = mkApp(db);

    const payload = {
      releases: [
        {
          title: "@ai-sdk/vue@3.0.182",
          version: "@ai-sdk/vue@3.0.182",
          url: "https://github.com/vercel/ai/releases/tag/@ai-sdk/vue@3.0.182",
          content: "### Patch Changes\n\n-   Updated dependencies [e76a29a]\n    -   ai@6.0.182\n",
        },
        {
          title: "@ai-sdk/react@3.0.184",
          version: "@ai-sdk/react@3.0.184",
          url: "https://github.com/vercel/ai/releases/tag/@ai-sdk/react@3.0.184",
          content: "### Patch Changes\n\n-   Updated dependencies [e76a29a]\n    -   ai@6.0.182\n",
        },
        {
          title: "ai@6.0.182",
          version: "ai@6.0.182",
          url: "https://github.com/vercel/ai/releases/tag/ai@6.0.182",
          content: "### Patch Changes\n\n-   e76a29a: fix(ai): download tool-result file URLs\n",
        },
      ],
    };

    const res = await fetch(
      new Request("https://x.test/v1/sources/src_ai_sdk/releases/batch", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      }),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { inserted: number };
    expect(body.inserted).toBe(3);

    // Two cascade rows should have been linked to the substantive ai@6.0.182
    // release. We can't predict the auto-generated IDs, so resolve by URL.
    const coverageRows = await db.select().from(releaseCoverage);
    expect(coverageRows).toHaveLength(2);
    expect(new Set(coverageRows.map((r) => r.decidedBy))).toEqual(new Set(["system:changesets"]));
    expect(new Set(coverageRows.map((r) => r.reason))).toEqual(
      new Set(["changesets-cascade:e76a29a"]),
    );

    // All three rows should still be in the base `releases` table, but only
    // the canonical (ai@6.0.182) should remain in `releases_visible`.
    const visible = await db
      .select()
      .from(releasesVisible)
      .where(eq(releasesVisible.sourceId, "src_ai_sdk"));
    expect(visible).toHaveLength(1);
    expect(visible[0].version).toBe("ai@6.0.182");
  });

  it("is a no-op for a non-cascade batch (no coverage rows written)", async () => {
    const db = mkDb();
    await seed(db);
    const fetch = mkApp(db);

    const res = await fetch(
      new Request("https://x.test/v1/sources/src_ai_sdk/releases/batch", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          releases: [
            {
              title: "v1.0.0",
              version: "1.0.0",
              url: "https://example.com/v1",
              content: "Initial release with feature X.",
            },
            {
              title: "v1.0.1",
              version: "1.0.1",
              url: "https://example.com/v1.0.1",
              content: "Bug fix for feature X.",
            },
          ],
        }),
      }),
    );
    expect(res.status).toBe(200);

    const coverageRows = await db.select().from(releaseCoverage);
    expect(coverageRows).toHaveLength(0);
  });
});
