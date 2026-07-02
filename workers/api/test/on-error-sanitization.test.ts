/**
 * Verifies that the global onError handler in workers/api/src/index.ts
 * returns a generic message on unhandled (non-HTTPException) 500s and
 * does NOT leak the raw Error.message to the caller (#advisor-003).
 */
import { describe, it, expect } from "bun:test";
import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { respondError } from "../src/lib/error-response";

// Build a minimal app that wires the REAL `respondError` boundary serializer
// as `onError`, exactly like `workers/api/src/index.ts` does. This exercises
// the production handler directly rather than a hand-copied stand-in, so
// there is nothing here that can drift from the source.
function makeApp() {
  const app = new Hono();

  app.onError((err, c) => respondError(c, err));

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

  it("returns the nested internal_error envelope", async () => {
    const res = await app.fetch(new Request("https://x.test/throw-plain"));
    const body = (await res.json()) as { error: { code: string; type: string; message: string } };
    expect(body.error.code).toBe("internal_error");
    expect(body.error.type).toBe("internal");
    expect(body.error.message).toBe("Internal server error");
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
    // Known gap (tracked as a Phase-3 follow-up): 422 is off the
    // status->type map (TYPE_BY_STATUS in packages/core/src/errors.ts), so
    // statusToType() falls back to "internal" while respondError still
    // preserves the real 422 status. Consumers currently see a mismatched
    // type/status pair for this and any other off-map HTTPException status;
    // decoding that gap for consumers is deferred to Phase 4. The two
    // assertions below pin the CURRENT actual behavior so a future change
    // to the map (or to this fallback) can't silently drift without a
    // failing test here.
    expect(res.status).toBe(422);
    const body = (await res.json()) as { error: { code: string; type: string; message: string } };
    expect(body.error.type).toBe("internal");
    expect(body.error.message).toBe("unprocessable entity detail");
  });
});
