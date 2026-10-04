/**
 * Inbound provider webhooks are POST /v1/webhooks/<provider>. Production
 * mounts the admin `/webhooks` gate and the workspace session gate before
 * the receivers. A configured Firecrawl token (no user session, no admin
 * Bearer) must reach the webhook handler. A missing or wrong token is
 * rejected by that handler. The old /v1/integrations/... paths are not
 * aliases. Subscription CRUD on /v1/webhooks stays admin-gated.
 */
import { describe, expect, it } from "bun:test";
import { Hono } from "hono";
import {
  authMiddleware,
  tokensAuthMiddleware,
  webhooksAuthMiddleware,
} from "../src/middleware/auth.js";
import { adminRoutes } from "../src/route-namespaces.js";
import { mountV1Routes } from "../src/v1-routes.js";
import { createTestDb } from "./setup";

const WEBHOOK_PATH = "/v1/webhooks/firecrawl";
/** Fixture only — not a deployed secret. */
const WEBHOOK_TOKEN = "test-firecrawl-webhook-token";
const ROOT_KEY = "test-root-api-key";

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
  for (const r of adminRoutes) {
    const mw =
      r === "tokens"
        ? tokensAuthMiddleware
        : r === "webhooks"
          ? webhooksAuthMiddleware
          : authMiddleware;
    v1.use(`/${r}`, mw);
    v1.use(`/${r}/*`, mw);
  }
  // oxlint-disable-next-line no-explicit-any
  mountV1Routes(v1 as any);
  app.route("/v1", v1);
  const env = {
    DB: createTestDb(),
    ENVIRONMENT: "test",
    // Set so the admin gate does not take the local-dev skip path.
    RELEASES_API_KEY: { get: async () => ROOT_KEY },
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

describe("POST /v1/webhooks/firecrawl through the mounted v1 app", () => {
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

  it("rejects a missing token with the webhook's own 401", async () => {
    const res = await call(WEBHOOK_PATH, post({ type: "monitor.page" }));
    expect(res.status).toBe(401);
    expect(res.headers.get("WWW-Authenticate")).toBeNull();
    const body = await errorBody(res);
    expect(body.error.message).toBe("Authentication required");
    expect(body.error.code).toBe("unauthorized");
  });

  it("rejects a wrong token with the webhook's own 401", async () => {
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
      "/v1/webhooks/github",
      post({ zen: "hi" }, { "X-GitHub-Event": "ping" }),
    );
    expect(res.status).toBe(401);
    expect(res.headers.get("WWW-Authenticate")).toBeNull();
    const body = await errorBody(res);
    expect(body.error.message).toBe("Authentication required");
  });

  it("does not accept the Firecrawl token on the old integrations path", async () => {
    const res = await call(
      "/v1/integrations/firecrawl/webhook",
      post({ type: "monitor.page" }, { "X-Firecrawl-Token": WEBHOOK_TOKEN }),
    );
    expect(res.status).toBe(404);
  });

  it("does not accept a GitHub delivery on the old integrations path", async () => {
    const res = await call(
      "/v1/integrations/github/webhook",
      post({ zen: "hi" }, { "X-GitHub-Event": "ping" }),
    );
    expect(res.status).toBe(404);
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

  it("still requires an admin key for subscription CRUD on /v1/webhooks", async () => {
    const res = await call(
      "/v1/webhooks",
      post({ orgId: "org_1", url: "https://example.com/hook" }),
    );
    expect(res.status).toBe(401);
    expect(res.headers.get("WWW-Authenticate")).toBe('Bearer realm="releases-api"');
    const body = await errorBody(res);
    expect(body.error.message).toBe("Missing API key");
  });

  it("does not treat GET /v1/webhooks/firecrawl as the inbound receiver", async () => {
    const res = await call("/v1/webhooks/firecrawl", { method: "GET" });
    expect(res.status).toBe(401);
    expect(res.headers.get("WWW-Authenticate")).toBe('Bearer realm="releases-api"');
    const body = await errorBody(res);
    expect(body.error.message).toBe("Missing API key");
  });
});
