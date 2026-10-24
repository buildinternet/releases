import { Hono } from "hono";
import type { Env } from "../src/index.js";
import { mountV1Routes } from "../src/v1-routes.js";
import { noopExecutionCtx } from "./route-test-helpers.js";

/**
 * Generate `/v1/openapi.json` for an environment. Production holds only the
 * public surface; staging also documents internal operations.
 */
export async function fetchOpenApiSpec<T>(environment: "production" | "staging"): Promise<T> {
  const v1 = new Hono<Env>();
  mountV1Routes(v1);
  const app = new Hono<Env>();
  app.route("/v1", v1);
  const response = await app.fetch(
    new Request("https://api.example.test/v1/openapi.json"),
    { ENVIRONMENT: environment },
    noopExecutionCtx as unknown as ExecutionContext,
  );
  if (response.status !== 200) throw new Error(`openapi.json returned ${response.status}`);
  return (await response.json()) as T;
}
