/**
 * Production mounts `workspaceRoutes` (session gate) before the Firecrawl
 * receiver. A caller that only presents `X-Firecrawl-Token` has no user
 * session. The webhook must still reach its own token check: a configured
 * token is accepted, and a missing or wrong token is rejected by that check
 * (`Authentication required`, no WWW-Authenticate) rather than by
 * `requireFollowsPrincipal` (`Sign in required`).
 */
import { describe, expect, it } from "bun:test";
import { Hono } from "hono";
import { mountV1Routes } from "../src/v1-routes.js";
import { createTestDb } from "./setup";

const WEBHOOK_PATH = "/v1/integrations/firecrawl/webhook";
/** Fixture only — not a deployed secret. */
const WEBHOOK_TOKEN = "test-firecrawl-webhook-token";

type ErrorBody = { error: { code: string; type: string; message: string } };
type SkipBody = { ok: boolean; skipped?: string };

function buildApp() {
  const app = new Hono();
  app.use("*", async (c, next) => {
    // No cookie and no Bearer session. The webhook header is not a user credential.
    // @ts-expect-error — test-only context seam, typed on the real Env.
    c.set("betterAuth", {
      api: {
        getSession: async () => null,
      },
    });
    await next();
  });
  const v1 = new Hono();
  // oxlint-disable-next-line no-explicit-any
  mountV1Routes(v1 as any);
  app.route("/v1", v1);
  const env = {
    DB: createTestDb(),
    ENVIRONMENT: "test",
    FIRECRAWL_WEBHOOK_SECRET: { get: async () => WEBHOOK_TOKEN },
  };
  const ctx = { waitUntil: () => {}, passThroughOnException: () => {} };
  return (path: string, init: RequestInit = {}) =>
    app.fetch(new Request(`https://api.test${path}`, init), env, ctx as never);
}

function post(body: unknown, headers: Record<string, string> = {}): RequestInit {
  return {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  };
}

const call = buildApp();

async function errorBody(res: Response): Promise<ErrorBody> {
  return (await res.json()) as ErrorBody;
}

describe("POST /v1/integrations/firecrawl/webhook through the mounted v1 app", () => {
  it("accepts the configured token with no user session when the body has no source id", async () => {
    const res = await call(
      WEBHOOK_PATH,
      post(
        { type: "monitor.page", data: [{ status: "new" }] },
        { "X-Firecrawl-Token": WEBHOOK_TOKEN },
      ),
    );
    expect(res.status).toBe(200);
    expect((await res.json()) as SkipBody).toEqual({ ok: true, skipped: "no_source_id" });
  });

  it("rejects a missing token with the webhook's own 401, not the session gate", async () => {
    const res = await call(WEBHOOK_PATH, post({ type: "monitor.page" }));
    expect(res.status).toBe(401);
    expect(res.headers.get("WWW-Authenticate")).toBeNull();
    const body = await errorBody(res);
    expect(body.error.message).toBe("Authentication required");
    expect(body.error.code).toBe("unauthorized");
  });

  it("rejects a wrong token with the webhook's own 401, not the session gate", async () => {
    const res = await call(
      WEBHOOK_PATH,
      post({ type: "monitor.page" }, { "X-Firecrawl-Token": "not-the-configured-token" }),
    );
    expect(res.status).toBe(401);
    expect(res.headers.get("WWW-Authenticate")).toBeNull();
    const body = await errorBody(res);
    expect(body.error.message).toBe("Authentication required");
    expect(body.error.code).toBe("unauthorized");
  });

  it("lets the GitHub webhook reject a missing signature itself", async () => {
    const res = await call(
      "/v1/integrations/github/webhook",
      post({ zen: "hi" }, { "X-GitHub-Event": "ping" }),
    );
    expect(res.status).toBe(401);
    expect(res.headers.get("WWW-Authenticate")).toBeNull();
    const body = await errorBody(res);
    expect(body.error.message).toBe("Authentication required");
  });

  it("still requires a session on the uploads OAuth callback", async () => {
    const res = await call(
      "/v1/integrations/uploads/callback",
      post({ code: "auth-code", state: "pending-state" }),
    );
    expect(res.status).toBe(401);
    const body = await errorBody(res);
    expect(body.error.message).toBe("Sign in required");
  });
});
