import { describe, expect, test } from "bun:test";
import { handleGetSlice, handleQueryJson, MAX_TOOL_RESULT_CHARS } from "./tool-handlers.js";

describe("handleGetSlice", () => {
  test("returns the exact slice for in-bounds args", () => {
    const body = "abcdefghij";
    expect(handleGetSlice(body, { start: 2, length: 4 })).toBe("cdef");
  });

  test("clamps negative start to 0", () => {
    expect(handleGetSlice("abcdef", { start: -5, length: 3 })).toBe("abc");
  });

  test("clamps length that overruns the body", () => {
    expect(handleGetSlice("abcdef", { start: 4, length: 1000 })).toBe("ef");
  });

  test("caps output at MAX_TOOL_RESULT_CHARS", () => {
    const body = "x".repeat(50_000);
    const out = handleGetSlice(body, { start: 0, length: 50_000 });
    expect(out.length).toBe(MAX_TOOL_RESULT_CHARS);
  });

  test("returns empty string when start is past end", () => {
    expect(handleGetSlice("abc", { start: 100, length: 10 })).toBe("");
  });
});

describe("handleQueryJson", () => {
  const body = JSON.stringify({
    result: {
      data: {
        nodes: [
          { id: 1, title: "a" },
          { id: 2, title: "b" },
          { id: 3, title: "c" },
        ],
      },
    },
  });

  test("returns matched subtree for a valid JSONPath", () => {
    const out = handleQueryJson(body, { path: "$.result.data.nodes[0]" });
    expect(JSON.parse(out)).toEqual({ id: 1, title: "a" });
  });

  test("returns array for wildcard paths", () => {
    const out = handleQueryJson(body, { path: "$.result.data.nodes[*]" });
    const parsed = JSON.parse(out);
    expect(Array.isArray(parsed)).toBe(true);
    expect(parsed).toHaveLength(3);
  });

  test("returns empty-match marker for a miss", () => {
    const out = handleQueryJson(body, { path: "$.nonexistent.path" });
    expect(out).toMatch(/no matches/i);
  });

  test("truncates oversized match sets and reports remainder", () => {
    // Build a body where the match set is very large
    const large = JSON.stringify({
      arr: Array.from({ length: 5000 }, () => ({ x: "y".repeat(20) })),
    });
    const out = handleQueryJson(large, { path: "$.arr[*]" });
    expect(out.length).toBeLessThanOrEqual(MAX_TOOL_RESULT_CHARS);
    expect(out).toMatch(/\.\.\. \d+ more items elided/);
  });

  test("throws or returns error marker for malformed path", () => {
    // handler should not crash the loop — it either returns a structured error marker
    // or throws; consuming code expects throws to trigger fallback.
    expect(() => handleQueryJson(body, { path: "??invalid??" })).toThrow();
  });

  test("throws 'body is not valid JSON' when the body can't be parsed", () => {
    expect(() => handleQueryJson("not json {", { path: "$.foo" })).toThrow(
      "body is not valid JSON",
    );
  });
});
