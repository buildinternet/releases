/**
 * Backfill endpoint: POST /v1/workflows/cluster-changesets.
 *
 * Seeds a small batch of historical Vercel-CLI-shaped releases (already
 * inserted, no coverage links), then exercises the endpoint to assert it
 * detects the cascade and writes `release_coverage` rows on the real run
 * while leaving the DB untouched in dry-run mode.
 */
import { describe, it, expect } from "bun:test";
import { organizations, sources, releases } from "@buildinternet/releases-core/schema";
import { releaseCoverage } from "@releases/core-internal/schema-coverage.js";
import { workflowsRoutes } from "../src/routes/workflows.js";
import { createTestDb as mkDb, createTestApp } from "./setup";

const mkApp = (db: ReturnType<typeof mkDb>) => createTestApp(db, [workflowsRoutes]);

async function seedCascade(db: ReturnType<typeof mkDb>) {
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
  // 3 historical releases, no coverage links yet — one substantive + two cascades.
  await db.insert(releases).values([
    {
      id: "rel_ai_core",
      sourceId: "src_ai_sdk",
      version: "ai@6.0.182",
      title: "ai@6.0.182",
      content: "### Patch Changes\n\n-   e76a29a: fix(ai): download tool-result file URLs\n",
      publishedAt: new Date().toISOString(),
    },
    {
      id: "rel_ai_react",
      sourceId: "src_ai_sdk",
      version: "@ai-sdk/react@3.0.184",
      title: "@ai-sdk/react@3.0.184",
      content: "### Patch Changes\n\n-   Updated dependencies [e76a29a]\n    -   ai@6.0.182\n",
      publishedAt: new Date().toISOString(),
    },
    {
      id: "rel_ai_vue",
      sourceId: "src_ai_sdk",
      version: "@ai-sdk/vue@3.0.182",
      title: "@ai-sdk/vue@3.0.182",
      content: "### Patch Changes\n\n-   Updated dependencies [e76a29a]\n    -   ai@6.0.182\n",
      publishedAt: new Date().toISOString(),
    },
  ]);
}

describe("POST /v1/workflows/cluster-changesets", () => {
  it("400s without a source or org scope", async () => {
    const db = mkDb();
    await seedCascade(db);
    const fetch = mkApp(db);
    const res = await fetch(
      new Request("https://x.test/v1/workflows/cluster-changesets", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
      }),
    );
    expect(res.status).toBe(400);
  });

  it("dry-run reports detected clusters without writing coverage rows", async () => {
    const db = mkDb();
    await seedCascade(db);
    const fetch = mkApp(db);
    const res = await fetch(
      new Request("https://x.test/v1/workflows/cluster-changesets", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sourceId: "src_ai_sdk", dryRun: true }),
      }),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      processed: number;
      clusters: number;
      coverage: number;
      hashes: string[];
      dryRun: boolean;
    };
    expect(body.dryRun).toBe(true);
    expect(body.clusters).toBe(1);
    expect(body.coverage).toBe(2);
    expect(body.hashes).toEqual(["e76a29a"]);

    // Nothing should have been written.
    const rows = await db.select().from(releaseCoverage);
    expect(rows).toHaveLength(0);
  });

  it("real run links the cascade siblings to ai@6.0.182 as coverage", async () => {
    const db = mkDb();
    await seedCascade(db);
    const fetch = mkApp(db);
    const res = await fetch(
      new Request("https://x.test/v1/workflows/cluster-changesets", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sourceId: "src_ai_sdk" }),
      }),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      clusters: number;
      coverage: number;
    };
    expect(body.clusters).toBe(1);
    expect(body.coverage).toBe(2);

    const rows = await db.select().from(releaseCoverage);
    expect(rows).toHaveLength(2);
    expect(new Set(rows.map((r) => r.canonicalId))).toEqual(new Set(["rel_ai_core"]));
    expect(new Set(rows.map((r) => r.coverageId))).toEqual(new Set(["rel_ai_react", "rel_ai_vue"]));
    expect(rows.every((r) => r.decidedBy === "system:changesets")).toBe(true);
  });

  it("unlinkFirst clears prior system:changesets links and re-clusters from scratch", async () => {
    const db = mkDb();
    await seedCascade(db);
    const fetch = mkApp(db);

    // Run 1: writes 2 system:changesets coverage rows.
    await fetch(
      new Request("https://x.test/v1/workflows/cluster-changesets", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sourceId: "src_ai_sdk" }),
      }),
    );
    const beforeRows = await db.select().from(releaseCoverage);
    expect(beforeRows).toHaveLength(2);

    // Run 2 with unlinkFirst — should delete both system rows, then
    // re-cluster and write them back. Net rows stays at 2 but the response
    // reports the unlink count.
    const res = await fetch(
      new Request("https://x.test/v1/workflows/cluster-changesets", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sourceId: "src_ai_sdk", unlinkFirst: true }),
      }),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      unlinkFirst: boolean;
      unlinkedRows: number;
      clusters: number;
      coverage: number;
    };
    expect(body.unlinkFirst).toBe(true);
    expect(body.unlinkedRows).toBe(2);
    expect(body.clusters).toBe(1);
    expect(body.coverage).toBe(2);

    const finalRows = await db.select().from(releaseCoverage);
    expect(finalRows).toHaveLength(2);
    expect(finalRows.every((r) => r.decidedBy === "system:changesets")).toBe(true);
  });

  it("is idempotent — re-running over already-clustered rows is a no-op", async () => {
    const db = mkDb();
    await seedCascade(db);
    const fetch = mkApp(db);

    await fetch(
      new Request("https://x.test/v1/workflows/cluster-changesets", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sourceId: "src_ai_sdk" }),
      }),
    );
    const res = await fetch(
      new Request("https://x.test/v1/workflows/cluster-changesets", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sourceId: "src_ai_sdk" }),
      }),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { processed: number; coverage: number };
    // Coverage rows from run 1 are excluded by the anti-join, so the second
    // run sees only the canonical (1 row) — too few to form a cluster.
    expect(body.processed).toBe(1);
    expect(body.coverage).toBe(0);

    // The two coverage rows from run 1 should still be there, unchanged.
    const rows = await db.select().from(releaseCoverage);
    expect(rows).toHaveLength(2);
  });
});
