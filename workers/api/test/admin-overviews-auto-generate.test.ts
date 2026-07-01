import { describe, it, expect } from "bun:test";
import type { OverviewManifestResponse } from "@buildinternet/releases-api-types";
import { organizations } from "@buildinternet/releases-core/schema";
import { adminOverviewsRoutes } from "../src/routes/admin-overviews.js";
import { createTestDb as mkDb, createTestApp } from "./setup";

const mkApp = (db: ReturnType<typeof mkDb>) => createTestApp(db, adminOverviewsRoutes);

/**
 * #1795 — the overview manifest must surface `autoGenerateContent` and, in
 * plan mode, flag opted-out curated orgs as `opted_out` so an orchestrator
 * doesn't queue a regen the batch-overview filter will silently skip.
 */
async function seed(db: ReturnType<typeof mkDb>) {
  await db.insert(organizations).values([
    { id: "org_on", slug: "onco", name: "OnCo", discovery: "curated", autoGenerateContent: true },
    {
      id: "org_off",
      slug: "offco",
      name: "OffCo",
      discovery: "curated",
      autoGenerateContent: false,
    },
  ]);
}

describe("GET /v1/admin/overviews — autoGenerateContent surfacing (#1795)", () => {
  it("includes autoGenerateContent on every row", async () => {
    const db = mkDb();
    await seed(db);
    const app = mkApp(db);

    const res = await app(new Request("https://x.test/v1/admin/overviews"));
    expect(res.status).toBe(200);
    const body = (await res.json()) as OverviewManifestResponse;
    const bySlug = new Map(body.items.map((r) => [r.orgSlug, r]));
    expect(bySlug.get("onco")?.autoGenerateContent).toBe(true);
    expect(bySlug.get("offco")?.autoGenerateContent).toBe(false);
  });

  it("marks opted-out orgs as `opted_out` in plan mode", async () => {
    const db = mkDb();
    await seed(db);
    const app = mkApp(db);

    const res = await app(new Request("https://x.test/v1/admin/overviews?format=plan"));
    expect(res.status).toBe(200);
    const body = (await res.json()) as OverviewManifestResponse;
    const bySlug = new Map(body.items.map((r) => [r.orgSlug, r]));

    // Opted out → never picked up by the batch, regardless of staleness.
    expect(bySlug.get("offco")?.action).toBe("opted_out");
    // Opted in but no overview yet → the honest "missing" signal.
    expect(bySlug.get("onco")?.action).toBe("missing");
  });
});
