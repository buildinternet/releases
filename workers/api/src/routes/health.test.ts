import { describe, it, expect } from "bun:test";
import { Hono } from "hono";
import { healthRoutes } from "./health.js";

// /health only issues a raw `SELECT 1` via env.DB.prepare(...).first(), so a
// tiny fake D1 exercises the handler without a real database. (Importing the
// full worker app would drag in cloudflare:workers exports — route modules are
// tested in isolation, as in firecrawl.test.ts.)
function appWith(db: unknown) {
  const app = new Hono();
  app.route("/", healthRoutes);
  return (path: string) =>
    app.fetch(new Request(`https://api.releases.sh${path}`), { DB: db } as never);
}

const okDb = { prepare: () => ({ first: async () => ({ "1": 1 }) }) };
const failDb = {
  prepare: () => ({
    first: async () => {
      throw new Error("d1 unreachable");
    },
  }),
};

describe("GET /health", () => {
  it("returns 200 + noindex when D1 responds", async () => {
    const res = await appWith(okDb)("/health");
    expect(res.status).toBe(200);
    expect(res.headers.get("X-Robots-Tag")).toBe("noindex, nofollow");
    expect(res.headers.get("Cache-Control")).toBe("no-store");
    const body = (await res.json()) as { ok?: boolean; db?: string };
    expect(body.ok).toBe(true);
    expect(body.db).toBe("ok");
  });

  it("returns 503 when D1 is unreachable", async () => {
    const res = await appWith(failDb)("/health");
    expect(res.status).toBe(503);
    expect(res.headers.get("X-Robots-Tag")).toBe("noindex, nofollow");
    expect(res.headers.get("Cache-Control")).toBe("no-store");
    const body = (await res.json()) as { ok?: boolean };
    expect(body.ok).toBe(false);
  });
});
