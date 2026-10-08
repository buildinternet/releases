/**
 * GET /v1/sources must return the same shape for "filter resolved to nothing"
 * (unknown `?orgSlug=` / `?productSlug=`) as it does for zero matching rows:
 * the `{ items: [], pagination }` envelope under `?envelope=true`, a bare
 * `[]` otherwise. The unknown-org path used to short-circuit with a bare `[]`
 * regardless, which crashed `releases list --org <unknown>` on `items.length`.
 */
import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { organizations, products, sources } from "@buildinternet/releases-core/schema";
import { sourceRoutes } from "../src/routes/sources.js";
import { createTestDb, type TestDatabase } from "../../../tests/db-helper.js";
import { makeCaller } from "./route-test-helpers.js";

let testDb: TestDatabase;

beforeEach(async () => {
  testDb = createTestDb();
  await testDb.db.insert(organizations).values({ id: "org_acme", name: "Acme", slug: "acme" });
  await testDb.db.insert(products).values({
    id: "prod_sdk",
    name: "Acme SDK",
    slug: "acme-sdk",
    orgId: "org_acme",
  });
  await testDb.db.insert(sources).values({
    id: "src_1",
    orgId: "org_acme",
    productId: "prod_sdk",
    name: "Acme Changelog",
    slug: "acme-changelog",
    type: "feed",
    url: "https://acme.example/changelog",
  });
});

afterEach(() => testDb.cleanup());

const call = makeCaller(sourceRoutes, () => ({ DB: testDb.db as unknown as never }));

type Envelope = { items: unknown[]; pagination: Record<string, unknown> };

function expectEmptyEnvelope(body: unknown, pageSize: number) {
  const env = body as Envelope;
  expect(Array.isArray(body)).toBe(false);
  expect(env.items).toEqual([]);
  expect(env.pagination).toMatchObject({
    page: 1,
    pageSize,
    totalItems: 0,
    hasMore: false,
  });
}

describe("GET /v1/sources — unknown filter targets keep the response shape", () => {
  it("known org + envelope=true returns a populated envelope (control)", async () => {
    const res = await call("/sources?orgSlug=acme&limit=5&envelope=true");
    expect(res.status).toBe(200);
    const body = (await res.json()) as Envelope;
    expect(body.items).toHaveLength(1);
    expect(body.pagination).toMatchObject({ page: 1, pageSize: 5, totalItems: 1 });
  });

  it("unknown orgSlug + envelope=true returns an empty envelope, not a bare []", async () => {
    const res = await call("/sources?orgSlug=does-not-exist&limit=5&envelope=true");
    expect(res.status).toBe(200);
    expectEmptyEnvelope(await res.json(), 5);
  });

  it("unknown orgSlug without envelope still returns a bare []", async () => {
    const res = await call("/sources?orgSlug=does-not-exist&limit=5");
    expect(res.status).toBe(200);
    expect((await res.json()) as unknown[]).toEqual([]);
  });

  it("unknown productSlug + envelope=true returns an empty envelope", async () => {
    const res = await call("/sources?productSlug=nope&limit=5&envelope=true");
    expect(res.status).toBe(200);
    expectEmptyEnvelope(await res.json(), 5);
  });

  it("unknown prod_ id + envelope=true returns an empty envelope", async () => {
    const res = await call("/sources?productSlug=prod_missing&limit=5&envelope=true");
    expect(res.status).toBe(200);
    expectEmptyEnvelope(await res.json(), 5);
  });

  it("known org + unknown productSlug + envelope=true returns an empty envelope", async () => {
    const res = await call("/sources?orgSlug=acme&productSlug=nope&limit=5&envelope=true");
    expect(res.status).toBe(200);
    expectEmptyEnvelope(await res.json(), 5);
  });

  it("unknown productSlug without envelope returns a bare []", async () => {
    const res = await call("/sources?productSlug=nope");
    expect(res.status).toBe(200);
    expect((await res.json()) as unknown[]).toEqual([]);
  });
});
