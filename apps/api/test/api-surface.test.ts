import { describe, expect, test } from "bun:test";
import { Hono } from "hono";
import type { Env } from "../src/index.js";
import { mountV1Routes } from "../src/v1-routes.js";
import { PUBLIC_OPERATIONS, openapiToHonoPath, routeVisibility } from "../src/api-surface.js";

type Operation = { security?: unknown[]; "x-releases-visibility"?: string };
type Spec = { paths?: Record<string, Record<string, Operation>> };

async function specFor(environment: string): Promise<Spec> {
  const v1 = new Hono<Env>();
  mountV1Routes(v1);
  const app = new Hono<Env>();
  app.route("/v1", v1);
  const response = await app.fetch(
    new Request("https://api.example.test/v1/openapi.json"),
    { ENVIRONMENT: environment },
    { waitUntil() {}, passThroughOnException() {} } as unknown as ExecutionContext,
  );
  expect(response.status).toBe(200);
  return (await response.json()) as Spec;
}

function operations(spec: Spec): Array<[string, Operation]> {
  return Object.entries(spec.paths ?? {}).flatMap(([path, item]) =>
    Object.entries(item).map(
      ([method, op]) =>
        [`${method.toUpperCase()} ${openapiToHonoPath(path)}`, op] as [string, Operation],
    ),
  );
}

describe("public API surface", () => {
  test("production spec contains exactly the public operations", async () => {
    const keys = operations(await specFor("production")).map(([key]) => key);
    expect(keys.toSorted()).toEqual(Object.keys(PUBLIC_OPERATIONS).toSorted());
  });

  test("production spec drops admin routes that used to leak in", async () => {
    const spec = await specFor("production");
    expect(spec.paths?.["/ai/models"]).toBeUndefined();
    expect(spec.paths?.["/admin/marketing-classifier"]).toBeUndefined();
    expect(spec.paths?.["/tokens"]).toBeUndefined();
    expect(spec.paths?.["/site-notice"]?.put).toBeUndefined();
    expect(spec.paths?.["/site-notice"]?.get).toBeDefined();
  });

  test("public operations declare security from the surface list", async () => {
    const byKey = new Map(operations(await specFor("production")));
    expect(byKey.get("GET /releases/latest")?.security).toEqual([{}, { bearerAuth: [] }]);
    expect(byKey.get("POST /me/webhooks")?.security).toEqual([{ bearerAuth: [] }]);
  });

  test("staging keeps internal operations and tags visibility", async () => {
    const byKey = new Map(operations(await specFor("staging")));
    expect(byKey.get("GET /releases/latest")?.["x-releases-visibility"]).toBe("public");
    expect(byKey.get("PUT /site-notice")?.["x-releases-visibility"]).toBe("internal");
  });

  test("routeVisibility falls back to internal prefixes and flags the unknown", () => {
    expect(routeVisibility("GET", "/orgs")).toBe("public");
    expect(routeVisibility("POST", "/orgs")).toBe("internal");
    expect(routeVisibility("GET", "/admin/users")).toBe("internal");
    expect(routeVisibility("DELETE", "/tokens/me")).toBe("public");
    expect(routeVisibility("GET", "/brand-new-thing")).toBeNull();
  });
});
