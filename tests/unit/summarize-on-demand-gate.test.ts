import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { createTestDb, type TestDatabase } from "../db-helper.js";
import { workflowsRoutes } from "../../workers/api/src/routes/workflows.js";
import { organizations } from "@buildinternet/releases-core/schema";

let testDb: TestDatabase;

beforeEach(() => {
  testDb = createTestDb();
});

afterEach(() => {
  testDb.cleanup();
});

function makeEnv() {
  return {
    DB: testDb.db as unknown as never,
    // Fake secret binding — key must resolve so the handler reaches the org check.
    ANTHROPIC_API_KEY: { get: async () => "sk-ant-test-key" } as unknown as never,
  };
}

async function callSummarize(env: ReturnType<typeof makeEnv>, body: unknown): Promise<Response> {
  return workflowsRoutes.request(
    "/workflows/summarize",
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    },
    env,
  );
}

describe("POST /workflows/summarize — on_demand gate", () => {
  test("returns 422 for on_demand org without calling Anthropic", async () => {
    await testDb.db.insert(organizations).values({
      id: "org_ondemand",
      name: "On-Demand Co",
      slug: "on-demand-co",
      discovery: "on_demand",
    });

    // If the gate is missing, callAnthropic will throw (no real key / no fetch
    // mock) and the test would fail with an upstream error, not a 422.
    const res = await callSummarize(makeEnv(), { org: "on-demand-co" });
    expect(res.status).toBe(422);
    const body = (await res.json()) as { error: string; message: string };
    expect(body.error).toBe("not_supported");
  });

  test("does not gate curated orgs (proceeds past the check)", async () => {
    await testDb.db.insert(organizations).values({
      id: "org_curated",
      name: "Curated Co",
      slug: "curated-co",
      discovery: "curated",
    });

    // No releases seeded — handler reaches the "no releases found" early-exit
    // (200 with summary: null) rather than ever calling Anthropic. That is the
    // observable difference: a curated org with no releases returns 200, not 422.
    const res = await callSummarize(makeEnv(), { org: "curated-co" });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { summary: null; releaseCount: number };
    expect(body.summary).toBeNull();
    expect(body.releaseCount).toBe(0);
  });
});
