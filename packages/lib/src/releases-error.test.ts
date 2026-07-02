import { expect, test } from "bun:test";
import { ERROR_CODES } from "@buildinternet/releases-core/errors";
import { errorEnvelopeSchema, decodeApiError } from "@buildinternet/releases-api-types";
import {
  ReleasesError,
  isReleasesError,
  NotFoundError,
  InternalError,
  RateLimitedError,
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
