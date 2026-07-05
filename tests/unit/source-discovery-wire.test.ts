/**
 * Asserts that the `discovery` column flows through the source list query
 * helpers. The web app's badge split (#684) and the Promote source CTA
 * (#686) both depend on this field reaching `SourceListItem` /
 * `SourceWithStats` consumers — drop it from the SELECT in
 * `getOrgSourcesWithStats` or `getSourcesWithStats` and the wire goes
 * silently back to "everything looks curated."
 */

import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { createTestDb, type TestDatabase } from "../db-helper.js";
import { organizations, sources } from "@buildinternet/releases-core/schema";
import { getOrgSourcesWithStats } from "../../workers/api/src/queries/orgs.js";
import { getSourcesWithStats } from "../../workers/api/src/queries/sources.js";

let tdb: TestDatabase;

beforeAll(async () => {
  tdb = createTestDb();
  const db = tdb.db;

  await db.insert(organizations).values([
    { id: "org_curated", name: "Curated Org", slug: "curated-org", discovery: "curated" },
    { id: "org_ondemand", name: "On Demand Org", slug: "on-demand-org", discovery: "on_demand" },
  ]);

  await db.insert(sources).values([
    {
      id: "src_curated",
      orgId: "org_curated",
      name: "curated-src",
      slug: "curated-src",
      type: "github",
      url: "https://github.com/curated/src",
      discovery: "curated",
    },
    {
      id: "src_ondemand_visible",
      orgId: "org_curated",
      name: "ondemand-src",
      slug: "ondemand-src",
      type: "github",
      url: "https://github.com/curated/ondemand",
      discovery: "on_demand",
      isHidden: false,
    },
    {
      id: "src_ondemand_org",
      orgId: "org_ondemand",
      name: "ondemand-org-src",
      slug: "ondemand-org-src",
      type: "github",
      url: "https://github.com/ondemand/src",
      discovery: "on_demand",
      isHidden: true,
    },
    {
      // Hidden source under org_curated — must be excluded from the public
      // getOrgSourcesWithStats (sources_visible) result.
      id: "src_curated_hidden",
      orgId: "org_curated",
      name: "curated-hidden-src",
      slug: "curated-hidden-src",
      type: "github",
      url: "https://github.com/curated/hidden",
      discovery: "on_demand",
      isHidden: true,
    },
  ]);
});

afterAll(() => tdb.cleanup());

describe("source discovery wire", () => {
  it("getOrgSourcesWithStats returns discovery for each row", async () => {
    const rows = await getOrgSourcesWithStats(tdb.db as never, "org_curated");
    const byId = new Map(rows.map((r) => [r.id, r]));
    expect(byId.get("src_curated")?.discovery).toBe("curated");
    expect(byId.get("src_ondemand_visible")?.discovery).toBe("on_demand");
    expect(byId.get("src_ondemand_visible")?.is_hidden).toBe(0);
    // Query targets sources_visible — the hidden source is excluded outright.
    expect(byId.has("src_curated_hidden")).toBe(false);
  });

  it("getSourcesWithStats (sources_active includeHidden) returns discovery", async () => {
    const rows = await getSourcesWithStats(tdb.db as never, undefined, { includeHidden: true });
    const ondemand = rows.find((r) => r.id === "src_ondemand_org");
    expect(ondemand?.discovery).toBe("on_demand");
    expect(ondemand?.is_hidden).toBe(1);
  });
});
