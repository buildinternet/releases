import { describe, expect, it } from "bun:test";
import { Hono } from "hono";
import { emailActionRoutes } from "../src/routes/email-actions.js";

const BASE = "https://api.releases.sh";
const URL_PATH = "/email-actions/verify-email?token=tok_1";

type LimiterCall = { key: string };

/**
 * Drives the route with a stub limiter and a stub Better Auth handler. The auth
 * instance is reached through `createAuth(c.env)`, which reads the env — passing
 * a pre-built `auth` here isn't possible, so the tests that need the auth path
 * assert only on what happens BEFORE it (the limiter, the missing-token 404).
 */
function app(env: Record<string, unknown>) {
  const a = new Hono();
  a.route("/", emailActionRoutes);
  return (init?: RequestInit, path = URL_PATH) =>
    a.request(`${BASE}${path}`, { method: "POST", ...init }, env);
}

describe("POST /v1/email-actions/verify-email", () => {
  it("throttles per IP — the route limits itself, since the shared middleware skips POST", async () => {
    const calls: LimiterCall[] = [];
    const res = await app({
      AUTH_RATE_LIMITER: {
        limit: async (o: LimiterCall) => {
          calls.push(o);
          return { success: false };
        },
      },
    })({ headers: { "cf-connecting-ip": "203.0.113.7" } });

    expect(res.status).toBe(429);
    expect(calls).toEqual([{ key: "203.0.113.7" }]);
  });

  it("keys IPv6 callers by /64 so one subnet can't rotate past the cap", async () => {
    const calls: LimiterCall[] = [];
    await app({
      AUTH_RATE_LIMITER: {
        limit: async (o: LimiterCall) => {
          calls.push(o);
          return { success: false };
        },
      },
    })({ headers: { "cf-connecting-ip": "2001:db8:1234:5678:9abc:def0:1234:5678" } });

    expect(calls[0].key).toBe("2001:db8:1234:5678::/64");
  });

  it("honours the AUTH_EDGE_RATE_LIMIT_ENABLED kill switch", async () => {
    let called = false;
    const res = await app({
      AUTH_EDGE_RATE_LIMIT_ENABLED: "false",
      AUTH_RATE_LIMITER: {
        limit: async () => {
          called = true;
          return { success: false };
        },
      },
    })({}, "/email-actions/verify-email");

    expect(called).toBe(false);
    // Limiter skipped, so it falls through to the tokenless 404 rather than 429.
    expect(res.status).toBe(404);
  });

  it("404s a tokenless request without consulting Better Auth", async () => {
    const res = await app({})({}, "/email-actions/verify-email");
    expect(res.status).toBe(404);
  });

  it("is POST-only — Gmail's one-click handler must not be reachable by GET", async () => {
    const a = new Hono();
    a.route("/", emailActionRoutes);
    const res = await a.request(`${BASE}${URL_PATH}`, { method: "GET" }, {});
    expect(res.status).toBe(404);
  });
});
