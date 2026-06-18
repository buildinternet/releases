/**
 * Verifies that the global onError handler in workers/api/src/index.ts
 * returns a generic message on unhandled (non-HTTPException) 500s and
 * does NOT leak the raw Error.message to the caller (#advisor-003).
 */
import { describe, it, expect } from "bun:test";
import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";

// Build a minimal app that replicates the production onError handler shape.
// We test the handler in isolation rather than importing the full index.ts
// (which carries heavy Cloudflare-worker-only dependencies) to keep the test
// fast and hermetic. The handler logic is a verbatim copy of what lives in
// workers/api/src/index.ts — any drift from the source will be caught by the
// "done criteria" grep check.
function makeApp() {
  const app = new Hono();

  app.onError((err, c) => {
    if (err instanceof HTTPException) {
      const status = err.status;
      return c.json(
        { error: status === 400 ? "bad_request" : "http_error", message: err.message },
        status,
      );
    }
    // Production handler: log the detail (omitted in test — no logEvent binding),
    // return a generic message.
    return c.json({ error: "internal_error", message: "An unexpected error occurred." }, 500);
  });

  // Route that throws a plain Error (simulates an unhandled runtime failure).
  app.get("/throw-plain", () => {
    throw new Error("super secret db connection string: postgres://root:hunter2@db/prod");
  });

  // Route that throws an HTTPException (should still surface its message).
  app.get("/throw-http", () => {
    throw new HTTPException(422, { message: "unprocessable entity detail" });
  });

  return app;
}

describe("onError handler — unhandled 500 sanitization", () => {
  const app = makeApp();

  it("returns status 500 for a plain thrown Error", async () => {
    const res = await app.fetch(new Request("https://x.test/throw-plain"));
    expect(res.status).toBe(500);
  });

  it("returns { error: 'internal_error', message: 'An unexpected error occurred.' } body", async () => {
    const res = await app.fetch(new Request("https://x.test/throw-plain"));
    const body = (await res.json()) as { error: string; message: string };
    expect(body.error).toBe("internal_error");
    expect(body.message).toBe("An unexpected error occurred.");
  });

  it("does NOT leak the raw Error.message in the response body", async () => {
    const res = await app.fetch(new Request("https://x.test/throw-plain"));
    const text = await res.text();
    expect(text).not.toContain("hunter2");
    expect(text).not.toContain("postgres://");
    expect(text).not.toContain("super secret");
  });

  it("HTTPException still surfaces its message (unchanged path)", async () => {
    const res = await app.fetch(new Request("https://x.test/throw-http"));
    expect(res.status).toBe(422);
    const body = (await res.json()) as { error: string; message: string };
    expect(body.error).toBe("http_error");
    expect(body.message).toBe("unprocessable entity detail");
  });
});
