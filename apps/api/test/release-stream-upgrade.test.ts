import { describe, expect, it } from "bun:test";
import { Hono } from "hono";
import { apiCorsMiddleware } from "../src/auth/index.js";
import { cacheControl, cacheDefaultDeny } from "../src/middleware/cache.js";
import { varyOnAccept } from "../src/middleware/content-negotiation.js";
import { blockIndexing } from "../src/middleware/indexing.js";
import { securityHeaders } from "../src/middleware/security-headers.js";
import { streamRoutes } from "../src/routes/stream.js";

/** Stand-in for the Workers runtime, which freezes headers on a 101. */
function denyImmutableHeaders(): never {
  throw new TypeError("Can't modify immutable headers.");
}

/**
 * Workers freezes headers on a 101 WebSocket upgrade. Bun's Headers stay
 * mutable, so stand in for that guard: any set/append/delete throws the same
 * TypeError the runtime throws. A middleware that forgets the 101 skip fails
 * this test with a 500 instead of the upgrade.
 */
function immutableUpgrade(): Response {
  const res = new Response(null, { status: 101 });
  const headers = res.headers;
  const immutable = new Proxy(headers, {
    get(target, prop, receiver) {
      if (prop === "set" || prop === "append" || prop === "delete") return denyImmutableHeaders;
      const value = Reflect.get(target, prop, receiver);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  Object.defineProperty(res, "headers", { configurable: true, get: () => immutable });
  return res;
}

describe("GET /releases/stream WebSocket upgrade", () => {
  it("returns 101 when upgrade headers are immutable", async () => {
    // Same header-writing middleware as apps/api/src/index.ts. The bare
    // `/releases/:id` mount is intentional: production narrows that pattern to
    // `rel_…` so it misses `/releases/stream`, and this test still hits it so
    // a missing 101 skip fails the upgrade.
    const app = new Hono();
    app.onError((err, c) => c.text(err.message, 500));
    app.use("*", cacheDefaultDeny());
    app.use("*", apiCorsMiddleware());
    app.use("*", blockIndexing());
    app.use("*", securityHeaders());
    app.use(
      "/releases/:id",
      cacheControl(60, { staleWhileRevalidate: 30, isPublic: true }),
      varyOnAccept(),
    );
    app.route("/", streamRoutes);

    const res = await app.request(
      "http://api.test/releases/stream",
      { headers: { Upgrade: "websocket", Origin: "https://releases.sh" } },
      {
        ENVIRONMENT: "production",
        // Staging stamps X-Robots-Tag on every response; that write must skip 101 too.
        INDEXING_DISABLED: "true",
        RELEASE_HUB: {
          idFromName: () => "global",
          get: () => ({ fetch: async () => immutableUpgrade() }),
        },
      },
    );

    expect(res.status).toBe(101);
    expect(await res.text()).toBe("");
  });
});
