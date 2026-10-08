import { describe, it, expect } from "bun:test";
import { countTokens, countTokensSafe, estimateTokens } from "@buildinternet/releases-core/tokens";

describe("countTokens", () => {
  it("returns 0 for the empty string", () => {
    expect(countTokens("")).toBe(0);
  });

  it("encodes short markdown to a plausible token count", () => {
    const text = "# Hello\n\nThis is a short paragraph.";
    const n = countTokens(text);
    // ~10–12 tokens on cl100k; give the assertion headroom for encoder changes.
    expect(n).toBeGreaterThan(5);
    expect(n).toBeLessThan(30);
  });

  it("is deterministic across calls", () => {
    const text = "## v1.0.0\n- first\n- second\n- third\n";
    expect(countTokens(text)).toBe(countTokens(text));
  });
});

describe("countTokensSafe", () => {
  it("matches countTokens for small inputs", () => {
    const text = "# CHANGELOG\n\n## v1\n- alpha\n- beta\n";
    expect(countTokensSafe(text)).toBe(countTokens(text));
  });

  it("returns 0 for the empty string", () => {
    expect(countTokensSafe("")).toBe(0);
  });

  it("falls back to the heuristic at and above the 256KB cap", () => {
    // Pathological repeating-char input — without the cap the encoder
    // hangs for minutes. Matching the heuristic exactly proves we took
    // the fast path.
    const body = "x".repeat(256 * 1024);
    expect(countTokensSafe(body)).toBe(estimateTokens(body));
  });
});

describe("estimateTokens", () => {
  it("returns 0 for the empty string", () => {
    expect(estimateTokens("")).toBe(0);
  });

  it("returns ceil(length/4)", () => {
    expect(estimateTokens("a")).toBe(1);
    expect(estimateTokens("abcd")).toBe(1);
    expect(estimateTokens("abcde")).toBe(2);
    expect(estimateTokens("x".repeat(100))).toBe(25);
  });
});
