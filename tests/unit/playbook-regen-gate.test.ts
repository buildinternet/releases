import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { eq, and } from "drizzle-orm";
import { createTestDb, type TestDatabase } from "../db-helper.js";
import { organizations, sources, knowledgePages } from "@buildinternet/releases-core/schema";
import { regeneratePlaybook } from "../../workers/api/src/playbook-regen.js";
import type { D1Db } from "../../workers/api/src/db.js";

const asD1 = (db: TestDatabase["db"]): D1Db => db as unknown as D1Db;

let testDb: TestDatabase;

beforeEach(() => {
  testDb = createTestDb();
});

afterEach(() => {
  testDb.cleanup();
});

describe("regeneratePlaybook gate", () => {
  test("does not write a playbook row for on_demand orgs", async () => {
    await testDb.db.insert(organizations).values({
      id: "org_ondemand",
      name: "Ondemand Co",
      slug: "ondemand-co",
      discovery: "on_demand",
    });
    // Seed a source so the function would reach the LLM call if the gate weren't in place.
    await testDb.db.insert(sources).values({
      id: "src_ondemand",
      name: "Ondemand Repo",
      slug: "ondemand-repo",
      type: "github",
      url: "https://github.com/ondemand/repo",
      orgId: "org_ondemand",
      discovery: "on_demand",
    });

    await regeneratePlaybook(asD1(testDb.db), "org_ondemand");

    // Gate proof: no playbook knowledge_pages row was written for this org.
    const playbookRows = await testDb.db
      .select()
      .from(knowledgePages)
      .where(and(eq(knowledgePages.scope, "playbook"), eq(knowledgePages.orgId, "org_ondemand")));
    expect(playbookRows).toHaveLength(0);
  });

  test("returns without writing when org doesn't exist", async () => {
    // Pre-existing behavior — not changed by this task, but verify it still works.
    await expect(regeneratePlaybook(asD1(testDb.db), "org_missing")).resolves.toBeUndefined();
  });
});
