import { describe, it, expect } from "bun:test";
import { Hono } from "hono";
import { dbHealthCheck } from "../src/middleware/db-health.js";

/**
 * The db-health middleware gates every request behind an "are D1 migrations
 * applied?" probe. Its 503 now carries the standardized nested error envelope
 * (#1830 item 3) with the stable `database_not_initialized` code and the setup
 * steps in `details.setup` — the exact contract the web transport
 * (`apps/web/src/lib/api.ts`) decodes to show the operator how to migrate.
 */
type Bindings = { DB: D1Database };

const app = new Hono<{ Bindings: Bindings }>();
app.use("*", dbHealthCheck);
app.get("/ping", (c) => c.json({ ok: true }));

/** Probe `sources` with a fake D1 whose `.first()` runs `first`. */
async function ping(first: () => unknown): Promise<Response> {
  const DB = { prepare: () => ({ first: async () => first() }) } as unknown as D1Database;
  return app.request("http://x/ping", {}, { DB });
}

async function expectSetupEnvelope(res: Response): Promise<void> {
  expect(res.status).toBe(503);
  const body = (await res.json()) as {
    error: { code: string; type: string; message: string; details?: { setup?: unknown } };
  };
  expect(body.error.code).toBe("database_not_initialized");
  expect(body.error.type).toBe("unavailable");
  expect(body.error.message).toContain("D1 database");
  expect(Array.isArray(body.error.details?.setup)).toBe(true);
  expect((body.error.details!.setup as string[]).join("\n")).toContain("db:migrate:local");
}

describe("dbHealthCheck middleware", () => {
  it("returns the nested envelope when the sources table is missing", async () => {
    await expectSetupEnvelope(await ping(() => null));
  });

  it("returns the nested envelope when the probe query throws", async () => {
    await expectSetupEnvelope(
      await ping(() => {
        throw new Error("no such table: sources");
      }),
    );
  });

  it("returns a retryable 503 for a transient D1 error and does not latch readiness", async () => {
    let calls = 0;
    const DB = {
      prepare: () => ({
        first: async () => {
          calls++;
          throw new Error("D1_ERROR: D1 DB is overloaded. Requests queued for too long.");
        },
      }),
    } as unknown as D1Database;

    const res = await app.request("http://x/ping", {}, { DB });
    // Known transient errors are retried once, then still fail closed as 503.
    expect(calls).toBe(2);
    expect(res.status).toBe(503);
    expect(res.headers.get("Retry-After")).toBe("10");
    const body = (await res.json()) as { error: { code: string; message: string } };
    expect(body.error.code).toBe("service_unavailable");
    expect(body.error.message.toLowerCase()).toContain("temporarily unavailable");

    // The failure must not latch dbReady — a later missing-table probe still
    // returns the setup envelope.
    await expectSetupEnvelope(await ping(() => null));
  });
});
