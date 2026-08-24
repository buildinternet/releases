import { describe, expect, test } from "bun:test";
import { Hono } from "hono";
import type { Env } from "../src/index.js";
import { mountV1Routes } from "../src/v1-routes.js";

type Operation = {
  description?: string;
  parameters?: Array<{
    in?: string;
    name?: string;
    required?: boolean;
    description?: string;
    schema?: { type?: string; minLength?: number; maxLength?: number; pattern?: string };
  }>;
  responses?: Record<
    string,
    {
      description?: string;
      headers?: Record<
        string,
        { description?: string; schema?: { type?: string; enum?: string[] } }
      >;
      content?: Record<string, { schema?: unknown }>;
    }
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

const IDEMPOTENT_SUCCESS_STATUS: Record<(typeof IDEMPOTENT_POST_PATHS)[number], string> = {
  "/tokens": "201",
  "/api-keys": "201",
  "/me/webhooks": "201",
  "/me/webhooks/{id}/rotate-secret": "200",
  "/me/webhooks/{id}/test": "200",
  "/webhooks/{id}/test": "200",
  "/recommendations": "202",
  "/feedback": "202",
};

async function idempotencySpec(): Promise<{ paths?: Record<string, { post?: Operation }> }> {
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
  return (await response.json()) as { paths?: Record<string, { post?: Operation }> };
}

describe("idempotent POST OpenAPI contract", () => {
  test("advertises the key contract on exactly the eight approved POST operations", async () => {
    const spec = await idempotencySpec();
    const advertisedPaths = Object.entries(spec.paths ?? {})
      .filter(([, path]) =>
        path.post?.parameters?.some(
          (parameter) => parameter.in === "header" && parameter.name === "Idempotency-Key",
        ),
      )
      .map(([path]) => path)
      .toSorted();

    expect(advertisedPaths).toEqual([...IDEMPOTENT_POST_PATHS].toSorted());
  });

  test("documents key constraints, per-route success statuses, replay, and standard errors", async () => {
    const spec = await idempotencySpec();

    for (const path of IDEMPOTENT_POST_PATHS) {
      const operation = spec.paths?.[path]?.post ?? {};
      const key = operation.parameters?.find(
        (parameter) => parameter.in === "header" && parameter.name === "Idempotency-Key",
      );
      expect(key, path).toBeTruthy();
      expect(key?.required, path).toBe(false);
      expect(`${operation.description} ${key?.description}`, path).toContain("24 hours");
      expect(key?.schema, path).toEqual({
        type: "string",
        minLength: 16,
        maxLength: 255,
        pattern: "^[\\x21-\\x7e]+$",
      });

      const responses = operation.responses ?? {};
      const success = responses[IDEMPOTENT_SUCCESS_STATUS[path]];
      expect(success, path).toBeTruthy();
      expect(success?.headers?.["Idempotency-Replayed"]?.schema, path).toEqual({
        type: "string",
        enum: ["true"],
      });
      expect(responses["409"]?.content?.["application/json"]?.schema, path).toBeTruthy();
      expect(responses["503"]?.content?.["application/json"]?.schema, path).toBeTruthy();
    }
  });
});
