import { describe, expect, test } from "bun:test";
import { Hono } from "hono";
import type { Env } from "../src/index.js";
import { mountV1Routes } from "../src/v1-routes.js";
import { noopExecutionCtx } from "./route-test-helpers.js";

async function getDocs(env: Partial<Env["Bindings"]>) {
  const v1 = new Hono<Env>();
  mountV1Routes(v1);
  const app = new Hono<Env>();
  app.route("/v1", v1);
  return app.fetch(
    new Request("https://api.example.test/v1/docs"),
    env,
    noopExecutionCtx as unknown as ExecutionContext,
  );
}

describe("GET /v1/docs", () => {
  test("permanently redirects to the web API reference", async () => {
    const res = await getDocs({ ENVIRONMENT: "production" });
    expect(res.status).toBe(301);
    expect(res.headers.get("location")).toBe("https://releases.sh/docs/api/reference");
  });

  test("follows WEB_BASE_URL", async () => {
    const res = await getDocs({ WEB_BASE_URL: "https://staging.example.test" });
    expect(res.headers.get("location")).toBe("https://staging.example.test/docs/api/reference");
  });
});
