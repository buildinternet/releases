import { expect, test } from "bun:test";
import { ERROR_CODES } from "@buildinternet/releases-core/errors";
import { errorEnvelopeSchema, decodeApiError } from "@buildinternet/releases-api-types";
import {
  ReleasesError,
  isReleasesError,
  NotFoundError,
  InternalError,
  RateLimitedError,
  UpstreamError,
  ConflictError,
  ServiceUnavailableError,
  ValidationError,
} from "./releases-error";

test("a subclass sets code/type and derives status from type", () => {
  const e = new NotFoundError("Source not found");
  expect(e.type).toBe("not_found");
  expect(e.code).toBe("not_found");
  expect(e.status).toBe(404);
  expect(isReleasesError(e)).toBe(true);
  expect(e).toBeInstanceOf(Error);
});

test("toWire round-trips through the api-types schema + decode (invariant 4)", () => {
  const e = new NotFoundError("Source not found", {
    code: "not_found",
    details: { id: "src_1" },
  });
  const wire = e.toWire();
  expect(errorEnvelopeSchema.safeParse(wire).success).toBe(true);
  expect(decodeApiError(wire)).toEqual({
    code: "not_found",
    type: "not_found",
    message: "Source not found",
    details: { id: "src_1" },
  });
});

test("expose=false emits a generic message, never the raw one", () => {
  const e = new InternalError("secret dsn postgres://user:pw@host leaked");
  const wire = e.toWire();
  expect(wire.error.message).toBe("Internal server error");
  expect(wire.error.message).not.toContain("secret");
});

test("details are omitted from the wire when absent", () => {
  const wire = new RateLimitedError("slow down").toWire();
  expect("details" in wire.error).toBe(false);
});

test("the base carries a cause and is instanceof Error", () => {
  const cause = new Error("root");
  const e = new ReleasesError("internal", "wrap", { cause });
  expect(e.cause).toBe(cause);
  expect(e).toBeInstanceOf(Error);
});

test("a direct base instance defaults to a registry code, never the bare type", () => {
  // Types whose canonical code differs from the type string — the old
  // `type as ErrorCode` cast would have emitted an invalid code here.
  const validation = new ReleasesError("validation", "bad");
  expect(validation.code).toBe("validation_failed");

  const upstream = new ReleasesError("upstream", "down");
  expect(upstream.code).toBe("upstream_error");

  const unavailable = new ReleasesError("unavailable", "maint");
  expect(unavailable.code).toBe("service_unavailable");

  for (const type of ["validation", "upstream", "unavailable", "not_found", "internal"] as const) {
    expect(ERROR_CODES).toContain(new ReleasesError(type, "x").code);
  }
});

test("InternalError/UpstreamError ignore an expose:true override (no raw-message leak)", () => {
  const internal = new InternalError("secret dsn postgres://u:p@h", { expose: true });
  expect(internal.expose).toBe(false);
  expect(internal.toWire().error.message).toBe("Internal server error");

  const upstream = new UpstreamError("anthropic key sk-ant-123 rejected", { expose: true });
  expect(upstream.expose).toBe(false);
  expect(upstream.toWire().error.message).toBe("Upstream service error");
});

test("Phase 3 promoted codes preserve the pre-migration HTTP status via their type", () => {
  expect(new NotFoundError("x", { code: "instance_not_found" }).status).toBe(404);
  expect(new NotFoundError("x", { code: "client_not_found" }).status).toBe(404);
  expect(new NotFoundError("x", { code: "user_not_found" }).status).toBe(404);
  expect(new NotFoundError("x", { code: "snapshot_expired" }).status).toBe(404); // was 410
  expect(new ConflictError("x", { code: "slug_reserved" }).status).toBe(409);
  expect(new ConflictError("x", { code: "api_key_limit" }).status).toBe(409);
  expect(new RateLimitedError("x", { code: "limit_exceeded" }).status).toBe(429);
  expect(new ServiceUnavailableError("x", { code: "embed_unavailable" }).status).toBe(503);
  expect(new ValidationError("x", { code: "payload_too_large" }).status).toBe(400); // was 413

  // The wire code round-trips unchanged (open discriminant).
  expect(new NotFoundError("x", { code: "instance_not_found" }).toWire().error.code).toBe(
    "instance_not_found",
  );
  for (const code of [
    "instance_not_found",
    "client_not_found",
    "user_not_found",
    "snapshot_expired",
    "slug_reserved",
    "api_key_limit",
    "limit_exceeded",
    "embed_unavailable",
    "payload_too_large",
  ] as const) {
    expect(ERROR_CODES).toContain(code);
  }
});
