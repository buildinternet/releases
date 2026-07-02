import { expect, test } from "bun:test";
import { ERROR_TYPES, STATUS_BY_TYPE, statusForType, ERROR_CODES } from "./errors";

test("every ErrorType has a numeric status", () => {
  for (const t of ERROR_TYPES) {
    expect(typeof STATUS_BY_TYPE[t]).toBe("number");
  }
});

test("statusForType maps each category to its status class", () => {
  expect(statusForType("validation")).toBe(400);
  expect(statusForType("unauthorized")).toBe(401);
  expect(statusForType("forbidden")).toBe(403);
  expect(statusForType("insufficient_scope")).toBe(403);
  expect(statusForType("not_found")).toBe(404);
  expect(statusForType("conflict")).toBe(409);
  expect(statusForType("rate_limited")).toBe(429);
  expect(statusForType("upstream")).toBe(502);
  expect(statusForType("unavailable")).toBe(503);
  expect(statusForType("internal")).toBe(500);
});

test("there are exactly 10 error types", () => {
  expect(ERROR_TYPES.length).toBe(10);
});

test("error codes are unique", () => {
  expect(new Set(ERROR_CODES).size).toBe(ERROR_CODES.length);
});
