import { describe, expect, it } from "bun:test";
import { Hono } from "hono";
import { publicRateLimitMiddleware } from "../src/middleware/rate-limit.js";

describe("publicRateLimitMiddleware", () => {
  it("returns the standard nested error envelope when the anonymous read limit is exceeded", async () => {
    const app = new Hono();
    app.use("*", publicRateLimitMiddleware);
    app.get("/v1/releases/latest", (c) => c.json({ ok: true }));

    const res = await app.request(
      "/v1/releases/latest",
      { headers: { "cf-connecting-ip": "203.0.113.10" } },
      {
        RATE_LIMIT_ENABLED: "true",
        PUBLIC_RATE_LIMITER: { limit: async () => ({ success: false }) },
      } as never,
    );

    expect(res.status).toBe(429);
    const body = (await res.json()) as {
      error: { code: string; type: string; message: string };
    };
    expect(body).toEqual({
      error: {
        code: "rate_limited",
        type: "rate_limited",
        message: "Too many requests. Please retry shortly.",
      },
    });
    expect(res.headers.get("RateLimit-Policy")).toBe('"public";q=120;w=60');
    expect(res.headers.get("RateLimit")).toBe('"public";r=0;t=60');
    expect(res.headers.get("Retry-After")).toBe("60");
  });
});
