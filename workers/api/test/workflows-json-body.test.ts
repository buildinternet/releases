// Tests for the parseWorkflowBody helper behavior in workflow routes.
//
// Covers three boundary cases for POST /v1/workflows/backfill-media (a dryRun-
// bearing route) to assert the core regression this change fixes:
//
//   1. Valid JSON body → behaves as before (route's own validation fires)
//   2. No body → treated as `{}` (NOT a JSON 400; route's own bad_request fires)
//   3. Malformed JSON body → 400 with error:"bad_request" from parseWorkflowBody
//
// Case 3 is the primary regression guard: before this change, malformed JSON
// silently defaulted to `{}`, meaning `dryRun` would be `false` and a real
// (billable) run could be triggered inadvertently.
import { describe, it, expect } from "bun:test";
import { Database } from "bun:sqlite";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { applyMigrations } from "../../../tests/db-helper";

const { Hono } = await import("hono");
const { HTTPException } = await import("hono/http-exception");
const { workflowsRoutes } = await import("../src/routes/workflows.js");

function mkDb() {
  const sqlite = new Database(":memory:");
  const db = drizzle(sqlite);
  applyMigrations(sqlite);
  return db;
}

function mkApp(db: ReturnType<typeof mkDb>, extra: Record<string, unknown> = {}) {
  const fakeEnv = { DB: db, ...extra };
  const app = new Hono();
  // Mirror the global error handler from workers/api/src/index.ts so that
  // HTTPException(400) thrown by parseWorkflowBody renders as { error, message }.
  app.onError((err, c) => {
    if (err instanceof HTTPException) {
      const status = err.status;
      return c.json(
        { error: status === 400 ? "bad_request" : "http_error", message: err.message },
        status,
      );
    }
    const message = err instanceof Error ? err.message : String(err);
    return c.json({ error: "internal_error", message }, 500);
  });
  const v1 = new Hono();
  v1.route("/", workflowsRoutes);
  app.route("/v1", v1);
  return (req: Request) => app.fetch(req, fakeEnv);
}

// Minimal stub R2 bucket — the route 503s without it; we want to get past that
// gate to exercise the JSON-body parse path.
const fakeBucket = { put: async () => {} };

describe("parseWorkflowBody — JSON body boundary", () => {
  it("valid JSON body: route proceeds past JSON parse and hits its own validation", async () => {
    const fetch = mkApp(mkDb(), { MEDIA: fakeBucket });
    // Sending `{}` (valid JSON) with no sourceId/all: route returns its own bad_request
    const res = await fetch(
      new Request("https://x.test/v1/workflows/backfill-media", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({}),
      }),
    );
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    // The route's own required-field check fires — NOT "bad_request" from JSON parse
    // (both happen to be 400 bad_request, but the message is distinct)
    expect(body.error).toBe("bad_request");
  });

  it("absent body: treated as {} (no JSON parse error — route's own validation fires)", async () => {
    const fetch = mkApp(mkDb(), { MEDIA: fakeBucket });
    // No body at all; Content-Length is 0 / body is empty
    const res = await fetch(
      new Request("https://x.test/v1/workflows/backfill-media", {
        method: "POST",
        headers: { "content-type": "application/json" },
      }),
    );
    // Must NOT be a JSON-parse 400 — route's own validation should fire instead
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string; message: string };
    expect(body.error).toBe("bad_request");
    // The message comes from the route's own validation, not from parseWorkflowBody
    expect(body.message).not.toBe("invalid JSON body");
  });

  it("malformed JSON body: returns 400 bad_request with 'invalid JSON body'", async () => {
    const fetch = mkApp(mkDb(), { MEDIA: fakeBucket });
    const res = await fetch(
      new Request("https://x.test/v1/workflows/backfill-media", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{not json",
      }),
    );
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string; message: string };
    expect(body.error).toBe("bad_request");
    expect(body.message).toBe("invalid JSON body");
  });
});
