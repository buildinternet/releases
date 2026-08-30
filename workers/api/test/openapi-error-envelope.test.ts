import { describe, expect, test } from "bun:test";
import { Hono } from "hono";
import { ERROR_TYPES } from "@buildinternet/releases-core/errors";
import type { Env } from "../src/index.js";
import { mountV1Routes } from "../src/v1-routes.js";

type Response4xx5xx = { description?: string; content?: Record<string, { schema?: unknown }> };
type Operation = { responses?: Record<string, Response4xx5xx> };
type Spec = {
  paths?: Record<string, Record<string, Operation>>;
  components?: { schemas?: Record<string, unknown> };
};

const ERROR_ENVELOPE_REF = { $ref: "#/components/schemas/ErrorEnvelope" };

async function fullSpec(): Promise<Spec> {
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
  return (await response.json()) as Spec;
}

describe("OpenAPI error envelope", () => {
  test("registers a single ErrorEnvelope component matching the standard error shape", async () => {
    const spec = await fullSpec();
    expect(spec.components?.schemas?.ErrorEnvelope).toMatchObject({
      type: "object",
      required: ["error"],
      properties: {
        error: {
          type: "object",
          required: ["code", "type", "message"],
          properties: {
            code: { type: "string" },
            type: { type: "string", enum: ERROR_TYPES },
            message: { type: "string" },
            details: {},
          },
        },
      },
    });
  });

  test("spot-checks known 4xx responses reference the shared component instead of inlining it", async () => {
    const spec = await fullSpec();

    const notFoundOrg = spec.paths?.["/orgs/{slug}"]?.get?.responses?.["404"];
    expect(notFoundOrg?.content?.["application/json"]?.schema, "GET /orgs/{slug} 404").toEqual(
      ERROR_ENVELOPE_REF,
    );

    const invalidBody = spec.paths?.["/site-notice"]?.put?.responses?.["400"];
    expect(invalidBody?.content?.["application/json"]?.schema, "PUT /site-notice 400").toEqual(
      ERROR_ENVELOPE_REF,
    );
  });

  test("no documented response inlines the error envelope's full schema instead of $ref-ing it", async () => {
    const spec = await fullSpec();

    for (const [path, methods] of Object.entries(spec.paths ?? {})) {
      for (const [method, operation] of Object.entries(methods)) {
        for (const [status, response] of Object.entries(operation.responses ?? {})) {
          if (!/^[45]/.test(status)) continue;
          const schema = response.content?.["application/json"]?.schema;
          if (!schema || typeof schema !== "object") continue;
          // Any inlined error envelope has a nested `error` object property with a
          // `code`/`type`/`message` shape — a $ref never carries a `properties` key.
          expect(
            "properties" in schema &&
              "error" in ((schema as { properties?: object }).properties ?? {}),
            `${method.toUpperCase()} ${path} ${status} should $ref ErrorEnvelope, not inline it`,
          ).toBe(false);
        }
      }
    }
  });
});
