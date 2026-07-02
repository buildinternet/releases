import { expect, test } from "bun:test";
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
