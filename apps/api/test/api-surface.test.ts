import { describe, expect, test } from "bun:test";
import { PUBLIC_OPERATIONS, routeVisibility, specOperations } from "../src/api-surface.js";
import { fetchOpenApiSpec } from "./openapi-spec-helper.js";

type Spec = { paths?: unknown };

async function operationsFor(environment: "production" | "staging") {
  const spec = await fetchOpenApiSpec<Spec>(environment);
  return new Map(specOperations(spec.paths).map(({ key, op }) => [key, op]));
}

describe("public API surface", () => {
  test("production spec contains exactly the public operations", async () => {
    const keys = [...(await operationsFor("production")).keys()];
    expect(keys.toSorted()).toEqual(Object.keys(PUBLIC_OPERATIONS).toSorted());
  });

  test("public operations declare security from the surface list", async () => {
    const ops = await operationsFor("production");
    expect(ops.get("GET /releases/latest")?.security).toEqual([{}, { bearerAuth: [] }]);
    expect(ops.get("POST /me/webhooks")?.security).toEqual([{ bearerAuth: [] }]);
  });

  test("staging keeps internal operations and tags visibility", async () => {
    const ops = await operationsFor("staging");
    expect(ops.get("GET /releases/latest")?.["x-releases-visibility"]).toBe("public");
    expect(ops.get("PUT /site-notice")?.["x-releases-visibility"]).toBe("internal");
  });

  test("routeVisibility falls back to internal prefixes and flags the unknown", () => {
    expect(routeVisibility("GET", "/orgs")).toBe("public");
    expect(routeVisibility("POST", "/orgs")).toBe("internal");
    expect(routeVisibility("GET", "/admin/users")).toBe("internal");
    expect(routeVisibility("DELETE", "/tokens/me")).toBe("public");
    expect(routeVisibility("GET", "/brand-new-thing")).toBeNull();
  });
});
