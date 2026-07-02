import { expect, test } from "bun:test";
import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { NotFoundError, ReleasesError } from "@releases/lib/releases-error";
import { BareSlugRejected } from "../utils";
import { respondError } from "./error-response";

function appThrowing(err: unknown) {
  const app = new Hono();
  app.get("/boom", () => {
    throw err;
  });
  app.onError((e, c) => respondError(c, e));
  return app;
}

test("a typed ReleasesError serializes to its envelope + derived status", async () => {
  const res = await appThrowing(new NotFoundError("Source not found")).request("/boom");
  expect(res.status).toBe(404);
  const body = (await res.json()) as { error: { code: string; type: string; message: string } };
  expect(body.error).toEqual({ code: "not_found", type: "not_found", message: "Source not found" });
});

test("BareSlugRejected becomes a validation envelope carrying the entity", async () => {
  const res = await appThrowing(new BareSlugRejected("source", "foo")).request("/boom");
  expect(res.status).toBe(400);
  const body = (await res.json()) as {
    error: { code: string; type: string; details: { entity: string } };
  };
  expect(body.error.code).toBe("bare_slug_rejected");
  expect(body.error.type).toBe("validation");
  expect(body.error.details).toEqual({ entity: "source" });
});

test("HTTPException preserves status + passthrough headers, envelope by status", async () => {
  const res = new Response("x", { status: 429, headers: { "Retry-After": "30" } });
  const out = await appThrowing(new HTTPException(429, { res })).request("/boom");
  expect(out.status).toBe(429);
  expect(out.headers.get("Retry-After")).toBe("30");
  const body = (await out.json()) as { error: { type: string; code: string } };
  expect(body.error.type).toBe("rate_limited");
});

test("a 5xx HTTPException never leaks its message (fail closed, generic)", async () => {
  const out = await appThrowing(
    new HTTPException(503, { message: "secret upstream dsn postgres://u:p@h" }),
  ).request("/boom");
  expect(out.status).toBe(503);
  const body = (await out.json()) as { error: { code: string; type: string; message: string } };
  expect(body.error.type).toBe("unavailable");
  expect(body.error.code).toBe("service_unavailable");
  expect(body.error.message).toBe("Service unavailable");
  expect(JSON.stringify(body)).not.toContain("secret");
});

test("an unmapped 4xx HTTPException(422) derives type/code and surfaces its message", async () => {
  const out = await appThrowing(
    new HTTPException(422, { message: "unprocessable: field x" }),
  ).request("/boom");
  expect(out.status).toBe(422);
  const body = (await out.json()) as { error: { code: string; type: string; message: string } };
  // 422 is off-map → statusToType falls back to `internal`; client-class (<500)
  // so the message is surfaced, but the envelope type/code reflect the fallback.
  expect(body.error.type).toBe("internal");
  expect(body.error.code).toBe("internal_error");
  expect(body.error.message).toBe("unprocessable: field x");
});

test("a malformed-JSON HTTPException(400) uses the invalid_json code", async () => {
  const out = await appThrowing(new HTTPException(400, { message: "Malformed JSON" })).request(
    "/boom",
  );
  expect(out.status).toBe(400);
  const body = (await out.json()) as { error: { code: string; type: string } };
  expect(body.error.code).toBe("invalid_json");
  expect(body.error.type).toBe("validation");
});

test("an unexpected error is a generic 500 that never leaks its message", async () => {
  const out = await appThrowing(new Error("secret dsn postgres://u:p@h")).request("/boom");
  expect(out.status).toBe(500);
  const body = (await out.json()) as { error: { code: string; message: string } };
  expect(body.error.code).toBe("internal_error");
  expect(body.error.message).toBe("Internal server error");
  expect(JSON.stringify(body)).not.toContain("secret");
});

test("a base ReleasesError with an off-map status still responds with that status", async () => {
  // guards the c.json status typing for a variable numeric status
  const res = await appThrowing(new ReleasesError("conflict", "dupe")).request("/boom");
  expect(res.status).toBe(409);
});

test("a classified D1_TOO_MANY_VARIABLES error surfaces the db_too_many_variables code + details", async () => {
  // Real error shape (not mocked): classifyDbError() gates on a D1 footprint
  // token (D1_ERROR/D1 DB/SQLITE_ERROR) before running its matchers, and the
  // too-many-variables matcher fires on "too many SQL variables" — see
  // packages/lib/src/db-errors.ts. This message carries both, so the real
  // classifier resolves it to DB_TOO_MANY_VARIABLES with transient: false.
  const err = new Error("D1_ERROR: too many SQL variables in query");
  const res = await appThrowing(err).request("/boom");
  expect(res.status).toBe(500);
  const body = (await res.json()) as {
    error: { code: string; type: string; message: string; details: unknown };
  };
  expect(body.error.code).toBe("db_too_many_variables");
  expect(body.error.type).toBe("internal");
  expect(body.error.message).toBe("Internal server error");
  expect(body.error.details).toEqual({ dbCode: "DB_TOO_MANY_VARIABLES", transient: false });
});
