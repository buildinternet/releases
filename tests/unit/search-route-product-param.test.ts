/**
 * Smoke tests for the `?product=` parameter on `GET /v1/search` (#1218).
 *
 * Tests drive the Hono sub-app with a real SQLite test database (same
 * approach used in other route smoke tests) so drizzle queries can run.
 * Covers:
 *  - missing `q` → 400 bad_request  (pre-existing gate, unchanged)
 *  - bare slug → 400 bad_request    (new gate added by this PR)
 *  - unknown prod_ ID → 200, productStatus: "not_found"
 *  - unknown orgSlug/productSlug → 200, productStatus: "not_found"
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import type { D1Database } from "@cloudflare/workers-types";
import { createTestDb, type TestDatabase } from "../db-helper.js";
import { searchRoutes } from "../../workers/api/src/routes/search.js";

let testDb: TestDatabase;

beforeEach(() => {
  testDb = createTestDb();
});

afterEach(() => {
  testDb.cleanup();
});

const noopCtx = {
  waitUntil: () => {},
  passThroughOnException: () => {},
};

function makeEnv() {
  return {
    DB: testDb.db as unknown as D1Database,
    MEDIA_ORIGIN: "",
    // No RELEASES_INDEX, ENTITIES_INDEX, EMBED_CACHE, RELEASES_API_KEY, etc.
    // The 400-path tests and miss-path tests never reach those bindings.
  };
}

function call(path: string): Promise<Response> {
  return Promise.resolve(
    searchRoutes.request(`/search${path}`, { method: "GET" }, makeEnv() as never, noopCtx as never),
  );
}

describe("GET /search ?product= validation (#1218)", () => {
  test("missing q → 400 bad_request (pre-existing gate unaffected)", async () => {
    const res = await call("");
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("bad_request");
  });

  test("bare slug → 400 bad_request", async () => {
    const res = await call("?q=webhooks&product=nextjs");
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { code: string; message: string } };
    expect(body.error.code).toBe("bad_request");
    expect(body.error.message).toContain("typed ID");
  });

  test("prod_ ID passes gate and returns 200 with productStatus not_found when product missing", async () => {
    const res = await call("?q=webhooks&product=prod_doesnotexist");
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.productStatus).toBe("not_found");
    expect(body.product).toBe("prod_doesnotexist");
    expect(body.releases).toEqual([]);
  });

  test("orgSlug/productSlug coordinate passes gate and returns 200 with productStatus not_found when product missing", async () => {
    const res = await call("?q=webhooks&product=vercel/next-js");
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.productStatus).toBe("not_found");
    expect(body.releases).toEqual([]);
  });
});
