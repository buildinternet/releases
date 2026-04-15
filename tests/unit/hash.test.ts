import { describe, it, expect } from "bun:test";
import { sha256Hex } from "@releases/core/hash";

describe("sha256Hex", () => {
  it("returns a 64-char hex string", () => {
    const result = sha256Hex("hello");
    expect(result).toMatch(/^[a-f0-9]{64}$/);
  });

  it("returns deterministic results", () => {
    expect(sha256Hex("test")).toBe(sha256Hex("test"));
  });

  it("returns different hashes for different inputs", () => {
    expect(sha256Hex("a")).not.toBe(sha256Hex("b"));
  });

  it("handles empty string", () => {
    const result = sha256Hex("");
    expect(result).toMatch(/^[a-f0-9]{64}$/);
    // Known SHA-256 of empty string
    expect(result).toBe("e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855");
  });
});
