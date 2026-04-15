/**
 * Smoke tests for the /v1/related/* routes.
 *
 * These exercise the request-parsing and graceful-degradation paths of
 * `workers/api/src/routes/related.ts` — the bits that don't require a
 * real D1 + Vectorize pair. End-to-end coverage lives in the CLI suite
 * (when the routes are wired into the remote client) and in staging
 * smoke tests against the deployed worker.
 */

import { describe, test, expect } from "bun:test";
import { Hono } from "hono";
import { relatedRoutes } from "../../workers/api/src/routes/related.js";

// Minimal env shape: the degraded paths never touch DB, so we can pass
// a dummy D1 binding and a missing Vectorize binding and assert the
// graceful-degradation contract. Env is attached via `.fetch(req, env)`
// so we don't depend on a middleware mutating `c.env`.
function buildApp() {
  const app = new Hono<{ Bindings: Record<string, unknown> }>();
  app.route("/", relatedRoutes as unknown as Hono<{ Bindings: Record<string, unknown> }>);
  return app;
}

function call(
  path: string,
  env: Record<string, unknown> = {},
): Promise<Response> {
  const app = buildApp();
  return app.fetch(
    new Request(`http://local${path}`),
    {
      DB: {} as unknown,
      RELEASES_INDEX: undefined,
      ENTITIES_INDEX: undefined,
      ...env,
    },
  );
}

describe("GET /related/releases", () => {
  test("400 when `release` is missing", async () => {
    const res = await call("/related/releases");
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("bad_request");
  });

  test("degrades gracefully when RELEASES_INDEX is missing", async () => {
    const res = await call("/related/releases?release=rel_abc");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { degraded: boolean; items: unknown[] };
    expect(body.degraded).toBe(true);
    expect(body.items).toEqual([]);
  });

  test("degrades when the index has no getByIds method", async () => {
    const res = await call("/related/releases?release=rel_abc", {
      // Legacy Vectorize binding — no `getByIds`.
      RELEASES_INDEX: { query: async () => ({ matches: [] }) },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { degraded: boolean };
    expect(body.degraded).toBe(true);
  });
});

describe("GET /related/sources", () => {
  test("400 when `source` is missing", async () => {
    const res = await call("/related/sources");
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("bad_request");
  });

  test("degrades when ENTITIES_INDEX is missing", async () => {
    const res = await call("/related/sources?source=next-js");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { degraded: boolean; items: unknown[] };
    expect(body.degraded).toBe(true);
    expect(body.items).toEqual([]);
  });
});
