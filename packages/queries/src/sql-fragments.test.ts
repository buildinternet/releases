import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { sql } from "drizzle-orm";
import { orgAccounts, organizations } from "@buildinternet/releases-core/schema";
import { createTestDb, type TestDatabase } from "../../../tests/db-helper.js";
import { githubHandleSubquery } from "./sql-fragments.js";

describe("githubHandleSubquery", () => {
  let tdb: TestDatabase;

  beforeAll(async () => {
    tdb = createTestDb();
    await tdb.db.insert(organizations).values([
      { id: "org_multi", name: "Multi", slug: "multi" },
      { id: "org_none", name: "None", slug: "none" },
    ]);
    await tdb.db.insert(orgAccounts).values([
      { orgId: "org_multi", platform: "github", handle: "second", createdAt: "2026-02-01" },
      { orgId: "org_multi", platform: "github", handle: "first", createdAt: "2026-01-01" },
      { orgId: "org_multi", platform: "x", handle: "older-non-github", createdAt: "2025-01-01" },
    ]);
  });
  afterAll(() => tdb.cleanup());

  it("picks the earliest GitHub handle, one row per org", async () => {
    const rows = await tdb.db
      .select({ id: organizations.id, handle: githubHandleSubquery(sql`${organizations.id}`) })
      .from(organizations)
      .orderBy(organizations.id);
    expect(rows).toEqual([
      { id: "org_multi", handle: "first" },
      { id: "org_none", handle: null },
    ]);
  });
});
