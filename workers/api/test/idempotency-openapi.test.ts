import { describe, expect, test } from "bun:test";
import { Hono } from "hono";
import type { Env } from "../src/index.js";
import { mountV1Routes } from "../src/v1-routes.js";

type Operation = {
  description?: string;
  parameters?: Array<{ in?: string; name?: string; required?: boolean; description?: string }>;
  responses?: Record<
    string,
    { description?: string; headers?: Record<string, { description?: string }> }
  >;
};

const IDEMPOTENT_POST_PATHS = [
  "/tokens",
  "/api-keys",
  "/me/webhooks",
  "/me/webhooks/{id}/rotate-secret",
  "/me/webhooks/{id}/test",
  "/webhooks/{id}/test",
  "/recommendations",
  "/feedback",
] as const;

async function idempotencyOperations(): Promise<Array<[string, Operation]>> {
  const v1 = new Hono<Env>();
  mountV1Routes(v1);
  const app = new Hono<Env>();
  app.route("/v1", v1);
  const response = await app.fetch(
    new Request("https://api.example.test/v1/openapi.json"),
    { ENVIRONMENT: "production" },
    { waitUntil() {}, passThroughOnException() {} } as unknown as ExecutionContext,
  );
  expect(response.status).toBe(200);
  const spec = (await response.json()) as { paths?: Record<string, { post?: Operation }> };
  return IDEMPOTENT_POST_PATHS.map((path) => [path, spec.paths?.[path]?.post ?? {}]);
}

describe("idempotent POST OpenAPI contract", () => {
  test("documents the optional 24-hour key contract and replay outcomes for all eight supported routes", async () => {
    for (const [path, operation] of await idempotencyOperations()) {
      const key = operation.parameters?.find(
        (parameter) => parameter.in === "header" && parameter.name === "Idempotency-Key",
      );
      expect(key, path).toBeTruthy();
      expect(key?.required, path).toBe(false);
      expect(`${operation.description} ${key?.description}`, path).toContain("24 hours");
      expect(operation.responses?.["409"], path).toBeTruthy();
      expect(operation.responses?.["503"], path).toBeTruthy();
      const success = Object.entries(operation.responses ?? {}).find(([status]) =>
        status.startsWith("2"),
      )?.[1];
      expect(success?.headers?.["Idempotency-Replayed"], path).toBeTruthy();
    }
  });
});
