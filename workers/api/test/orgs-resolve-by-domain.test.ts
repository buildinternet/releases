/**
 * GET /v1/orgs/:slug (#2029): resolution must also match the org's primary
 * `organizations.domain` column, not just id/slug/domain_aliases. A genuine
 * miss on a domain-shaped identifier records demand the same way
 * GET /v1/lookups/by-domain does.
 */
import { describe, it, expect } from "bun:test";
import { eq } from "drizzle-orm";
import { domainDemand, organizations, domainAliases } from "@buildinternet/releases-core/schema";
import { orgRoutes } from "../src/routes/orgs.js";
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

describe("GET /v1/orgs/:slug — domain resolution", () => {
  it("resolves by primary domain", async () => {
    const db = createTestDb();
    await db
      .insert(organizations)
      .values({ id: "org_acme", slug: "acme", name: "Acme", domain: "acme.com" });
    const fetch = createTestApp(db, [orgRoutes], { env: {} });

    const res = await fetch(new Request("https://x.test/v1/orgs/acme.com"));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { slug: string };
    expect(body.slug).toBe("acme");
  });

  it("still resolves by slug and by domain alias", async () => {
    const db = createTestDb();
    await db
      .insert(organizations)
      .values({ id: "org_acme", slug: "acme", name: "Acme", domain: "acme.com" });
    await db.insert(domainAliases).values({ orgId: "org_acme", domain: "acme.io" });
    const fetch = createTestApp(db, [orgRoutes], { env: {} });

    const bySlug = await fetch(new Request("https://x.test/v1/orgs/acme"));
    expect(bySlug.status).toBe(200);

    const byAlias = await fetch(new Request("https://x.test/v1/orgs/acme.io"));
    expect(byAlias.status).toBe(200);
    const aliasBody = (await byAlias.json()) as { slug: string };
    expect(aliasBody.slug).toBe("acme");
  });

  it("records demand on a domain-shaped miss and still 404s", async () => {
    const db = createTestDb();
    const { executionCtx, drain } = makeExecutionCtx();
    const fetch = createTestApp(db, [orgRoutes], { env: {}, executionCtx });

    const res = await fetch(new Request("https://x.test/v1/orgs/unlisted-example.com"));
    expect(res.status).toBe(404);
    await drain();

    const [row] = await db
      .select()
      .from(domainDemand)
      .where(eq(domainDemand.domain, "unlisted-example.com"));
    expect(row?.hitCount).toBe(1);
  });

  it("does not record demand for a plain (non-domain-shaped) slug miss", async () => {
    const db = createTestDb();
    const { executionCtx, drain } = makeExecutionCtx();
    const fetch = createTestApp(db, [orgRoutes], { env: {}, executionCtx });

    const res = await fetch(new Request("https://x.test/v1/orgs/nonexistent-slug"));
    expect(res.status).toBe(404);
    await drain();

    const rows = await db.select().from(domainDemand);
    expect(rows.length).toBe(0);
  });
});
