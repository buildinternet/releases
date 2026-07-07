import { describe, it, expect } from "bun:test";
import { eq } from "drizzle-orm";
import { domainDemand, organizations } from "@buildinternet/releases-core/schema";
import { lookupRoutes } from "../src/routes/lookups.js";
import { createTestDb, createTestApp } from "./setup";

function makeExecutionCtx() {
  const pending: Promise<unknown>[] = [];
  const executionCtx = {
    waitUntil: (p: Promise<unknown>) => {
      pending.push(p);
    },
    passThroughOnException: () => {},
  } as unknown as ExecutionContext;
  return { executionCtx, drain: () => Promise.all(pending) };
}

describe("/v1/lookups/by-domain demand capture", () => {
  it("records a demand row on a 404 miss", async () => {
    const db = createTestDb();
    const { executionCtx, drain } = makeExecutionCtx();
    const app = createTestApp(db, lookupRoutes, { executionCtx });
    const res = await app(
      new Request("https://x/v1/lookups/by-domain?domain=unlisted-example.com"),
    );
    expect(res.status).toBe(404);
    await drain();
    const [row] = await db
      .select()
      .from(domainDemand)
      .where(eq(domainDemand.domain, "unlisted-example.com"));
    expect(row?.hitCount).toBe(1);
  });

  it("records nothing when the domain resolves", async () => {
    const db = createTestDb();
    await db
      .insert(organizations)
      .values({ id: "org_acme", name: "Acme", slug: "acme", domain: "acme.com" });
    const { executionCtx, drain } = makeExecutionCtx();
    const app = createTestApp(db, lookupRoutes, { executionCtx });
    const res = await app(new Request("https://x/v1/lookups/by-domain?domain=acme.com"));
    expect(res.status).toBe(200);
    await drain();
    const rows = await db.select().from(domainDemand);
    expect(rows.length).toBe(0);
  });
});
