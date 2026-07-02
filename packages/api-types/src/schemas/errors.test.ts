import { expect, test } from "bun:test";
import { ERROR_TYPES } from "@buildinternet/releases-core/errors";
import { errorEnvelopeSchema, decodeApiError, isApiError } from "./errors";

test("a valid envelope parses", () => {
  const ok = errorEnvelopeSchema.safeParse({
    error: { code: "not_found", type: "not_found", message: "Nope" },
  });
  expect(ok.success).toBe(true);
});

test("malformed envelopes reject", () => {
  expect(errorEnvelopeSchema.safeParse({}).success).toBe(false);
  expect(
    errorEnvelopeSchema.safeParse({
      error: { code: 1, type: "not_found", message: "x" },
    }).success,
  ).toBe(false);
});

test("schema type enum matches the core union (anti-drift invariant 2)", () => {
  const options = errorEnvelopeSchema.shape.error.shape.type.options;
  expect([...options].sort()).toEqual([...ERROR_TYPES].sort());
});

test("decodeApiError normalizes an unknown type to internal, preserves unknown code", () => {
  const decoded = decodeApiError({
    error: { code: "brand_new_code", type: "teapot", message: "?" },
  });
  expect(decoded.type).toBe("internal");
  expect(decoded.code).toBe("brand_new_code");
});

test("decodeApiError degrades a malformed body without throwing", () => {
  expect(decodeApiError(null)).toEqual({
    code: "internal_error",
    type: "internal",
    message: "Unknown error",
  });
});

test("decodeApiError carries details through when present", () => {
  const decoded = decodeApiError({
    error: { code: "not_found", type: "not_found", message: "x", details: { id: "src_1" } },
  });
  expect(decoded.details).toEqual({ id: "src_1" });
});

test("isApiError matches shape and optional code", () => {
  const body = { error: { code: "not_found", type: "not_found", message: "x" } };
  expect(isApiError(body)).toBe(true);
  expect(isApiError(body, "not_found")).toBe(true);
  expect(isApiError(body, "conflict")).toBe(false);
  expect(isApiError({ nope: true })).toBe(false);
});
